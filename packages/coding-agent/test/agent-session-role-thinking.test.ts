import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	resolveProvisionalAutoLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-role-thinking-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
		runtimeApiKeys?: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const runtimeApiKeys = options.runtimeApiKeys ?? {};
		for (const provider in runtimeApiKeys) {
			authStorage.setRuntimeApiKey(provider, runtimeApiKeys[provider]);
		}

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("activates auto thinking when cycling into a role whose value carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:auto`,
			},
		});

		const toSmol = await session.cycleRoleModels(["default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.model.id).toBe(smolModel.id);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		// `medium` is supported on both ladders (4-6 dropped `minimal`), so the
		// selection survives the role switch unclamped.
		session.setThinkingLevel(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("applies slow role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowPlanModel.provider}/${slowPlanModel.id}:high`,
				plan: `${slowPlanModel.provider}/${slowPlanModel.id}:off`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowPlanModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(slowModel, "default", { persist: true });

		expect(sessionSettings.getModelRole("default")).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("clamps max selections down to the ladder ceiling on models without a max tier", async () => {
		// Budget-mode sonnet-4-5 tops out at xhigh; a max request must clamp down.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getAvailableThinkingLevels()).not.toContain("max");
	});

	it("cycles through off and auto before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(agent.state.disableReasoning).toBe(true);
		expect(session.cycleThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(agent.state.disableReasoning).toBe(false);
		const autoReceipt = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change")
			.at(-1);
		expect(autoReceipt).toMatchObject({
			thinkingLevel: resolveProvisionalAutoLevel(model),
			configured: AUTO_THINKING,
		});
		const autoReceiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		session.setThinkingLevel(AUTO_THINKING);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			autoReceiptCount,
		);
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("cycles through max as the final tier on a max-capable model", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		const available = session.getAvailableThinkingLevels();
		expect(available.at(-1)).toBe(Effort.Max);

		session.setThinkingLevel(Effort.XHigh);
		expect(session.cycleThinkingLevel()).toBe(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.Max);
		// max is the last tier: the wheel wraps back to off.
		expect(session.cycleThinkingLevel()).toBe("off");
	});

	it("keeps auto configured while applying the classifier result as the effective level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		await session.prompt("Implement a focused parser fix");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("classifies a user-invoked /skill turn under auto (resolves concrete effort)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		// A /skill:<name> invocation reaches the session as a user-attributed
		// custom message, not a `user` role. It is still a real user turn.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Expanded SKILL.md body: implement the focused parser fix",
			display: true,
			details: { name: "implement", path: "/skills/implement/SKILL.md", args: "the parser" },
			attribution: "user",
		});

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(classifierSpy.mock.calls[0]?.[0]).toContain("implement the focused parser fix");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("does not classify an agent-originated skill custom message under auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);

		// Autoloaded / agent-originated skill injections must stay excluded.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Autoloaded skill body",
			display: false,
			details: { name: "autoload", path: "/skills/autoload/SKILL.md" },
			attribution: "agent",
		});

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps auto active on resume (pending until the next turn reclassifies)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		await session.prompt("Implement a focused parser fix");

		expect(session.isAutoThinking).toBe(true);
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		// Resumes in auto and pending — not frozen to the last resolved level, and
		// not pre-seeded; the next user turn reclassifies.
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps a manual concrete pin (not auto) on resume even when the global default is auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// User pins a concrete level mid-session; it must survive resume as-is and
		// must not be reinterpreted as `auto` just because the global default is auto.
		session.setThinkingLevel(Effort.Low);
		expect(session.isAutoThinking).toBe(false);
		await session.prompt("Pinned concrete turn");
		expect(classifierSpy).not.toHaveBeenCalled();
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("persists a concrete pin that matches the auto-resolved effort so resume stays concrete", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// Auto resolves to medium.
		await session.prompt("Implement a focused parser fix");
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);

		// User then pins the *same* effort: selector changes auto -> medium even though
		// the effort is unchanged, so it must persist as a concrete pin (entry +
		// defaultThinkingLevel), not silently stay `configured: "auto"`.
		session.setThinkingLevel(Effort.Medium, true);
		expect(session.isAutoThinking).toBe(false);
		expect(sessionSettings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("falls back to a concrete auto level when classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		const fallback = resolveProvisionalAutoLevel(model);
		await session.prompt("Investigate a regression");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(fallback);
		expect(session.autoResolvedThinkingLevel()).toBe(fallback);
		expect(session.agent.state.thinkingLevel).toBe(fallback);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			1,
		);
	});

	it("preserves the resolved auto level when a later classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockResolvedValueOnce(Effort.Low)
			.mockRejectedValueOnce(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("Handle a straightforward update");
		const receiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		await session.prompt("Investigate another update");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			receiptCount,
		);
	});

	it("skips classification for synthetic turns", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		session.setThinkingLevel(AUTO_THINKING);
		const provisional = resolveProvisionalAutoLevel(model);
		await session.prompt("Synthetic maintenance turn", { synthetic: true });

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("maps ultrathink prompts to the model's highest supported level, clamped below max", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		// sonnet-4-5 has no max tier, so the ultrathink jump clamps to xhigh.
		const expected = clampAutoThinkingEffort(model, Effort.Max);
		expect(expected).toBe(Effort.XHigh);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(expected);
		expect(session.autoResolvedThinkingLevel()).toBe(expected);
	});

	it("resolves ultrathink to max on max-capable models", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(Effort.Max);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Max);
	});

	it("keeps auto effectively off for non-reasoning models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		expect(session.isAutoThinking).toBe(true);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();

		await session.prompt("Implement a tiny change");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});
	it("does not block turn start on a slow classifier; the late result carries to the next turn", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const provisional = resolveProvisionalAutoLevel(model);
		expect(provisional).toBeDefined();

		// Capture the reasoning effort each provider request actually sees
		// (agent.state.thinkingLevel at streamFn time = what getReasoning()
		// snapshots at dispatch).
		const seenEffort: (Effort | undefined)[] = [];
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, ctx, opts) => {
				seenEffort.push(agent.state.thinkingLevel);
				return mock.stream(m, ctx, opts);
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-slow-classifier.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-slow-classifier.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});

		// Hold the classifier unresolved so it misses the dispatch deadline.
		const slowClassifier1 = Promise.withResolvers<Effort>();
		const classifierSpy = vi
			.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockReturnValue(slowClassifier1.promise);

		// Integration test of the real dispatch-deadline timer: each prompt pays
		// one #AUTO_THINKING_DISPATCH_DEADLINE_MS (Bun.sleep in production, not a
		// test timer) because the deadline races a live, manually-resolved
		// classifier promise inside the turn. Deterministic fake-timer control is
		// impractical across that async race.
		// First turn runs at the provisional effort WITHOUT waiting for the
		// classifier (the dispatch deadline wins the race).
		await session.prompt("Implement a focused parser fix");
		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(seenEffort).toEqual([provisional]);
		expect(session.thinkingLevel).toBe(provisional);

		// The classifier resolves late. It must NOT mutate the already-dispatched
		// turn, but must carry forward to the next turn.
		slowClassifier1.resolve(Effort.Medium);
		// Drain the late-classifier microtask chain while still in turn 1's
		// generation so its result lands in the carried effort before turn 2.
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// Second turn: classifier held again (misses the deadline), so it runs at
		// the carried Medium from the first turn's late result.
		const slowClassifier2 = Promise.withResolvers<Effort>();
		classifierSpy.mockReturnValue(slowClassifier2.promise);
		await session.prompt("Now refactor the tests");
		expect(seenEffort).toEqual([provisional, Effort.Medium]);

		// Settle the held classifier so the hard-timeout .finally clears its timer
		// and drops the session references it captured.
		slowClassifier2.resolve(Effort.Medium);
		// Yield so the hard-timeout .finally clears its timer and drops the
		// session references the held promise captured.
		for (let i = 0; i < 4; i++) await Promise.resolve();
	});
	it("ignores a stale late classifier when a newer turn's classifier resolves first", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const provisional = resolveProvisionalAutoLevel(model);
		expect(provisional).toBeDefined();

		const seenEffort: (Effort | undefined)[] = [];
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, ctx, opts) => {
				seenEffort.push(agent.state.thinkingLevel);
				return mock.stream(m, ctx, opts);
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-stale-classifier.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-stale-classifier.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});

		// Hold every classifier past the deadline; resolve them manually.
		const resolvers: Array<(value: Effort) => void> = [];
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockImplementation(() => {
			const controlled = Promise.withResolvers<Effort>();
			resolvers.push(controlled.resolve);
			return controlled.promise;
		});

		// Two turns, both classifiers still pending.
		// Integration test: each prompt pays one real dispatch deadline.
		await session.prompt("turn one");
		await session.prompt("turn two");
		expect(resolvers).toHaveLength(2);

		// The newer (turn 2) classifier resolves High first, then the older (turn 1)
		// classifier resolves Low. The stale Low must NOT overwrite the carried High.
		resolvers[1](Effort.High);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		resolvers[0](Effort.Low);
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// Turn 3 runs at the carried effort from the newer classifier (High).
		seenEffort.length = 0;
		await session.prompt("turn three");
		expect(seenEffort).toEqual([Effort.High]);

		// Settle the last held classifier so its hard-timer .finally clears.
		resolvers[2]?.(Effort.High);
		for (let i = 0; i < 4; i++) await Promise.resolve();
	});
	it("restores the carried auto-thinking effort when a session switch fails mid-load", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const provisional = resolveProvisionalAutoLevel(model);
		// Seed an effort distinct from provisional so a missing restore (which
		// falls back to provisional) is observable, not silently correct.
		const restored = provisional === Effort.Medium ? Effort.High : Effort.Medium;
		const seenEffort: (Effort | undefined)[] = [];
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, ctx, opts) => {
				seenEffort.push(agent.state.thinkingLevel);
				return mock.stream(m, ctx, opts);
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-switch-rollback.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-switch-rollback.yml"));
		// File-backed session so switchSession has a real session file to reload.
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});

		// Seed the carried effort: a fast classifier wins the race and pins it.
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(restored);
		await session.prompt("seed the carried effort");
		expect(seenEffort).toEqual([restored]);
		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeTruthy();

		// Force the switch's success-path agent.setThinkingLevel to throw once so
		// the catch rollback runs (it must restore the carried effort).
		const setLevelSpy = vi.spyOn(agent, "setThinkingLevel").mockImplementationOnce(() => {
			throw new Error("switch load boom");
		});
		await expect(session.switchSession(sessionFile!)).rejects.toThrow("switch load boom");
		setLevelSpy.mockRestore();

		// After the failed switch, a fresh slow classifier must run at the RESTORED
		// carried effort — not provisional (which is what a missing restore yields).
		// Integration test: the prompt pays one real dispatch deadline.
		const held = Promise.withResolvers<Effort>();
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockReturnValue(held.promise);
		seenEffort.length = 0;
		await session.prompt("after the failed switch");
		expect(seenEffort).toEqual([restored]);

		held.resolve(restored);
		for (let i = 0; i < 4; i++) await Promise.resolve();
	});
});
