import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { ApprovalSimilarityDeps } from "@oh-my-pi/pi-coding-agent/tools/approval-similarity";
import {
	isSimilarToApprovedCommand,
	parseApprovalSimilarity,
} from "@oh-my-pi/pi-coding-agent/tools/approval-similarity";
import { addSimilarApproval, clearSessionApprovals } from "@oh-my-pi/pi-coding-agent/tools/session-approvals";

const classifierModel = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!classifierModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");

/** Session store is module-global; every test owns a fresh session id and clears it. */
let sessionId: string;
let testCount = 0;

function onlineSettings(backend = "online", withSmolRole = true): ApprovalSimilarityDeps["settings"] {
	return {
		get(path: string) {
			if (path === "providers.approvalSimilarityModel") return backend;
			return undefined;
		},
		getModelRole(role: string) {
			return withSmolRole && role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function onlineRegistry(available: unknown[] = [classifierModel]): ApprovalSimilarityDeps["registry"] {
	return {
		getAvailable: () => available,
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as never;
}

function makeDeps(overrides: Partial<ApprovalSimilarityDeps> = {}): ApprovalSimilarityDeps {
	return {
		sessionId,
		toolName: "bash",
		subject: "git diff HEAD",
		settings: onlineSettings(),
		registry: onlineRegistry(),
		...overrides,
	};
}

function mockOnlineAnswer(answer: { stopReason: string; text: string }) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: answer.stopReason,
		content: [{ type: "text", text: answer.text }],
	} as never);
}

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	sessionId = `approval-similarity-test-${++testCount}-${Date.now()}`;
});

