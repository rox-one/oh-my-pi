import { describe, expect, it } from "bun:test";
import {
	canonicalizeMessage,
	formatThinkingForDisplay,
	hasDisplayableThinking,
} from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

describe("canonicalizeMessage", () => {
	it("returns empty string for undefined, empty, or whitespace-only", () => {
		expect(canonicalizeMessage(undefined)).toBe("");
		expect(canonicalizeMessage("")).toBe("");
		expect(canonicalizeMessage("   ")).toBe("");
		expect(canonicalizeMessage("\n\n")).toBe("");
	});

	it("returns empty string for dot-only content", () => {
		expect(canonicalizeMessage(".")).toBe("");
		expect(canonicalizeMessage("...")).toBe("");
		expect(canonicalizeMessage(" . ")).toBe("");
		expect(canonicalizeMessage("\n.")).toBe("");
		expect(canonicalizeMessage("…")).toBe("");
	});

	it("returns normal canonical content for actual prose", () => {
		expect(canonicalizeMessage("hello")).toBe("hello");
		expect(canonicalizeMessage("hello.")).toBe("hello.");
		expect(canonicalizeMessage(". hello .")).toBe(". hello .");
		expect(canonicalizeMessage("a")).toBe("a");
	});
});

describe("formatThinkingForDisplay", () => {
	it("removes standalone empty HTML comment separators while preserving prose sections", () => {
		const formatted = formatThinkingForDisplay(
			[
				"I checked the request.",
				"<!-- -->",
				"The implementation path is straightforward.",
				"  <!-- -->  ",
				"I will update the tests first.",
			].join("\n"),
			true,
		);

		expect(formatted).toBe(
			[
				"I checked the request.",
				"",
				"The implementation path is straightforward.",
				"",
				"I will update the tests first.",
			].join("\n"),
		);
	});

	it("keeps non-empty HTML-like prose instead of dropping every angle-bracket line", () => {
		const formatted = formatThinkingForDisplay(
			[
				"These notes mention <thinking> as prose.",
				"<!-- keep this explanation visible -->",
				"Continue with the observable contract.",
			].join("\n"),
			true,
		);

		expect(formatted).toBe(
			[
				"These notes mention <thinking> as prose.",
				"<!-- keep this explanation visible -->",
				"Continue with the observable contract.",
			].join("\n"),
		);
	});
});

describe("hasDisplayableThinking", () => {
	it("treats comment-only separators as non-displayable after prose-only formatting", () => {
		const rawThinking = ["  <!-- -->  ", "", "\t", "<!-- -->"].join("\n");
		const formatted = formatThinkingForDisplay(rawThinking, true);

		expect(hasDisplayableThinking(rawThinking, formatted)).toBe(false);
	});
});
