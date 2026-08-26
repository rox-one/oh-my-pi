/**
 * attach/pane.ts — OMO Slim-style fullscreen attach pane (thin shared-surface host).
 *
 * The pane is a SEPARATE PROCESS from the worker's parent: it owns exactly one
 * `TUI(new ProcessTerminal())` (alternate screen, raw mode, resize, signals,
 * restoration) and renders the worker's live transcript through the SAME
 * process-agnostic {@link SessionTranscriptPresenter} the interactive mode
 * uses — message/thinking/tool blocks, model tracking, expansion. The server
 * streams semantic transcript frames (snapshot epoch + live appends); the
 * pane never merges raw output bytes.
 *
 * Controls are leased intents: Enter submits a prompt (queued in order while
 * one is in flight), Ctrl-C on an empty draft aborts the current turn (the
 * pane stays attached), Ctrl-D detaches (releases the lease and restores the
 * terminal without killing the worker), Escape clears the draft. Owner-only
 * session commands (leading `/`) are rejected with a status notice — they
 * belong to the parent session, not the worker pane.
 */

import {
	type Component,
	Container,
	Editor,
	matchesKey,
	type OverlayFocusOwner,
	ProcessTerminal,
	ScrollView,
	Text,
	TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	SessionTranscriptPresenter as Presenter,
	type SessionTranscriptPresenter,
} from "../modes/presentation/shared-transcript";
import { getEditorTheme, type ThemeColor, theme } from "../modes/theme/theme";
import { replaceTabs, shortenPath, truncateToWidth } from "../tools/render-utils";
import { AttachClient, type AttachView, type AttachViewConnection, type AttachViewOpenOutcome } from "./client";
import type {
	AttachControlRejected,
	AttachError,
	AttachEvent,
	AttachPromptResult,
	AttachSessionEntry,
	AttachTranscriptAppend,
	AttachTranscriptBegin,
	AttachTranscriptEnd,
	AttachTranscriptItems,
	AttachTranscriptReset,
	AttachWorkerState,
} from "./protocol";

/** Rows the header and composer chrome reserve; the transcript gets the rest. */
const HEADER_ROWS = 2;
/** Composer max height (top status border + up to two content rows + bottom border). */
const EDITOR_MAX_HEIGHT = 4;

export type { AttachViewConnection };

/** Compact status descriptor rendered in the composer's top border. */
export interface AttachPaneStatus {
	connection: AttachViewConnection;
	state: AttachWorkerState | null;
	model: string | undefined;
	summary: string | null;
	currentTool: string | null;
	queued: number;
	inFlight: boolean;
	lastResult: string | null;
}

const INITIAL_STATUS: AttachPaneStatus = {
	connection: "connecting",
	state: null,
	model: undefined,
	summary: null,
	currentTool: null,
	queued: 0,
	inFlight: false,
	lastResult: null,
};

function themeFg(color: ThemeColor, text: string): string {
	return typeof theme === "undefined" ? text : theme.fg(color, text);
}

function themeBold(text: string): string {
	return typeof theme === "undefined" ? text : theme.bold(text);
}

/** ScrollView wrapper that refits its height to the terminal on every render. */
class HeightAdjustedScroll implements Component {
	readonly #scroll: ScrollView;
	readonly #getRows: () => number;
	readonly #reservedRows: () => number;

	constructor(scroll: ScrollView, getRows: () => number, reservedRows: () => number) {
		this.#scroll = scroll;
		this.#getRows = getRows;
		this.#reservedRows = reservedRows;
	}

	invalidate(): void {
		// ScrollView caches nothing.
	}

	render(width: number): readonly string[] {
		this.#scroll.setHeight(Math.max(0, this.#getRows() - this.#reservedRows()));
		return this.#scroll.render(width);
	}
}

/**
 * Single-row notice line between the header and the transcript: slash-command
 * rejections, abort feedback, view-open rejections, and control errors. It
 * renders nothing while no notice is set; the text is TUI-sanitized and
 * width-capped at render time so exactly one row is produced at any terminal
 * width (the scroll reserves one row while a notice is set).
 */
class NoticeRow implements Component {
	#text = "";

	invalidate(): void {}

	setText(text: string | undefined): void {
		this.#text = text ?? "";
	}

