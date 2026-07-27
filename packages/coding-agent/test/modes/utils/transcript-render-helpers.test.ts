import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	assistantUsageIsBilled,
	buildAsyncResultBlock,
} from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";

const OSC8 = /\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

describe("buildAsyncResultBlock", () => {
	it("links a completed task job id to its transcript file when available", () => {
		Settings.instance.override("tui.hyperlinks", "always");
		const transcriptPath = path.join("/tmp", "Tan-123.jsonl");
		const block = buildAsyncResultBlock({
			role: "custom",
			customType: "async-result",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
			details: {
				jobs: [{ jobId: "bg_1", type: "task", linkPath: transcriptPath }],
			},
		});

		const line = block.render(120).find(rendered => rendered.includes("bg_1")) ?? "";

		expect(line.match(OSC8)?.[1]).toBe(url.pathToFileURL(transcriptPath).href);
		expect(Bun.stripANSI(line)).toContain("Background job completed [task] bg_1");
	});
});
