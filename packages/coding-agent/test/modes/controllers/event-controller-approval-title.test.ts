/**
 * Terminal-title mirror of the wrapper's approval gate
 * (`EventController.#toolWillPromptForApproval`).
 *
 * The wrapper blocks on `uiContext.select` after `tool_execution_start`; the
 * controller mirrors that to set the `attention` title. Session approvals
 * ("… Commands for Session") downgrade `prompt` → allow in the wrapper, so the
 * title must not flip to `attention` for them — while provider safety checks
 * (the computer tool's synthetic event args) still block per call and must
 * keep the `attention` title even for a session-approved tool.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { approveToolForSession, clearSessionApprovals } from "@oh-my-pi/pi-coding-agent/tools/session-approvals";
import type { TerminalTitleState } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";

const SESSION_ID = "approval-title-test-session";

/** Exec-tier tool: resolves `prompt` under `always-ask` without user policies. */
const execTool = { name: "bash", approval: { tier: "exec" } } as unknown as AgentTool;

function createFixture(): InteractiveModeContext {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = {
		isInitialized: true,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		pendingTools,
		chatContainer: new TranscriptContainer(),
		toolOutputExpanded: false,
		session: { isAborting: false },
		viewSession: { getToolByName: () => execTool, hasBuiltInTool: () => false },
		sessionManager: { getSessionId: () => SESSION_ID, getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;
	return ctx;
}

async function startToolCall(ctx: InteractiveModeContext, toolCallId: string, args: unknown) {
	await new EventController(ctx).handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "bash",
		args,
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
}

type TitleStateSpy = Mock<(state: TerminalTitleState) => void>;

function attentionCalls(spy: TitleStateSpy): number {
	return spy.mock.calls.filter(call => call[0] === "attention").length;
}

describe("EventController approval title mirror", () => {
	let titleSpy: TitleStateSpy;
	let ctx: InteractiveModeContext;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		titleSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		settings.override("tools.approvalMode", "always-ask");
		ctx = createFixture();
	});

	afterEach(() => {
		for (const component of ctx.pendingTools.values()) component.seal();
		clearSessionApprovals(SESSION_ID);
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("flips the title to attention for a prompt-policy tool call", async () => {
		await startToolCall(ctx, "tc-1", { command: "ls" });
		expect(attentionCalls(titleSpy)).toBe(1);
	});

	it("keeps the working title once the tool is approved for the session", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-2", { command: "ls" });
		expect(attentionCalls(titleSpy)).toBe(0);
	});

	it("restores attention after session approvals are cleared", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-3", { command: "ls" });
		clearSessionApprovals(SESSION_ID);
		await startToolCall(ctx, "tc-4", { command: "ls" });
		expect(attentionCalls(titleSpy)).toBe(1);
	});

	it("stays attention for pending provider safety checks despite session approval", async () => {
		approveToolForSession(SESSION_ID, "bash");
		await startToolCall(ctx, "tc-5", {
			actions: [{ type: "key", key: "Return" }],
			pendingSafetyChecks: [{ checkId: "c1", prompt: "Confirm" }],
		});
		expect(attentionCalls(titleSpy)).toBe(1);
	});
});