	render(width: number): readonly string[] {
		if (this.#text.length === 0) return [];
		return [truncateToWidth(sanitizeProgressFragment(this.#text), Math.max(1, width))];
	}
}

/**
 * Fullscreen overlay root for the pane. The TUI pins focus to the topmost
 * overlay's component unless that component declares itself an
 * {@link OverlayFocusOwner}; a plain Container would silently re-own focus
 * and swallow every keystroke (the composer would render but never receive
 * input). Owning the composer as the sole focus target lets
 * `ui.setFocus(editor)` land.
 */
class AttachPaneRoot extends Container implements OverlayFocusOwner {
	readonly #focusTarget: Component;

	constructor(focusTarget: Component) {
		super();
		this.#focusTarget = focusTarget;
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this.#focusTarget;
	}
}

export interface AttachPaneOptions {
	/** Invoked with the exit code when the pane terminates. */
	readonly onExit?: (code: number) => void;
	/** TUI to render into. Defaults to a fresh `TUI(new ProcessTerminal())`. */
	readonly ui?: TUI;
	/** Milliseconds between keepalive pings (see {@link AttachClientOptions.pingIntervalMs}). */
	readonly pingIntervalMs?: number;
	/** Reconnect delays in milliseconds (see {@link AttachClientOptions.backoffMs}). */
	readonly backoffMs?: readonly number[];
}

/**
 * Fullscreen attach pane: alternate-screen TUI with a rich transcript
 * (message/thinking/tool blocks via the shared presenter), a live streaming
 * line, a focused editor composer, and lease-validated controls.
 */
export class AttachPane {
	readonly #client: AttachClient;
	readonly #ui: TUI;
	readonly #view: PaneViewAdapter;
	readonly #editor: Editor;
	readonly #noticeRow: NoticeRow;
	readonly #root: Component;
	readonly #onExit: ((code: number) => void) | undefined;
	#presenter: SessionTranscriptPresenter | null = null;
	#status: AttachPaneStatus = INITIAL_STATUS;
	#notice: string | undefined;
	#started = false;
	#finished = false;
	#finishResolve: (() => void) | undefined;
	#finishPromise: Promise<void> = new Promise<void>(resolve => {
		this.#finishResolve = resolve;
	});

	constructor(socketPath: string, token: string, workerId: string, options: AttachPaneOptions = {}) {
		this.#ui = options.ui ?? new TUI(new ProcessTerminal());
		this.#onExit = options.onExit;

		const header = new Text(`attach ${workerId}`, 1, 0);
		header.setStyleFn(text => themeBold(text));

		const noticeRow = new NoticeRow();
		this.#noticeRow = noticeRow;

		const scroll = new ScrollView([], { height: 1, scrollbar: "auto" });
		const editor = new Editor(getEditorTheme());
		editor.setMaxHeight(EDITOR_MAX_HEIGHT);
		editor.setTopBorderProvider(availableWidth => this.#statusBorder(availableWidth));
		editor.onSubmit = text => this.#submit(text);
		this.#editor = editor;

		this.#view = new PaneViewAdapter({
			ui: this.#ui,
			scroll,
			createPresenter: cwd =>
				new Presenter({
					ui: this.#ui,
					cwd: cwd || "",
					requestRender: () => this.#ui.requestRender(),
				}),
			getPresenter: () => this.#presenter,
			setPresenter: presenter => {
				this.#presenter = presenter;
			},
			onStatus: status => {
				this.#status = status;
			},
			onNotice: notice => {
				this.#setNotice(notice);
			},
			getStatus: () => this.#status,
		});
		this.#client = new AttachClient(socketPath, token, workerId, {
			enableSignals: false,
			readline: false,
			pingIntervalMs: options.pingIntervalMs,
			backoffMs: options.backoffMs,
			view: this.#view,
			onExit: code => this.#finish(code),
		});

		this.#ui.addInputListener(data => this.#handleKey(data));

