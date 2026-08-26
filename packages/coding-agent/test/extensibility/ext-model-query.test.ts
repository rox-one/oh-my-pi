import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery, setExtensionModelAlias } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");

const available = [claude, gpt] as Model<Api>[];

/** Minimal registry stub: only the methods the facade and core resolver touch. */
function registry(): ModelRegistry {
	return {
		getAvailable: () => available,
		getAll: () => available,
		hasConfiguredAuth: (candidate: Model<Api>) => available.includes(candidate),
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("list() and current() pass through to the registry and session model", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => gpt);
		expect(q.list()).toEqual(available);
		expect(q.current()).toBe(gpt);
	});

	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = {
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8" : undefined),
		} as unknown as Settings;
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("@slow")).toBe(claude);
	});

	test("listAliases() exposes effective built-in and custom role resolution", () => {
		const unavailable = model("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic");
		const settings = {
			get: (path: string) => {
				if (path === "cycleOrder") return ["smol", "default", "slow"];
				if (path === "modelTags") return {};
				return undefined;
			},
			getModelRole: (role: string) =>
				({
					slow: "anthropic/claude-opus-4-8:high",
					unavailable: "anthropic/claude-haiku-4-5",
					missing: "anthropic/not-in-catalog",
				})[role],
			getModelRoles: () => ({
				slow: "anthropic/claude-opus-4-8:high",
				unavailable: "anthropic/claude-haiku-4-5",
				missing: "anthropic/not-in-catalog",
			}),
		} as unknown as Settings;
		const q = createExtensionModelQuery(
			{
				getAvailable: () => available,
				getAll: () => [...available, unavailable],
				hasConfiguredAuth: (candidate: Model<Api>) => available.includes(candidate),
			} as unknown as ModelRegistry,
			settings,
			() => claude,
		);

		const aliases = q.listAliases();
		expect(aliases.find(alias => alias.name === "slow")).toMatchObject({
			status: "resolved",
			model: claude,
			explicitThinkingLevel: true,
		});
		expect(aliases.find(alias => alias.name === "unavailable")).toMatchObject({
			status: "unavailable",
			model: unavailable,
		});
		expect(aliases.find(alias => alias.name === "missing")).toMatchObject({
			status: "unresolved",
		});
		expect(aliases.find(alias => alias.name === "missing")).not.toHaveProperty("model");
	});
	test("listAliases() falls back to the active model for an unconfigured default role", () => {
		const settings = {
			get: (path: string) => (path === "cycleOrder" ? ["default"] : path === "modelTags" ? {} : undefined),
			getModelRole: () => undefined,
			getModelRoles: () => ({}),
		} as unknown as Settings;
		const q = createExtensionModelQuery(registry(), settings, () => claude);
		expect(q.listAliases().find(alias => alias.name === "default")).toMatchObject({
			status: "resolved",
			model: claude,
		});
	});

	test("listAliases() treats explicitly authenticated catalog models as resolved", () => {
		const settings = {
			get: (path: string) => (path === "cycleOrder" ? ["slow"] : path === "modelTags" ? {} : undefined),
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8" : undefined),
			getModelRoles: () => ({ slow: "anthropic/claude-opus-4-8" }),
		} as unknown as Settings;
		const q = createExtensionModelQuery(
			{
				getAvailable: () => [],
				getAll: () => [claude],
				hasConfiguredAuth: () => true,
			} as unknown as ModelRegistry,
			settings,
			() => undefined,
		);
		expect(q.listAliases().find(alias => alias.name === "slow")).toMatchObject({
			status: "resolved",
			model: claude,
		});
	});
	test("listAliases() checks later authenticated fallback patterns", () => {
		const unavailable = model("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic");
		const explicit = model("grok-4", "Grok 4", "xai-oauth");
		const settings = {
			get: (path: string) => (path === "cycleOrder" ? ["slow"] : path === "modelTags" ? {} : undefined),
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-haiku-4-5, xai-oauth/grok-4" : undefined),
			getModelRoles: () => ({ slow: "anthropic/claude-haiku-4-5, xai-oauth/grok-4" }),
		} as unknown as Settings;
		const q = createExtensionModelQuery(
			{
				getAvailable: () => [],
				getAll: () => [unavailable, explicit],
				hasConfiguredAuth: (candidate: Model<Api>) => candidate === explicit,
			} as unknown as ModelRegistry,
			settings,
			() => undefined,
		);

		expect(q.listAliases().find(alias => alias.name === "slow")).toMatchObject({
			status: "resolved",
			model: explicit,
		});
	});

	test("listAliases() returns no aliases without settings", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.listAliases()).toEqual([]);
	});
	test("setModelAlias() applies a resolved alias to the current session", async () => {
		const settings = {
			get: (path: string) => (path === "cycleOrder" ? ["slow"] : path === "modelTags" ? {} : undefined),
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8:high" : undefined),
			getModelRoles: () => ({ slow: "anthropic/claude-opus-4-8:high" }),
		} as unknown as Settings;
		let switched: { model: Model<Api>; thinkingLevel: unknown; options: unknown } | undefined;
		const result = await setExtensionModelAlias(
			"slow",
			registry(),
			settings,
			undefined,
			async (model, thinkingLevel, options) => {
				switched = { model, thinkingLevel, options };
			},
		);

		expect(result).toMatchObject({ ok: true, scope: "session" });
		expect(switched).toEqual({ model: claude, thinkingLevel: "high", options: undefined });
	});

	test("setModelAlias() refuses unresolved aliases without switching", async () => {
		const settings = {
			get: (path: string) => (path === "cycleOrder" ? ["missing"] : path === "modelTags" ? {} : undefined),
			getModelRole: (role: string) => (role === "missing" ? "anthropic/not-in-catalog" : undefined),
			getModelRoles: () => ({ missing: "anthropic/not-in-catalog" }),
		} as unknown as Settings;
		let switched = false;
		const result = await setExtensionModelAlias("missing", registry(), settings, undefined, async () => {
			switched = true;
		});

		expect(result).toEqual({ ok: false, alias: "missing", reason: "unresolved_alias" });
		expect(switched).toBe(false);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});
});
