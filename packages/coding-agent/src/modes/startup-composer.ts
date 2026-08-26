import { ProcessTerminal, type ResizeScrollbackMode, Spacer, type Terminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "./components/custom-editor";
import { getEditorTheme } from "./theme/theme";

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

/**
 * Mirrors the canonical settings schema without importing its full runtime graph
 * on the first-paint path. The startup composer test guards these values against drift.
 */
export const STARTUP_COMPOSER_DEFAULTS: StartupComposerConfig = {
	showHardwareCursor: true,
	maxInlineImages: 8,
	scrollbackRebuild: false,
	resizeScrollback: "append",
	imeSafeCursor: false,
	autocompleteMaxVisible: 5,
};

export interface StartupComposerOptions {
	readonly terminal?: Terminal;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}
let pendingStartupComposer: StartupComposer | undefined;

export class StartupComposerLease {
	readonly surface: StartupComposerSurface;

	readonly #composer: StartupComposer;
	#adopted = false;

	constructor(composer: StartupComposer) {
		this.#composer = composer;
		this.surface = { ui: composer.ui, editor: composer.editor };
	}

	adopt(): void {
		if (this.#adopted) return;
		this.#composer.handoff();
		this.#adopted = true;
	}

	dispose(): void {
		if (!this.#adopted) this.#composer.stop();
	}
}

export function beginStartupComposer(config: StartupComposerConfig, options: StartupComposerOptions = {}): void {
	if (pendingStartupComposer) {
		throw new Error("Startup composer is already active");
	}
	const composer = new StartupComposer(config, options);
	try {
		composer.start();
	} catch (error) {
		try {
			composer.stop();
		} catch {}
		throw error;
	}
	pendingStartupComposer = composer;
}

export function takeStartupComposerLease(): StartupComposerLease | undefined {
	const composer = pendingStartupComposer;
	pendingStartupComposer = undefined;
	return composer ? new StartupComposerLease(composer) : undefined;
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
		// Keep conventional emergency controls available during bootstrap. InteractiveMode
		// replaces these with the user's configured bindings when it adopts the editor.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestDirectWrite(this.editor));
		this.ui.addChild(new Text("Starting OMP. You can type while startup finishes.", 1, 0));
		this.ui.enableScopedInputRender(this.editor);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editor);
		this.ui.setFocus(this.editor);
	}

	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: true });
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