		const root = new AttachPaneRoot(editor);
		root.addChild(header);
		root.addChild(this.#noticeRow);
		root.addChild(
			new HeightAdjustedScroll(
				scroll,
				() => this.#ui.terminal.rows,
				() => HEADER_ROWS + EDITOR_MAX_HEIGHT + (this.#notice ? 1 : 0),
			),
		);
		root.addChild(editor);
		this.#root = root;
	}

	/** The focused composer (test seam). */
	getEditor(): Editor {
		return this.#editor;
	}

	/** Current status descriptor (test seam). */
	getStatus(): AttachPaneStatus {
		return this.#status;
	}

	/** Current rendered transcript text (test seam; presenter rows + live line). */
	getTranscriptText(): string {
		const presenter = this.#presenter;
		const lines: string[] = [];
		if (presenter && !presenter.isEmpty) {
			lines.push(...presenter.container.render(120));
		}
		if (this.#view.liveLine !== undefined) lines.push(this.#view.liveLine);
		return lines.join("\n");
	}

	/**
	 * Present the pane (alternate screen on first paint) and connect to the
	 * attach server. Resolves once the view_open has settled (or the pane
	 * exits early). Hosts that must stay alive for the pane's whole life
	 * await {@link finished} afterwards.
	 */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#ui.showOverlay(this.#root, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: false,
		});
		this.#ui.setFocus(this.#editor);
		this.#ui.start();
		await this.#client.start();
	}

	/** Resolves when the pane finishes (client exit / detach / removal). */
	finished(): Promise<void> {
		return this.#finishPromise;
	}

	/** Shut the transport down without invoking `onExit` (test/cleanup seam). */
	stop(): void {
		this.#client.stop();
		this.#ui.stop();
		this.#finishResolve?.();
	}

	/** Build the composer's top-border status line, truncated to fit. */
	#statusBorder(availableWidth: number): { content: string; width: number } | undefined {
		const status = this.#status;
		const parts: string[] = [];
		const state = status.state ?? (status.connection === "connected" ? "working" : status.connection);
		parts.push(themeFg("accent", state));
		if (status.model !== undefined) parts.push(` ${themeFg("muted", status.model)}`);
		if (status.summary !== null && status.summary.length > 0) {
			parts.push(` ${status.summary}`);
		}
		if (status.currentTool !== null) {
			parts.push(` · tool: ${status.currentTool}`);
		}
		if (status.queued > 0) {
			parts.push(` · queued: ${status.queued}`);
		}
		if (status.inFlight) {
			parts.push(" · working…");
		}
		if (status.lastResult !== null) {
			parts.push(` · last: ${status.lastResult}`);
		}
		const content = truncateToWidth(parts.join(""), availableWidth);
		return { content, width: visibleWidth(content) };
	}

	/** Set the notice row (slash rejections, abort feedback, control errors). */
	#setNotice(notice: string | undefined): void {
		this.#notice = notice;
		this.#noticeRow.setText(notice);
		this.#ui.requestRender();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		if (trimmed.startsWith("/")) {
			// Owner-only session commands (/new, /resume, /model, …) belong to
			// the parent session; the worker pane cannot apply them.
			this.#setNotice("owner-only session commands are not supported in a worker pane");
			this.#editor.setText("");
			return;
		}
		this.#setNotice(undefined);
		this.#status = {
			...this.#status,
			queued: this.#status.queued + 1,
			inFlight: true,
		};
		this.#client.sendPrompt(trimmed);
		this.#ui.requestRender();
	}

	/** Composer keys the TUI input listener intercepts before the editor. */
	#handleKey(data: string): { consume: boolean } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			if (this.#editor.textEquals("")) {
				// Abort-current-turn: the pane stays attached.
				this.#setNotice("aborting current turn…");
				this.#client.abortTurn();
			} else {
				this.#editor.setText("");
			}
			this.#ui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			// Detach: release the lease and restore the terminal. The worker
			// keeps running.
			this.#client.detach("user");
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			if (!this.#editor.textEquals("")) {
				this.#editor.setText("");
				this.#ui.requestRender();
			}
			return { consume: true };
		}
		return undefined;
	}

	/** Terminal exit: paint the final frame, then restore the terminal. */
	#finish(code: number): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#ui.requestRender(true);
		setImmediate(() => {
			this.#ui.stop();
			// Resolve only after the terminal is restored so a host that
			// process.exits on `finished()` never skips the restore.
			this.#finishResolve?.();
		});
		this.#onExit?.(code);
	}
}

