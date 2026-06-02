import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { terminalResetsViewportOnEraseScrollback } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1682
//
// POSIX counterpart of #1635. WezTerm, kitty, ghostty, and alacritty do not
// scroll on program output; the only sequence that forcibly resets the visible
// viewport is ED3 (`\x1b[3J`), which they honor per ECMA-48 by resetting to the
// top of the (now-erased) scrollback. The 15.7.3 POSIX deferral keeps offscreen
// edits non-destructive when `isNativeViewportAtBottom()` is `undefined`, but
// the coding-agent EventController enables
// `setEagerNativeScrollbackRebuild(true)` for every streaming event. `#doRender`
// ORs that flag into `allowUnknownViewportMutation`, so the deferral is
// bypassed and offscreen structural mutations during streaming route to
// `historyRebuild` → `\x1b[2J\x1b[H\x1b[3J` → viewport yank.
//
// Fix: the eager flag no longer overrides the unknown-viewport deferral on
// POSIX hosts that reset on ED3. The destructive rebuild is held until the
// next checkpoint (`refreshNativeScrollbackIfDirty` on prompt submit, where the
// user's keystroke has pinned the terminal back to the bottom). The
// autocomplete/IME opt-in (`#allowUnknownViewportMutationOnNextRender`) is
// unaffected because the user is actively typing into the prompt.

class LineList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(l => l.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(r => process.nextTick(r));
	await new Promise<void>(r => setTimeout(r, 20));
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

// Env keys the renderer's terminal-id probe consults. We clear all of them in
// `beforeEach` so the control test has a clean baseline, and set the WezTerm
// pane id in the WezTerm-flavored tests.
const TERMINAL_ID_ENV_KEYS = [
	"WEZTERM_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"ALACRITTY_WINDOW_ID",
	"ITERM_SESSION_ID",
	"VSCODE_PID",
	"TERM_PROGRAM",
] as const;

describe("issue #1682: terminalResetsViewportOnEraseScrollback", () => {
	it("returns true for WezTerm/kitty/ghostty/alacritty on POSIX (env-id)", () => {
		expect(terminalResetsViewportOnEraseScrollback({ WEZTERM_PANE: "0" }, "linux")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ KITTY_WINDOW_ID: "1" }, "linux")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ GHOSTTY_RESOURCES_DIR: "/x" }, "darwin")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ ALACRITTY_WINDOW_ID: "abc" }, "linux")).toBe(true);
	});

	it("returns true when TERM_PROGRAM names one of them", () => {
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "WezTerm" }, "darwin")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "kitty" }, "linux")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "ghostty" }, "linux")).toBe(true);
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "alacritty" }, "linux")).toBe(true);
	});

	it("returns false on POSIX for unflagged terminals", () => {
		expect(terminalResetsViewportOnEraseScrollback({}, "linux")).toBe(false);
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toBe(false);
	});

	it("returns false on win32 regardless of env (those four are not the WT/ConPTY case)", () => {
		expect(terminalResetsViewportOnEraseScrollback({ WEZTERM_PANE: "0" }, "win32")).toBe(false);
		expect(terminalResetsViewportOnEraseScrollback({ TERM_PROGRAM: "kitty" }, "win32")).toBe(false);
	});
});

describe("issue #1682: eager scrollback rebuild must defer on POSIX ED3-resetting terminals", () => {
	let originalPlatform: NodeJS.Platform;
	const originalEnv = new Map<(typeof TERMINAL_ID_ENV_KEYS)[number], string | undefined>();

	beforeEach(() => {
		originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		originalEnv.clear();
		for (const key of TERMINAL_ID_ENV_KEYS) {
			originalEnv.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		for (const key of TERMINAL_ID_ENV_KEYS) {
			const prev = originalEnv.get(key);
			if (prev === undefined) delete Bun.env[key];
			else Bun.env[key] = prev;
		}
	});

	it("WezTerm POSIX: offscreen structural mutation during eager rebuild emits no \\x1b[3J", async () => {
		Bun.env.WEZTERM_PANE = "0";
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const list = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			tui.setEagerNativeScrollbackRebuild(true);
			list.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
			tui.requestRender();
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("kitty POSIX: same deferral applies", async () => {
		Bun.env.KITTY_WINDOW_ID = "1";
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const list = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			tui.setEagerNativeScrollbackRebuild(true);
			list.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
			tui.requestRender();
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("control: unflagged POSIX terminal keeps the eager rebuild (still emits \\x1b[3J)", async () => {
		// Ensures the fix is scoped: terminals that don't reset on ED3 still
		// benefit from the eager rebuild's clean, duplicate-free history.
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const list = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			tui.setEagerNativeScrollbackRebuild(true);
			list.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
			tui.requestRender();
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).not.toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("autocomplete/IME opt-in stays user-driven on WezTerm (still rebuilds)", async () => {
		// `allowUnknownViewportMutationOnNextRender` is set by autocomplete and
		// IME paths where the user is actively typing — the keystroke has
		// pinned the terminal to the bottom, so a rebuild is safe. The fix
		// must not regress that opt-in.
		Bun.env.WEZTERM_PANE = "0";
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const list = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			list.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
			tui.requestRender(false, { allowUnknownViewportMutation: true });
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).not.toBeNull();
		} finally {
			tui.stop();
		}
	});
});
