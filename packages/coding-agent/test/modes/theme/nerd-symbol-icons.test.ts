import { describe, expect, it } from "bun:test";
import {
	Theme,
	type ThemeBg,
	type ThemeColor,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Regression contract for issue #3481: the `nerd` symbol preset must not ship
 * the Microsoft Windows brand logo as `icon.context`, nor the magic-wand
 * `nf-md-auto_fix` as `icon.auto`. The intended glyphs are a neutral context
 * window (`nf-cod-window`, U+EB7F) and a refresh loop (`nf-md-autorenew`,
 * U+F006A) — the latter matching the `unicode` preset's `⟲`.
 */
describe("nerd preset icon glyph mapping (issue #3481)", () => {
	const fgColors = {} as Record<ThemeColor, string | number>;
	const bgColors = {} as Record<ThemeBg, string | number>;
	const t = new Theme(fgColors, bgColors, "truecolor", "nerd", {});

	it("icon.context is nf-cod-window, not nf-dev-windows (the OS brand logo)", () => {
		expect(t.icon.context).toBe("\ueb7f");
		expect(t.icon.context).not.toBe("\ue70f");
	});

	it("icon.auto is nf-md-autorenew, not nf-md-auto_fix (the magic wand)", () => {
		expect(t.icon.auto).toBe("\u{f006a}");
		expect(t.icon.auto).not.toBe("\u{f0068}");
	});
});