/**
 * Shared TUI sanitization for a progress fragment before it can reach the
 * ScrollView: strip ANSI/control sequences, expand tabs to spaces, collapse
 * embedded line breaks (ScrollView rows are single lines), and shorten home
 * paths. The escape/control strip runs before any width-aware truncation so
 * escape bytes can never reach the rendered row.
 */
function sanitizeProgressFragment(text: string): string {
	const normalized = replaceTabs(sanitizeText(text)).replace(/\n/g, " ");
	return shortenPath(normalized);
}

/**
 * Renders a live streaming line below the committed transcript. Every
 * candidate fragment (tool, args, intent, output tail) goes through the
 * shared TUI sanitizers, and the composed line is width-capped to the
 * terminal columns at event time — raw worker output never reaches the
 * ScrollView.
 */
function liveLineFor(event: Extract<AttachEvent, { type: "progress" }>, width: number): string | undefined {
	if (event.currentTool !== undefined && event.currentTool.trim().length > 0) {
		const tool = sanitizeProgressFragment(event.currentTool).trim();
		if (tool.length > 0) {
			const argsText =
				event.currentToolArgs !== undefined && event.currentToolArgs.trim().length > 0
					? sanitizeProgressFragment(event.currentToolArgs).trim()
					: "";
			const args = argsText.length > 0 ? ` ${argsText}` : "";
			return truncateToWidth(`⚙ ${tool}${args}`, width);
		}
	}
	if (event.lastIntent !== undefined && event.lastIntent.trim().length > 0) {
		const intent = sanitizeProgressFragment(event.lastIntent).trim();
		if (intent.length > 0) return truncateToWidth(intent, width);
	}
	const tail = event.outputTail;
	for (let i = tail.length - 1; i >= 0; i -= 1) {
		const line = sanitizeProgressFragment(tail[i]!).trim();
		if (line.length > 0) return truncateToWidth(line, width);
	}
	return undefined;
}

interface PaneViewAdapterOptions {
	ui: TUI;
	scroll: ScrollView;
	/** Create the shared transcript presenter for a view (cwd known). */
	createPresenter: (cwd: string) => SessionTranscriptPresenter;
	getPresenter: () => SessionTranscriptPresenter | null;
	setPresenter: (presenter: SessionTranscriptPresenter | null) => void;
	onStatus: (status: AttachPaneStatus) => void;
	onNotice: (notice: string | undefined) => void;
	getStatus: () => AttachPaneStatus;
}

/**
 * {@link AttachView} adapter for the pane: applies transcript frames to the
 * shared presenter and repaints the scroll view (sticking to the bottom
 * unless the user scrolled up), then requests a TUI render.
 */
class PaneViewAdapter implements AttachView {
	readonly #ui: TUI;
	readonly #scroll: ScrollView;
	readonly #createPresenter: (cwd: string) => SessionTranscriptPresenter;
	readonly #getPresenter: () => SessionTranscriptPresenter | null;
	readonly #setPresenter: (presenter: SessionTranscriptPresenter | null) => void;
	readonly #onStatus: (status: AttachPaneStatus) => void;
	readonly #onNotice: (notice: string | undefined) => void;
	readonly #getStatus: () => AttachPaneStatus;
	#liveLineInternal: string | undefined;

	constructor(options: PaneViewAdapterOptions) {
		this.#ui = options.ui;
		this.#scroll = options.scroll;
		this.#createPresenter = options.createPresenter;
		this.#getPresenter = options.getPresenter;
		this.#setPresenter = options.setPresenter;
		this.#onStatus = options.onStatus;
		this.#onNotice = options.onNotice;
		this.#getStatus = options.getStatus;
	}

	get liveLine(): string | undefined {
		return this.#liveLineInternal;
	}

	onConnection(connection: AttachViewConnection): void {
		this.#patch({ connection });
	}

	onEntry(entry: AttachSessionEntry): void {
		this.#patch({ state: entry.state, summary: entry.summary });
	}

	onState(state: AttachWorkerState): void {
		this.#patch({ state });
	}

	onViewOpen(outcome: AttachViewOpenOutcome): void {
		if (!outcome.ok) {
			this.#onNotice(`view rejected: ${outcome.rejection.code}: ${outcome.rejection.message}`);
			return;
		}
		// A fresh view epoch: (re)create the presenter for the worker's cwd
		// and reset it — the incoming begin/items/end frames rebuild it.
		const presenter = this.#createPresenter(outcome.cwd ?? "");
		this.#setPresenter(presenter);
		this.#liveLineInternal = undefined;
		this.#patch({ model: undefined, state: outcome.entry.state, summary: outcome.entry.summary });
		this.refresh();
	}

