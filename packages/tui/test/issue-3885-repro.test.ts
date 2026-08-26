import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui";
import {
	resetWarpNarrowStatusGlyphsForTests,
	setWarpNarrowStatusGlyphsActive,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

// Regression test for https://github.com/can1357/oh-my-pi/issues/3885
//
// The editor renders its top border as `topLeft + content + ─-fill + topRight`,
// sizing the fill via `topFillWidth - statusWidth` where `statusWidth` is the
// `EditorTopBorder.width` the status component reports. Warp renders 💾
// (U+1F4BE) at 1 cell while `Bun.stringWidth` reports 2, so a status line that
// contains 💾 leaves the rendered row 1 Warp-cell short and skews the right
// corner. An earlier attempt to fix the underflow by reporting a Warp-adjusted
// width post-hoc emitted a line that exceeded Bun's `visibleWidth`, which the
// TUI's `#prepareLine` (uses the same `visibleWidth`) then truncated — dropping
// the trailing `─` fill *and* the topRight corner.
//
// The current fix lifts the Warp width correction into `visibleWidth` itself
// (TS-only, scoped to a fixed glyph set that the default editor status line
// uses). With the correction active:
// - the status content's `visibleWidth` reports Warp cells, so the editor's
//   `fillWidth` math lands on the right corner under Warp;
// - the rendered top-border row's `visibleWidth` equals the terminal width, so
//   `#prepareLine`'s width comparison no longer triggers truncation.

afterEach(() => {
	resetWarpNarrowStatusGlyphsForTests();
});

const TERMINAL_WIDTH = 80;
const STATUS_CONTENT = "session 💾 cache";

describe("issue #3885: Warp editor top-border width drift", () => {
	it("emits a top border whose Warp width fills the terminal exactly", () => {
		setWarpNarrowStatusGlyphsActive(true);
		const editor = new Editor(defaultEditorTheme);
		const reportedWidth = visibleWidth(STATUS_CONTENT);
		editor.setTopBorder({ content: STATUS_CONTENT, width: reportedWidth });

		const topRow = editor.render(TERMINAL_WIDTH)[0]!;

		// Under the Warp-aware width model the row reports as exactly terminalWidth,
		// so #prepareLine's `visibleWidth(normalized) <= width` check passes.
		expect(visibleWidth(topRow)).toBe(TERMINAL_WIDTH);
	});

	it("keeps the right corner of the top border under Warp", () => {
		setWarpNarrowStatusGlyphsActive(true);
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder({ content: STATUS_CONTENT, width: visibleWidth(STATUS_CONTENT) });

		const topRow = editor.render(TERMINAL_WIDTH)[0]!;
		const plain = Bun.stripANSI(topRow);

		// The default test theme uses `+` as the rounded corner glyph; the row
		// must still end with a corner (one was dropped before the fix when
		// `#prepareLine` truncated the over-Bun-wide row).
		const { topLeft, topRight } = defaultEditorTheme.symbols.boxRound;
		expect(plain.startsWith(topLeft)).toBe(true);
		expect(plain.endsWith(topRight)).toBe(true);
	});

	it("is a no-op when the override is inactive (default)", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder({ content: STATUS_CONTENT, width: visibleWidth(STATUS_CONTENT) });

		const topRow = editor.render(TERMINAL_WIDTH)[0]!;
		// Without the override, 💾 is measured at 2 cells, the row reports as
		// terminalWidth (Bun-wide) — same as before any of this work. The Warp
		// underflow is then a display-only side effect of Warp's narrower glyph.
		expect(visibleWidth(topRow)).toBe(TERMINAL_WIDTH);
	});
});

describe("issue #3885: visibleWidth respects the Warp narrow-glyph override", () => {
	it("is a no-op when the override is inactive", () => {
		expect(visibleWidth("💾")).toBe(2);
		expect(visibleWidth("⬢◕⑂💾◫⟲⏱")).toBe(8);
	});

	it("treats 💾 as 1 cell when the override is active", () => {
		setWarpNarrowStatusGlyphsActive(true);
		expect(visibleWidth("💾")).toBe(1);
		expect(visibleWidth("⬢◕⑂💾◫⟲⏱")).toBe(7);
	});

	it("leaves widths unrelated to the Warp glyph set unchanged", () => {
		setWarpNarrowStatusGlyphsActive(true);
		expect(visibleWidth("hello world")).toBe(11);
		expect(visibleWidth("日本語")).toBe(6);
	});

	it("scales the correction with the occurrence count", () => {
		setWarpNarrowStatusGlyphsActive(true);
		// Bun width = 23 (each 💾 = 2). Warp = 23 − 3 = 20.
		expect(visibleWidth("save 💾 dump 💾 done 💾")).toBe(20);
	});

	it("never returns a negative width", () => {
		setWarpNarrowStatusGlyphsActive(true);
		expect(visibleWidth("")).toBe(0);
	});
});
