import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { StartupComposer, type StartupComposerConfig } from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession } from "./utilities";

class CountingTerminal extends VirtualTerminal {
	starts = 0;
	stops = 0;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.starts += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stops += 1;
		super.stop();
	}
}

describe("StartupComposer", () => {
	let settings: Settings;

	let config: StartupComposerConfig;
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			scrollbackRebuild: settings.get("tui.scrollbackRebuild"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
		};
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps one live editor and terminal across handoff", () => {
		const terminal = new CountingTerminal();
		const composer = new StartupComposer(config, { terminal });
		const submit = vi.fn();
		composer.editor.onSubmit = submit;

		composer.start();
		terminal.sendInput("alpha");
		terminal.sendInput("\r");

		expect(composer.editor.getExpandedText()).toBe("alpha");
		expect(submit).not.toHaveBeenCalled();
		expect(terminal.starts).toBe(1);

		const surface = composer.handoff();
		composer.stop();
		terminal.sendInput(" beta");

		expect(surface.editor).toBe(composer.editor);
		expect(surface.editor.getExpandedText()).toBe("alpha beta");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(0);

		surface.ui.stop();
		expect(terminal.stops).toBe(1);
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const terminal = new CountingTerminal();
		const composer = new StartupComposer(config, { terminal });
		composer.start();
		terminal.sendInput("alpha ");
		terminal.sendInput("\x1b[200~one\ntwo\x1b[201~");
		terminal.sendInput(" omega");
		terminal.sendInput("\x1b[D");

		const expectedDraft = composer.editor.getExpandedText();
		const expectedCursor = composer.editor.getCursor();
		const surface = composer.handoff();
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			await initTheme(false, "ascii");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				surface,
			);
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			expect(mode.ui).toBe(surface.ui);
			expect(mode.editor).toBe(surface.editor);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.ui).toBe(surface.ui);
			expect(mode.editor).toBe(surface.editor);
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			expect(mode.editor.getCursor()).toEqual(expectedCursor);
			expect(terminal.starts).toBe(1);
			const adoptedEditor = Bun.stripANSI(mode.editor.render(40).join("\n"));
			expect(adoptedEditor.startsWith("+")).toBe(true);
			expect(adoptedEditor).not.toContain("╭");

			terminal.sendInput("\x03");
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			terminal.sendInput("\x18");
			expect(mode.editor.getExpandedText()).toBe("");
			const submit = vi.fn();
			const submitted = Promise.withResolvers<void>();
			mode.onInputCallback = input => {
				submit(input);
				submitted.resolve();
			};
			terminal.sendInput("ready");
			terminal.sendInput("\r");
			await submitted.promise;

			expect(submit).toHaveBeenCalledWith(expect.objectContaining({ text: "ready" }));
			expect(mode.editor.getExpandedText()).toBe("");
			expect(terminal.starts).toBe(1);
		} finally {
			mode?.stop();
			await testSession.cleanup();
			vi.restoreAllMocks();
			await initTheme();
		}
	});

	it("restores the terminal before an early double interrupt exits", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		let now = 1_000;
		const composer = new StartupComposer(config, { terminal, exit, now: () => now });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x03");
		expect(composer.editor.getExpandedText()).toBe("");
		now += 100;
		terminal.sendInput("\x03");

		expect(terminal.stops).toBe(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("uses standard emergency exit before interactive keybindings load", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new StartupComposer(config, { terminal, exit });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});
});
