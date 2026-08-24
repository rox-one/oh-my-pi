import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession } from "./utilities";

// The single sequence the TUI emits for a destructive reset (erase scrollback +
// viewport, repaint from row zero) — see `tui.ts` `#renderFrame`.
const DESTRUCTIVE_RESET = "\x1b[H\x1b[3J\x1b[2J";

/** VirtualTerminal that also records every raw byte the TUI writes. */
class CapturingTerminal extends VirtualTerminal {
	readonly raw: string[] = [];
	override write(data: string): void {
		this.raw.push(data);
		super.write(data);
	}
	countResets(): number {
		const all = this.raw.join("");
		let n = 0;
		for (let i = all.indexOf(DESTRUCTIVE_RESET); i !== -1; i = all.indexOf(DESTRUCTIVE_RESET, i + 1)) n++;
		return n;
	}
}

// Cold launch runs two independent clear-native-history paths: the prepaint
// composer's `start({ clearScrollback })` and, once InteractiveMode is ready,
// `renderInitialMessages({ clearTerminalHistory })`. On conhost the destructive
// reset's ED3-then-ED2 order archives the first welcome frame into scrollback
// instead of discarding it, so a redundant second reset paints the welcome
// header twice (issue #9597). The replay must clear again only when resuming a
// transcript that has to replace the welcome frame; a fresh launch already
// painted its final frame with the first clear.
describe("issue #9597 — cold-launch welcome duplication", () => {
	let settings: Settings;
	let config: ComposerPreferences;

	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "box",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	// `resuming` mirrors `main.ts` `runInteractiveMode`: `false` on a plain `omp`
	// launch, `true` for --continue/--resume/--fork. The replay's
	// `clearTerminalHistory` follows it.
	async function coldLaunch(resuming: boolean): Promise<{ resets: number; welcomeRows: number }> {
		const terminal = new CapturingTerminal(100, 30);
		beginStartupComposer({ preferences: config, terminal, version: "18.0.4", cache: false });
		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"18.0.4",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease!.composer,
		);
		lease!.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		try {
			// First clear (prepaint welcome) flushes as its own frame before the
			// replay, exactly as it does in the app across the setup/init gap.
			await mode.init({ clearInitialTerminalHistory: true });
			await terminal.waitForRender();
			await mode.renderInitialMessages({ preserveExistingChat: true, clearTerminalHistory: resuming });
			await terminal.waitForRender();
			const welcomeRows = terminal
				.getScrollBuffer()
				.map(l => Bun.stripANSI(l))
				.filter(l => l.includes("18.0.4")).length;
			return { resets: terminal.countResets(), welcomeRows };
		} finally {
			mode.stop();
		}
	}

	it("clears native history once on a fresh launch, leaving one welcome header", async () => {
		const { resets, welcomeRows } = await coldLaunch(false);
		// The first clear already owns the final welcome frame; the replay must not
		// clear again, or conhost promotes that frame into scrollback (duplicate).
		expect(resets).toBe(1);
		expect(welcomeRows).toBe(1);
	});

	it("still clears on the replay when resuming a transcript", async () => {
		const { resets, welcomeRows } = await coldLaunch(true);
		// A resumed launch must destructively replace the welcome frame with the
		// transcript, so the gate keeps the second clear here.
		expect(resets).toBe(2);
		expect(welcomeRows).toBe(1);
	});
});
