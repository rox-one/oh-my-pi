/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled extension providers (by ID). Controls capability-registry loading only. */
const disabledExtensionProviders = new Set<string>();

/** Settings manager for persistence (if set) */
let settings: Settings | null = null;

// =============================================================================
// Registration API
// =============================================================================

/**
 * Define a new capability.
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// Loading API
// =============================================================================

/**
 * Async loading logic shared by loadCapability().
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions<T>,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const suppressedItems = new Set<T & { _source: SourceMeta; _shadowed?: boolean }>();
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const disabledExtensionIds = options.includeDisabled
		? new Set<string>()
		: new Set<string>(options.disabledExtensions ?? settings?.get("disabledExtensions") ?? []);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			if (extensionId && disabledExtensionIds.has(extensionId)) {
				continue;
			}

			if (options.filter && !options.filter(itemWithSource)) {
				continue;
			}

			if (options.suppress?.(itemWithSource)) {
				// Suppressed items still claim their dedupe key below, so a
				// suppressed higher-priority item shadows same-key lower-priority
				// ones, but they never survive or equivalence-shadow survivors.
				itemWithSource._source.providerName = provider.displayName;
				const suppressed = itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean };
				suppressedItems.add(suppressed);
				allItems.push(suppressed);
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key or semantic equivalence (first wins = highest priority)
	const seen = new Set<string>();
	const deduped: Array<T & { _source: SourceMeta }> = [];
	const equivalent = capability.equivalent;

	for (const item of allItems) {
		const key = capability.key(item);

		if (suppressedItems.has(item)) {
			// Claim key ownership (same-name precedence, including disabled
			// state) without surviving or equivalence-shadowing survivors.
			if (key !== undefined) seen.add(key);
			continue;
		}

		if (key === undefined) {
			deduped.push(item);
			continue;
		}

		const keySeen = seen.has(key);
		seen.add(key);
		const aliasSeen = !keySeen && equivalent !== undefined && deduped.some(existing => equivalent(existing, item));
		if (keySeen || aliasSeen) {
			item._shadowed = true;
		} else {
			deduped.push(item);
		}
	}

	// Validate items (only non-shadowed items)
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: suppressedItems.size > 0 ? allItems.filter(item => !suppressedItems.has(item)) : allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function syncDisabledExtensionProvidersFromSettings(cwd?: string): void {
	if (!settings) return;
	disabledExtensionProviders.clear();
	for (const id of settings.disabledExtensionProvidersForCwd(cwd)) {
		disabledExtensionProviders.add(id);
	}
}

function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
	syncDisabledExtensionProvidersFromSettings(options.cwd);
	let providers = (capability.providers as Provider<T>[]).filter(p => !disabledExtensionProviders.has(p.id));

	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter(p => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function loadCapability<T>(
	capabilityId: string,
	options: LoadOptions<T> = {},
): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = options.agentDir
		? { cwd, home, repoRoot, agentDir: options.agentDir }
		: { cwd, home, repoRoot };
	const providers = filterProviders(capability, options);

	return await loadImpl(capability, providers, ctx, options);
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 *
 * Reads the extension-provider disable list from `disabledExtensionProviders`
 * (added in this change to decouple the `/extensions` provider toggle from the
 * model/login `disabledProviders` list). For legacy configs where only the
 * older `disabledProviders` key is set, its value is copied into the new list
 * so users who set `disabledProviders: [cursor]` intending "hide all cursor
 * stuff" keep the joint behavior; toggles from the `/extensions` UI then only
 * mutate the new key.
 */
export function initializeWithSettings(activeSettings: Settings): void {
	settings = activeSettings;
	// Legacy read-through: fall back to `disabledProviders` ONLY when the new
	// key has never been configured. An explicitly-empty configured value is a
	// deliberate "extension list is empty" signal (e.g. the user re-enabled
	// the last provider from `/extensions`) and must NOT roll back to the
	// model-side list on the next boot.
	syncDisabledExtensionProvidersFromSettings();
}

