import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	StatusLineSegmentContext,
	StatusLineSegmentResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const context: StatusLineSegmentContext = {
	width: 80,
	usage: {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: 0,
		tokensPerSecond: null,
	},
	contextPercent: null,
	contextTokens: 0,
	contextWindow: 0,
	git: null,
	activeMs: 0,
};

function renderWithExtensions(
	text: string,
	renderers: Array<(next: () => StatusLineSegmentResult) => StatusLineSegmentResult>,
): StatusLineSegmentResult {
	const runner = {
		extensions: renderers.map((renderer, index) => ({
			path: `extension-${index}`,
			statusLineSegments: new Map([
				["mode", (_context: StatusLineSegmentContext, next: () => StatusLineSegmentResult) => renderer(next)],
			]),
		})),
	} as unknown as ExtensionRunner;
	return ExtensionRunner.prototype.renderStatusLineSegment.call(
		runner,
		"mode",
		context,
		undefined as unknown as Theme,
		() => ({ content: text, visible: true }),
	);
}

describe("ExtensionRunner status-line segment middleware", () => {
	it("wraps the built-in result with later-loaded extensions outermost", () => {
		const result = renderWithExtensions("built-in", [
			next => {
				const result = next();
				return { ...result, content: `first(${result.content})` };
			},
			next => {
				const result = next();
				return { ...result, content: `second(${result.content})` };
			},
		]);

		expect(result).toEqual({ content: "second(first(built-in))", visible: true });
	});

	it("falls through a throwing wrapper without rendering the base twice", () => {
		let baseCalls = 0;
		const runner = {
			extensions: [
				{
					path: "broken-extension",
					statusLineSegments: new Map([
						[
							"mode",
							() => {
								throw new Error("broken renderer");
							},
						],
					]),
				},
			],
		} as unknown as ExtensionRunner;

		const result = ExtensionRunner.prototype.renderStatusLineSegment.call(
			runner,
			"mode",
			context,
			undefined as unknown as Theme,
			() => {
				baseCalls++;
				return { content: "built-in", visible: true };
			},
		);

		expect(result).toEqual({ content: "built-in", visible: true });
		expect(baseCalls).toBe(1);
	});

	it("neutralizes control characters in extension content while preserving ANSI SGR styling", () => {
		const result = renderWithExtensions("built-in", [
			_next => ({
				content: "line1\nline2\tindented\x1b[31mred\x1b[39m",
				visible: true,
			}),
		]);

		expect(result.content).toBe("line1 line2 indented\x1b[31mred\x1b[39m");
		expect(result.visible).toBe(true);
	});
});