afterEach(() => {
	clearSessionApprovals(sessionId);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("parseApprovalSimilarity", () => {
	it("returns true for YES output", () => {
		expect(parseApprovalSimilarity("YES")).toBe(true);
		expect(parseApprovalSimilarity("yes")).toBe(true);
		expect(parseApprovalSimilarity("  Yes, same operation  ")).toBe(true);
	});

	it("returns false for NO output", () => {
		expect(parseApprovalSimilarity("NO")).toBe(false);
		expect(parseApprovalSimilarity("no")).toBe(false);
		expect(parseApprovalSimilarity("No, different subcommand.")).toBe(false);
	});

	it("returns undefined for unparseable output", () => {
		expect(parseApprovalSimilarity("maybe")).toBeUndefined();
		expect(parseApprovalSimilarity("")).toBeUndefined();
		expect(parseApprovalSimilarity("The commands differ")).toBeUndefined();
	});
});

describe("isSimilarToApprovedCommand", () => {
	it("returns false without a model call when the session has no similar approvals", async () => {
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "YES" });
		// Another session's approvals must not leak into this session's gate.
		addSimilarApproval(`other-session-${testCount}`, "bash", "git log --oneline");

		expect(await isSimilarToApprovedCommand(makeDeps())).toBe(false);
		expect(await isSimilarToApprovedCommand(makeDeps({ subject: "" }))).toBe(false);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("approves an unchanged repeat of a recorded subject without a model call", async () => {
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "NO" });
		const localComplete = vi.spyOn(tinyModelClient, "complete").mockResolvedValue("NO");
		// Longer than the store's 4096-char retention bound: the recorded copy is
		// truncated, so the repeat only matches if the candidate is bounded the
		// same way before comparison.
		const bulkSubject = `Path: src/generated.ts\nContent:\n${"export const x = 1;\n".repeat(400)}`;
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		addSimilarApproval(sessionId, "write", bulkSubject);

		expect(await isSimilarToApprovedCommand(makeDeps({ subject: "git log --oneline" }))).toBe(true);
		expect(await isSimilarToApprovedCommand(makeDeps({ toolName: "write", subject: bulkSubject }))).toBe(true);
		// A verdict the user already gave costs neither a request nor the wait for one.
		expect(completeSimple).not.toHaveBeenCalled();
		expect(localComplete).not.toHaveBeenCalled();
	});

	it("auto-approves when the online classifier answers YES and carries both sides of the comparison", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "YES" });

		expect(await isSimilarToApprovedCommand(makeDeps())).toBe(true);

		const call = completeSimple.mock.calls[0];
		if (!call) throw new Error("expected a classifier model call");
		const [model, request, options] = call;
		expect(`${model.provider}/${model.id}`).toBe(`${classifierModel.provider}/${classifierModel.id}`);
		const userMessage = request.messages[0];
		if (!userMessage || typeof userMessage.content !== "string") throw new Error("expected a user message");
		expect(userMessage.content).toContain("- git log --oneline");
		expect(userMessage.content).toContain("git diff HEAD");
		// Reasoning-safe budget: the yes/no keyword must land after any thinking preamble (#4355).
		expect(options).toMatchObject({ disableReasoning: true, maxTokens: 1024 });
	});

	it("keeps a multi-line subject's target line inside the per-subject budget and in one list item", async () => {
		// `approvalSubject` records the tool's approval detail text, e.g. write's
		// "Path: …\nContent:\n…". Each approved subject is head-truncated before
		// it reaches the model: the target line must survive, or the classifier
		// judges file writes by their import prologue alone.
		const content = 'import * as fs from "node:fs/promises";\n'.repeat(20);
		addSimilarApproval(sessionId, "write", `Path: src/deep/module/handler.ts\nContent:\n${content}`);
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "NO" });

		expect(
			await isSimilarToApprovedCommand(
				makeDeps({ toolName: "write", subject: "Path: src/other.ts\nContent:\nexport {};" }),
			),
		).toBe(false);

		const call = completeSimple.mock.calls[0];
		if (!call) throw new Error("expected a classifier model call");
		const userMessage = call[1].messages[0];
		if (!userMessage || typeof userMessage.content !== "string") throw new Error("expected a user message");
		expect(userMessage.content).toContain("- Path: src/deep/module/handler.ts");
		// Continuation lines are indented so the entry stays a single list item.
		expect(userMessage.content).toContain("\n  Content:");
		expect(userMessage.content).toContain("Path: src/other.ts");
	});

	it("prompts again when the online classifier answers NO", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		mockOnlineAnswer({ stopReason: "stop", text: "NO" });

		expect(await isSimilarToApprovedCommand(makeDeps())).toBe(false);
	});

	it("fails safe to false on an errored online response", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		mockOnlineAnswer({ stopReason: "error", text: "" });

		expect(await isSimilarToApprovedCommand(makeDeps())).toBe(false);
	});

	it("fails safe to false on unparsable online output", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		mockOnlineAnswer({ stopReason: "stop", text: "maybe, they share a word" });

		expect(await isSimilarToApprovedCommand(makeDeps())).toBe(false);
	});

	it("fails safe to false when the model call throws", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("network down"));

		await expect(isSimilarToApprovedCommand(makeDeps())).resolves.toBe(false);
	});

	it("fails safe to false when no tiny/smol model is available", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "YES" });

		expect(
			await isSimilarToApprovedCommand(
				makeDeps({ settings: onlineSettings("online", false), registry: onlineRegistry([]) }),
			),
		).toBe(false);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("fails safe to false on an invalid backend setting", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const completeSimple = mockOnlineAnswer({ stopReason: "stop", text: "YES" });
		const localComplete = vi.spyOn(tinyModelClient, "complete").mockResolvedValue("YES");

		expect(await isSimilarToApprovedCommand(makeDeps({ settings: onlineSettings("bogus") }))).toBe(false);
		expect(completeSimple).not.toHaveBeenCalled();
		expect(localComplete).not.toHaveBeenCalled();
	});

	it("classifies via the local memory model with the recorded subjects rendered inline", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const settings = Settings.isolated({ "providers.approvalSimilarityModel": "qwen2.5-1.5b" });
		let classifierPrompt = "";
		let maxTokens: number | undefined;
		const localComplete = vi
			.spyOn(tinyModelClient, "complete")
			.mockImplementation(async (_modelKey, promptText, options) => {
				classifierPrompt = promptText;
				maxTokens = options?.maxTokens;
				return "YES";
			});

		expect(await isSimilarToApprovedCommand(makeDeps({ settings, registry: null as never }))).toBe(true);
		expect(classifierPrompt).toContain("- git log --oneline");
		expect(classifierPrompt).toContain("git diff HEAD");
		expect(maxTokens).toBe(16);

		localComplete.mockResolvedValueOnce("NO");
		expect(await isSimilarToApprovedCommand(makeDeps({ settings, registry: null as never }))).toBe(false);
	});

	it("fails safe to false when the local model returns no output", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const settings = Settings.isolated({ "providers.approvalSimilarityModel": "lfm2-1.2b" });
		vi.spyOn(tinyModelClient, "complete").mockResolvedValue(null);

		expect(await isSimilarToApprovedCommand(makeDeps({ settings, registry: null as never }))).toBe(false);
	});

	it("combines the caller's abort signal with the classification timeout", async () => {
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		const caller = new AbortController();
		caller.abort();
		let receivedSignal: AbortSignal | undefined;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _request, options) => {
			receivedSignal = options?.signal;
			throw new Error("aborted");
		});

		expect(await isSimilarToApprovedCommand(makeDeps({ signal: caller.signal }))).toBe(false);
		expect(receivedSignal?.aborted).toBe(true);
	});

	it("gives up at the ceiling when a backend stage never settles and never sees the signal", async () => {
		// Credential resolution runs before the request and takes no signal, so a
		// hung refresh would hold the approval prompt open indefinitely if the
		// ceiling were enforced only through the abort signal.
		vi.useFakeTimers();
		addSimilarApproval(sessionId, "bash", "git log --oneline");
		mockOnlineAnswer({ stopReason: "stop", text: "YES" });
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: () => Promise.withResolvers<string>().promise,
			resolver: () => async () => "test-key",
		} as never;
		let verdict: boolean | undefined;
		void isSimilarToApprovedCommand(makeDeps({ registry })).then(value => {
			verdict = value;
		});

		await drainMicrotasks();
		expect(verdict).toBeUndefined();
		vi.advanceTimersByTime(3_000);
		await drainMicrotasks();

		expect(verdict).toBe(false);
	});
});