	onTranscriptBegin(_frame: AttachTranscriptBegin): void {
		const presenter = this.#getPresenter();
		if (presenter) {
			presenter.setModel(undefined);
			presenter.reset();
		}
		this.refresh();
	}

	onTranscriptItems(frame: AttachTranscriptItems): void {
		const presenter = this.#getPresenter();
		if (presenter) presenter.append(frame.items);
		this.refresh();
	}

	onTranscriptEnd(frame: AttachTranscriptEnd): void {
		const presenter = this.#getPresenter();
		if (presenter) presenter.setModel(frame.model);
		// A committed message replaced the streaming tail.
		this.#liveLineInternal = undefined;
		this.refresh();
	}

	onTranscriptAppend(frame: AttachTranscriptAppend): void {
		const presenter = this.#getPresenter();
		if (presenter) presenter.append(frame.items);
		this.#liveLineInternal = undefined;
		this.refresh();
	}

	onTranscriptReset(_frame: AttachTranscriptReset): void {
		const presenter = this.#getPresenter();
		if (presenter) {
			presenter.setModel(undefined);
			presenter.reset();
		}
		this.#liveLineInternal = undefined;
		this.refresh();
	}

	onProgress(event: Extract<AttachEvent, { type: "progress" }>): void {
		// Width derives from terminal columns at event time (minus the
		// scrollbar column); the ScrollView re-truncates on resize renders.
		const line = liveLineFor(event, Math.max(1, this.#ui.terminal.columns - 1));
		if (line !== undefined) this.#liveLineInternal = line;
		this.#patch({
			currentTool: event.currentTool !== undefined && event.currentTool.trim().length > 0 ? event.currentTool : null,
		});
		this.refresh();
	}

	onPromptAccepted(_ref: string): void {
		this.#patch({ inFlight: true });
		this.refresh();
	}

	onPromptResult(event: AttachPromptResult): void {
		const status = this.#getStatus();
		const lastResult = event.ok
			? event.payload === undefined
				? "ok"
				: typeof event.payload === "string"
					? event.payload
					: JSON.stringify(event.payload)
			: `error: ${event.error ?? "failed"}`;
		this.#patch({
			queued: Math.max(0, status.queued - 1),
			inFlight: status.queued > 1,
			lastResult,
			currentTool: null,
		});
		this.refresh();
	}

	onControlRejected(rejection: AttachControlRejected): void {
		const status = this.#getStatus();
		if (rejection.ref !== undefined && (status.inFlight || status.queued > 0)) {
			this.#patch({
				queued: Math.max(0, status.queued - 1),
				inFlight: status.queued > 1,
			});
		}
		this.#onNotice(`${rejection.code}: ${rejection.message}`);
		this.refresh();
	}

	onError(error: AttachError): void {
		this.#onNotice(`[error] ${error.code}: ${error.message}`);
		this.refresh();
	}

	onRemoved(reason: string): void {
		this.#onNotice(`worker removed: ${reason}`);
		this.refresh();
	}

	onBye(reason?: string): void {
		this.#onNotice(reason !== undefined && reason.length > 0 ? `bye: ${reason}` : "bye");
		this.refresh();
	}

	#patch(patch: Partial<AttachPaneStatus>): void {
		this.#onStatus({ ...this.#getStatus(), ...patch });
	}

	/** Rebuild the scroll lines from the presenter + live line and repaint. */
	refresh(): void {
		const presenter = this.#getPresenter();
		const wasAtBottom = this.#scroll.getScrollOffset() >= this.#scroll.getMaxScrollOffset();
		const lines: string[] = [];
		if (presenter && !presenter.isEmpty) {
			lines.push(...presenter.container.render(Math.max(40, this.#ui.terminal.columns - 1)));
		} else {
			lines.push("  no messages yet");
		}
		if (this.#liveLineInternal !== undefined) {
			lines.push(this.#liveLineInternal);
		}
		this.#scroll.setLines(lines);
		if (wasAtBottom) this.#scroll.scrollToBottom();
		this.#ui.requestRender();
	}
}
