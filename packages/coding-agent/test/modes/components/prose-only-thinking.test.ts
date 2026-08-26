import { describe, expect, it } from "bun:test";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

describe("formatThinkingForDisplay", () => {
	it("should not format if proseOnly is false", () => {
		const text = "Let me rewrite readString:\n```go\nfunc foo() {}\n```";
		expect(formatThinkingForDisplay(text, false)).toBe(text);
	});

	it("preserves fenced code verbatim in raw thinking display", () => {
		const text = "```html\n<!-- -->\n<div></div>\n```";
		expect(formatThinkingForDisplay(text, false)).toBe(text);
	});

	it("should replace fully enclosed code blocks with an ellipsis", () => {
		const text = "Let me rewrite readString:\n```go\nfunc foo() {}\n```\nAnd then test it.";
		expect(formatThinkingForDisplay(text, true)).toBe("Let me rewrite readString:...\nAnd then test it.");
	});

	it("should replace unclosed code blocks with an ellipsis", () => {
		const text =
			"Let me rewrite readString and the dq handling.\n```go\n  func (l *Lexer) readString(pos Pos) (string, error) {\n     l.advance() // opening '\n     var b strings.Builder\n     for {";
		expect(formatThinkingForDisplay(text, true)).toBe("Let me rewrite readString and the dq handling...");
	});

	it("should preserve trailing one- and two-character fence prefixes as prose", () => {
		expect(formatThinkingForDisplay("Writing bla.\n`", true)).toBe("Writing bla.\n`");
		expect(formatThinkingForDisplay("Writing bla.\n``", true)).toBe("Writing bla.\n``");
		expect(formatThinkingForDisplay("Writing bla.\n```", true)).toBe("Writing bla...");
	});

	it("should preserve inline code in prose", () => {
		expect(formatThinkingForDisplay("Use `readString` here", true)).toBe("Use `readString` here");
	});

	it("should handle tilde code blocks", () => {
		const text = "Use tilde:\n~~~\ncode inside\n~~~\nprose after";
		expect(formatThinkingForDisplay(text, true)).toBe("Use tilde:...\nprose after");
	});

	it("should return exactly ascii ellipsis for pure-code blocks while remaining displayable", () => {
		const text = "```js\nconst x = 1;\n```";
		const formatted = formatThinkingForDisplay(text, true);
		expect(formatted).toBe("...");
		expect(hasDisplayableThinking(text, formatted)).toBe(true);
	});

	it("drops empty Codex reasoning comment separators", () => {
		const text =
			"Investigating disappearing buttons issue\n\n<!--  -->\n\nAnalyzing missing LoadCompleteRequest causing deadlock\n\n<!---- --->\n\nPlanning timestamp evaluation";
		expect(formatThinkingForDisplay(text, true)).toBe(
			"Investigating disappearing buttons issue\n\nAnalyzing missing LoadCompleteRequest causing deadlock\n\nPlanning timestamp evaluation",
		);
	});

	it("treats comment-only reasoning separators as non-displayable", () => {
		const formatted = formatThinkingForDisplay("<!--  -->", true);
		expect(formatted).toBe("");
		expect(hasDisplayableThinking("<!--  -->", formatted)).toBe(false);
	});
});
