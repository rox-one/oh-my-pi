/**
 * Shared transcript presenter tests — the process-agnostic reduction +
 * component production shared by the interactive mode's file-backed viewer
 * and the worker-attach pane client.
 *
 * Non-regression contract (extracted from agent-transcript-viewer.ts):
 * - raw entries are reduced to messages while the model tracks the first
 *   assistant message and every model_change entry;
 * - rebuild/append produce the same component tree the viewer produced;
 * - expansion, reset, and disposal behave like the builder's.
 */
import { beforeAll, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	extractSessionMessages,
	SessionTranscriptPresenter,
	sanitizeErrorLine,
} from "../../../src/modes/presentation/shared-transcript";
import type { SessionMessageEntry } from "../../../src/session/session-entries";

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	// Keys the transcript components read at build time.
	settings.set("display.hideToolActivity", false);
	settings.set("display.showTokenUsage", false);
	settings.set("read.toolResultPreview", true);
	settings.set("terminal.showImages", false);
});

function messageEntry(
	message: AgentMessage,
	overrides: { id?: string; timestamp?: string; parentId?: string | null } = {},
): SessionMessageEntry {
	const id = overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`;
	return {
		type: "message",
		id,
		parentId: overrides.parentId ?? null,
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		message,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string, model = "test/model"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model,
		api: "test",
		provider: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 2,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function rawModelChange(
	model: string,
	role = "default",
): SessionMessageEntry["parentId"] extends never ? never : object {
	// ModelChangeEntry shape (raw entry, NOT a SessionMessageEntry — used via rebuildFromRaw).
	return {
		type: "model_change",
		id: `mc-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		model,
		role,
	} as never;
}

function makePresenter() {
	const renders: number[] = [];
	let renderCount = 0;
	const ui = {} as TUI;
	const presenter = new SessionTranscriptPresenter({
		ui,
		cwd: "/proj",
		requestRender: () => {
			renderCount += 1;
			renders.push(renderCount);
		},
	});
	return { presenter, renders };
}

test("extractSessionMessages keeps only message entries", () => {
	const modelChange = rawModelChange("a/b");
	const entries = [
		modelChange as never,
		messageEntry(userMessage("hi")),
		messageEntry(assistantMessage("yo")),
	] as never as SessionMessageEntry[];
	const messages = extractSessionMessages(entries as never);
	expect(messages).toHaveLength(2);
	for (const entry of messages) expect(entry.type).toBe("message");
});

test("rebuildFromRaw tracks model from first assistant message and model_change entries", () => {
	const { presenter } = makePresenter();
	const first = messageEntry(userMessage("q"));
	const second = messageEntry(assistantMessage("a", "first/model"));
	presenter.rebuildFromRaw([first, second]);
	expect(presenter.model).toBe("first/model");

	// A model_change after the assistant message wins (viewer semantics).
	const change = rawModelChange("changed/model");
	presenter.rebuildFromRaw([first, second, change as never]);
	expect(presenter.model).toBe("changed/model");

	// A later assistant message without model_change keeps the last model.
	presenter.rebuildFromRaw([first, second, messageEntry(assistantMessage("more", undefined as never))]);
	expect(presenter.model).toBe("first/model");
});

test("rebuildFromRaw with no messages leaves the transcript empty", () => {
	const { presenter } = makePresenter();
	presenter.rebuildFromRaw([rawModelChange("x/y") as never]);
	expect(presenter.isEmpty).toBe(true);
	expect(presenter.model).toBe("x/y");
});

test("append adds rendered rows without rebuilding prior ones", () => {
	const { presenter } = makePresenter();
	const first = messageEntry(userMessage("hello"));
	presenter.rebuildFromRaw([first]);
	expect(presenter.isEmpty).toBe(false);
	const before = presenter.container.render(80);
	const second = messageEntry(assistantMessage("world"));
	presenter.appendFromRaw([second]);
	const after = presenter.container.render(80);
	expect(after.length).toBeGreaterThanOrEqual(before.length);
	expect(before.join("\n")).toBe(after.slice(0, before.length).join("\n"));
});

test("reset clears rows and rebuild restarts from scratch", () => {
	const { presenter } = makePresenter();
	presenter.rebuildFromRaw([messageEntry(userMessage("a")), messageEntry(assistantMessage("b"))]);
	expect(presenter.isEmpty).toBe(false);
	presenter.reset();
	expect(presenter.isEmpty).toBe(true);
	presenter.rebuildFromRaw([messageEntry(userMessage("c"))]);
	expect(presenter.isEmpty).toBe(false);
});

test("setModel overrides the tracked model", () => {
	const { presenter } = makePresenter();
	presenter.setModel("wire/model");
	expect(presenter.model).toBe("wire/model");
});

test("setExpanded delegates to the builder without throwing on empty", () => {
	const { presenter } = makePresenter();
	presenter.setExpanded(true);
	presenter.rebuildFromRaw([messageEntry(userMessage("x"))]);
	presenter.setExpanded(false);
	presenter.setExpanded(true);
});

test("dispose is idempotent and clears state", () => {
	const { presenter } = makePresenter();
	presenter.rebuildFromRaw([messageEntry(userMessage("x"))]);
	presenter.dispose();
	presenter.dispose();
	expect(presenter.isEmpty).toBe(true);
});

test("sanitizeErrorLine collapses newlines, shortens paths, truncates", () => {
	const home = homedir();
	const long = `first\nsecond ${home}/Projects/omp-herdr-worker-panes/packages/coding-agent/src/attach/server.ts boom ${"x".repeat(500)}`;
	const line = sanitizeErrorLine(long, 120);
	expect(line).not.toContain("\n");
	expect(line.length).toBeLessThanOrEqual(120);
	expect(line).toContain("…");
	expect(line).not.toContain(`${home}/Projects/omp-herdr-worker-panes`);
});

test("tool-call bearing messages render through the builder without a live tool registry", () => {
	const { presenter } = makePresenter();
	const call = messageEntry({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", args: { path: "src/foo.ts" } }],
		model: "m",
		api: "test",
		provider: "test",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			total: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as never);
	const result = messageEntry({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "line1\nline2" }],
	} as never);
	presenter.rebuildFromRaw([call, result]);
	expect(presenter.isEmpty).toBe(false);
	// Rendered rows contain the tool activity (no crash, bounded output).
	const lines = presenter.container.render(80).join("\n");
	expect(lines.length).toBeGreaterThan(0);
});

test("getTool/isBuiltInTool/getMessageRenderer are optional and unused safely", () => {
	const ui = {} as TUI;
	const presenter = new SessionTranscriptPresenter({
		ui,
		cwd: "/proj",
		hideThinkingBlock: () => true,
		proseOnlyThinking: () => false,
		requestRender: () => {},
	});
	const tool: AgentTool | undefined = undefined;
	void tool;
	presenter.rebuildFromRaw([messageEntry(userMessage("q")), messageEntry(assistantMessage("a"))]);
	expect(presenter.isEmpty).toBe(false);
	const lines = presenter.container.render(80).join("\n");
	expect(lines).toContain("q");
	expect(lines).toContain("a");
});