/**
 * Persist current disabled extension providers to settings.
 */
function persistDisabledExtensionProviders(cwd?: string): void {
	if (settings) {
		settings.setDisabledExtensionProviders(Array.from(disabledExtensionProviders), cwd);
	}
}

/**
 * Disable an extension provider (hides its capability contributions from
 * `/extensions` and everywhere `loadCapability` runs). Does not affect model
 * discovery or `/login`; those honor the separate `disabledProviders` list.
 *
 * `cwd` selects the workspace whose path-scoped `disabledExtensionProviders`
 * rules are read and written; omit it for the active session scope. Toggles for
 * a different workspace (ACP `_omp/extensions/toggle`) MUST pass the target cwd
 * so the sync and the persisted edit both land in that project.
 */
export function disableProvider(providerId: string, cwd?: string): void {
	syncDisabledExtensionProvidersFromSettings(cwd);
	disabledExtensionProviders.add(providerId);
	persistDisabledExtensionProviders(cwd);
}

/**
 * Re-enable a previously disabled extension provider, resolved against `cwd`
 * (defaults to the active session scope).
 */
export function enableProvider(providerId: string, cwd?: string): void {
	syncDisabledExtensionProvidersFromSettings(cwd);
	disabledExtensionProviders.delete(providerId);
	persistDisabledExtensionProviders(cwd);
}

/**
 * Check if an extension provider is enabled (capability-registry scope).
 *
 * `cwd` selects the workspace whose path-scoped `disabledExtensionProviders`
 * rules apply; omit it for the active session scope. Display paths that load a
 * different workspace (`loadAllExtensions`, ACP `_omp/extensions`) MUST pass the
 * loaded cwd so labels match the target project, not the live singleton.
 */
export function isProviderEnabled(providerId: string, cwd?: string): boolean {
	syncDisabledExtensionProvidersFromSettings(cwd);
	return !disabledExtensionProviders.has(providerId);
}

/**
 * Get list of all disabled extension provider IDs, resolved against `cwd`
 * (defaults to the active session scope).
 */
export function getDisabledProviders(cwd?: string): string[] {
	syncDisabledExtensionProvidersFromSettings(cwd);
	return Array.from(disabledExtensionProviders);
}

/**
 * Set disabled extension providers from a list (replaces current set).
 */
export function setDisabledProviders(providerIds: string[]): void {
	disabledExtensionProviders.clear();
	for (const id of providerIds) {
		disabledExtensionProviders.add(id);
	}
	persistDisabledExtensionProviders();
}

/** Reset provider disable state for tests that tear down the Settings singleton. */
export function resetProviderStateForTests(): void {
	settings = null;
	disabledExtensionProviders.clear();
}

// =============================================================================
// Introspection API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display, resolved against `cwd` (defaults to the
 * active session scope).
 */
export function getCapabilityInfo(capabilityId: string, cwd?: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;
	syncDisabledExtensionProvidersFromSettings(cwd);

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabledExtensionProviders.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display, resolved against `cwd`.
 */
export function getAllCapabilitiesInfo(cwd?: string): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id, cwd)!);
}

/**
 * Get provider info for UI display, resolved against `cwd` (defaults to the
 * active session scope).
 */
export function getProviderInfo(providerId: string, cwd?: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;
	syncDisabledExtensionProvidersFromSettings(cwd);

	// Find priority from first capability's provider list
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: !disabledExtensionProviders.has(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities),
 * resolved against `cwd`.
 */
export function getAllProvidersInfo(cwd?: string): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId, cwd);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 */
export function reset(): void {
	clearFsCache();
}

/**
 * Invalidate cache for a specific path.
 * @param filePath - Absolute or relative path to invalidate
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// Re-exports
// =============================================================================

export type * from "./types";
