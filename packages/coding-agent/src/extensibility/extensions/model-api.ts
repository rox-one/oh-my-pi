/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, and compare model families — without touching the mutable registry or
 * duplicating resolution/family heuristics.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { ExtensionModelAlias, ExtensionModelAliasResult, ExtensionModelQuery } from "./types";

function resolveAlias(
	role: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	currentModel: Model<Api> | undefined,
	availableModels: Model<Api>[],
	allModels: Model<Api>[],
): ExtensionModelAlias {
	const matchPreferences = getModelMatchPreferences(settings);
	const defaultFallback =
		role === "default" && !settings.getModelRole("default") && currentModel
			? { model: currentModel, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined }
			: undefined;
	const available =
		defaultFallback ??
		resolveModelRoleValue(`@${role}`, availableModels, {
			settings,
			matchPreferences,
		});
	const catalog = available.model
		? available
		: resolveModelRoleValue(`@${role}`, allModels, {
				settings,
				matchPreferences,
			});
	const explicitlyAvailable = catalog.model !== undefined && modelRegistry.hasConfiguredAuth(catalog.model);
	const status = available.model || explicitlyAvailable ? "resolved" : catalog.model ? "unavailable" : "unresolved";
	const selector = settings.getModelRole(role);

	return {
		name: role,
		...(selector ? { selector } : {}),
		...(catalog.model ? { model: catalog.model } : {}),
		...(catalog.thinkingLevel !== undefined ? { thinkingLevel: catalog.thinkingLevel } : {}),
		explicitThinkingLevel: catalog.explicitThinkingLevel,
		status,
		...(catalog.warning ? { warning: catalog.warning } : {}),
	};
}

export async function setExtensionModelAlias(
	name: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
	currentModel: Model<Api> | undefined,
	setModelTemporary: (
		model: Model,
		thinkingLevel?: ExtensionModelAlias["thinkingLevel"],
		options?: { ephemeral?: boolean },
	) => Promise<void>,
): Promise<ExtensionModelAliasResult> {
	const aliases = createExtensionModelAliases(modelRegistry, settings, currentModel);
	const alias = aliases.find(candidate => candidate.name === name);
	if (!alias) return { ok: false, alias: name, reason: "unknown_alias" };
	if (alias.status !== "resolved" || !alias.model) {
		return {
			ok: false,
			alias: name,
			reason: alias.status === "unavailable" ? "unavailable_alias" : "unresolved_alias",
		};
	}

	await setModelTemporary(alias.model, alias.thinkingLevel);
	return { ok: true, alias, scope: "session" };
}
function createExtensionModelAliases(
	modelRegistry: ModelRegistry,
	settings: Settings,
	currentModel: Model<Api> | undefined,
): ExtensionModelAlias[] {
	const availableModels = modelRegistry.getAvailable();
	const allModels = modelRegistry.getAll();
	return getKnownRoleIds(settings).map(role =>
		resolveAlias(role, settings, modelRegistry, currentModel, availableModels, allModels),
	);
}

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),
		listAliases: (): ExtensionModelAlias[] =>
			settings ? createExtensionModelAliases(modelRegistry, settings, getModel()) : [],
		// resolveModelRoleValue expands a role alias (`@slow`) to its full configured
		// priority list and tries each pattern — the same path core selection uses — so a
		// fallback model lower in the list still resolves. Plain model strings pass through
		// as a single pattern.
		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model,
		family: (model: Model<Api>): string => modelFamilyToken(model.id) || model.provider.toLowerCase(),
	};
}
