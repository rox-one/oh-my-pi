import { ProcessTerminal, type ResizeScrollbackMode, Spacer, type Terminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "./components/custom-editor";
import { getEditorTheme, theme } from "./theme/theme";

const DOUBLE_INTERRUPT_MS = 500;

export interface StartupComposerSurface {
	readonly ui: TUI;
	readonly editor: CustomEditor;
}

export interface StartupComposerConfig {
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly scrollbackRebuild: boolean;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
}

export interface StartupComposerOptions {
	readonly terminal?: Terminal;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}
let pendingStartupComposer: StartupComposer | undefined;

export function beginStartupComposer(config: StartupComposerConfig): void {
	if (pendingStartupComposer) {
		throw new Error("Startup composer is already active");
	}
	pendingStartupComposer = new StartupComposer(config);
	pendingStartupComposer.start();
}

export function takeStartupComposerSurface(): StartupComposerSurface | undefined {
	const composer = pendingStartupComposer;
	pendingStartupComposer = undefined;
	return composer?.handoff();
}

export function stopPendingStartupComposer(): void {
	pendingStartupComposer?.stop();
	pendingStartupComposer = undefined;
}

/**
 * Owns the real interactive editor while session startup is still running.
 * The surface is deliberately non-submitting until InteractiveMode installs
 * the session-aware handlers and adopts the same TUI and editor instances.
 */
export class StartupComposer {
	readonly ui: TUI;
	readonly editor: CustomEditor;

	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#lastInterruptAt = 0;
	#started = false;
	#stopped = false;

	#transferred = false;
	constructor(config: StartupComposerConfig, options: StartupComposerOptions = {}) {
		this.#exit = options.exit ?? (code => process.exit(code));
		this.#now = options.now ?? Date.now;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal(), config.showHardwareCursor);
		this.ui.setMaxInlineImages(config.maxInlineImages);
		this.ui.setScrollbackRebuild(config.scrollbackRebuild);
		this.ui.setResizeScrollback(config.resizeScrollback);

		this.editor = new CustomEditor(getEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(config.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(config.autocompleteMaxVisible);
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestDirectWrite(this.editor));

		this.ui.enableScopedInputRender(this.editor);
		this.ui.addChild(new Text(theme.fg("muted", "Starting OMP. You can type while startup finishes."), 1, 0));
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editor);
		this.ui.setFocus(this.editor);
	}

	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: true });
		this.ui.requestRender(true);
	}

	handoff(): StartupComposerSurface {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Startup composer is not available for handoff");
		}
		this.#transferred = true;
		return { ui: this.ui, editor: this.editor };
	}

	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#stopped = true;
		this.ui.stop();
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		if (this.#stopped || this.#transferred) return;
		this.#stopped = true;
		if (this.#started) this.ui.stop();
		this.#exit(code);
	}
}
