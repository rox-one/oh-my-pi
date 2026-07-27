import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../config/settings";
import { initTheme, theme } from "../../modes/theme/theme";
import { AgentRegistry } from "../../registry/agent-registry";
import { spawnedAgentSessionLinkPath } from "../link-path";
import { renderResult } from "../render";
import type { AgentProgress, TaskToolDetails } from "../types";

beforeEach(async () => {
	resetSettingsForTest();
	AgentRegistry.resetGlobalForTests();
	await Settings.init({ inMemory: true, overrides: { "tui.hyperlinks": "always" } });
	await initTheme(false);
});

afterEach(() => {
	resetSettingsForTest();
	AgentRegistry.resetGlobalForTests();
});

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id: "ReviewBot",
		agent: "reviewer",
		agentSource: "bundled",
		status: "pending",
		task: "review",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function renderProgress(progressItem: AgentProgress): string {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 0,
		progress: [progressItem],
	};
	const component = renderResult({ content: [], details }, { expanded: true, isPartial: true }, theme);
	return component.render(120).join("\n");
}

describe("live progress links", () => {
	it("renders missing session files as plain task ids", () => {
		const text = renderProgress(progress({ sessionFile: undefined }));

		expect(text).toContain("ReviewBot");
		expect(text).not.toContain("\x1b]8;");
		expect(text).not.toContain("history://ReviewBot");
	});

	it("links live progress ids to session files when available", () => {
		const sessionFile = path.join("/tmp", "session", "ReviewBot.jsonl");
		const text = renderProgress(progress({ sessionFile }));

		expect(text).toContain("ReviewBot");
		expect(text).toContain("\x1b]8;");
		expect(text).toContain("file:///tmp/session/ReviewBot.jsonl");
		expect(text).not.toContain("history://ReviewBot");
	});
});

describe("spawnedAgentSessionLinkPath", () => {
	it("points async task completion links at the spawned agent transcript", () => {
		const parentSession = path.join("/tmp", "session.jsonl");

		expect(spawnedAgentSessionLinkPath(parentSession, "ReviewBot")).toBe(
			path.join("/tmp", "session", "ReviewBot.jsonl"),
		);
	});

	it("leaves unpersisted parent sessions without a durable transcript link", () => {
		expect(spawnedAgentSessionLinkPath(undefined, "ReviewBot")).toBeUndefined();
		expect(spawnedAgentSessionLinkPath(null, "ReviewBot")).toBeUndefined();
	});
});

describe("moved transcript links", () => {
	it("rebases parked registry refs inside the moved artifact tree", () => {
		const oldRoot = path.join("/tmp", "session");
		const newRoot = path.join("/tmp", "moved-session");
		const registry = AgentRegistry.global();
		registry.register({
			id: "ReviewBot",
			displayName: "ReviewBot",
			kind: "sub",
			session: null,
			sessionFile: path.join(oldRoot, "ReviewBot.jsonl"),
			status: "parked",
		});

		registry.rebaseSessionFiles(oldRoot, newRoot);

		expect(registry.get("ReviewBot")?.sessionFile).toBe(path.join(newRoot, "ReviewBot.jsonl"));
	});
});
