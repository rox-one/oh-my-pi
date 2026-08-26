import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveScopedModels } from "@oh-my-pi/pi-coding-agent/main";

type ScopeRegistry = Pick<ModelRegistry, "getAvailable" | "getDiscoverableProviders" | "refresh">;

function makeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://proxy.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

/**
 * Registry double for the startup ordering: `before` is what `getAvailable()`
 * serves prior to any refresh (discovery-backed providers are absent), `after`
 * replaces it once `refresh()` runs — mirroring the background discovery
 * populating the catalog.
 */
function fakeRegistry(options: {
	before?: Model<Api>[];
	after?: Model<Api>[];
	discoverable?: string[];
}): ScopeRegistry & { refreshCalls: string[] } {
	let models = options.before ?? [];
	const refreshCalls: string[] = [];
	return {
		refreshCalls,
		getAvailable: () => models,
		getDiscoverableProviders: () => options.discoverable ?? [],
		refresh: async (strategy = "online-if-uncached") => {
			refreshCalls.push(strategy);
			models = options.after ?? models;
		},
	};
}

const gpt = makeModel("cliproxy", "gpt-5.5");
const claudeOnGptProvider = makeModel("cliproxy", "claude-opus-4-8");
const claude = makeModel("cliproxy-claude", "claude-fable-5");

function scopedIds(scoped: ScopedModel[]): string[] {
	return scoped.map(entry => `${entry.model.provider}/${entry.model.id}`);
}

describe("resolveScopedModels", () => {
	it("retries via a discovery refresh when the scope only matches discovery-backed providers", async () => {
		const registry = fakeRegistry({
			before: [],
			after: [gpt, claudeOnGptProvider, claude],
			discoverable: ["cliproxy", "cliproxy-claude"],
		});
		const settings = Settings.isolated({ enabledModels: ["cliproxy/gpt-*", "cliproxy-claude/claude-*"] });

		const scoped = await resolveScopedModels(parseArgs([]), registry, settings);

		expect(registry.refreshCalls).toEqual(["online-if-uncached"]);
		expect(scopedIds(scoped).sort()).toEqual(["cliproxy-claude/claude-fable-5", "cliproxy/gpt-5.5"]);
	});

	it("does not refresh when the scope resolves against the startup catalog", async () => {
		const registry = fakeRegistry({
			before: [gpt, claude],
			discoverable: ["cliproxy"],
		});
		const settings = Settings.isolated({ enabledModels: ["cliproxy/gpt-*"] });

		const scoped = await resolveScopedModels(parseArgs([]), registry, settings);

		expect(registry.refreshCalls).toEqual([]);
		expect(scopedIds(scoped)).toEqual(["cliproxy/gpt-5.5"]);
	});

	it("does not refresh when no discoverable providers exist", async () => {
		const registry = fakeRegistry({ before: [], discoverable: [] });
		const settings = Settings.isolated({ enabledModels: ["cliproxy/gpt-*"] });

		const scoped = await resolveScopedModels(parseArgs([]), registry, settings);

		expect(registry.refreshCalls).toEqual([]);
		expect(scoped).toEqual([]);
	});

	it("refreshes exactly once when the patterns never match", async () => {
		const registry = fakeRegistry({
			before: [],
			after: [claude],
			discoverable: ["cliproxy-claude"],
		});
		const settings = Settings.isolated({ enabledModels: ["typo-provider/nope-*"] });

		const scoped = await resolveScopedModels(parseArgs([]), registry, settings);

		expect(registry.refreshCalls).toEqual(["online-if-uncached"]);
		expect(scoped).toEqual([]);
	});

	it("prefers an explicit --models scope over enabledModels", async () => {
		const registry = fakeRegistry({ before: [gpt, claudeOnGptProvider, claude] });
		const settings = Settings.isolated({ enabledModels: ["cliproxy-claude/claude-*"] });

		const scoped = await resolveScopedModels(parseArgs(["--models", "cliproxy/gpt-*"]), registry, settings);

		expect(scopedIds(scoped)).toEqual(["cliproxy/gpt-5.5"]);
	});

	it("returns an empty scope without touching the registry when nothing is configured", async () => {
		const registry = fakeRegistry({ before: [gpt] });
		const settings = Settings.isolated({});

		const scoped = await resolveScopedModels(parseArgs([]), registry, settings);

		expect(registry.refreshCalls).toEqual([]);
		expect(scoped).toEqual([]);
	});
});
