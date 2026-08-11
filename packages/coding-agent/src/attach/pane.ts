/**
 * attach/pane.ts — OMO Slim-style fullscreen attach pane.
 *
 * Three layers, deliberately split so the transcript logic is pure and the
 * TUI surface stays thin:
 *
 * - {@link AttachPaneModel} — pure transcript/status model with no I/O. It
 *   owns row bounding, empty-field suppression, consecutive-duplicate
 *   suppression, and the longest-suffix-overlap merge for progress tails.
 * - {@link AttachPaneView} — {@link AttachView} adapter: mutates the model on
 *   every client callback, repaints the scroll view, and requests a render.
 * - {@link AttachPane} — owns the `TUI(new ProcessTerminal())` composition
 *   (header + scrollable transcript + focused editor composer), the key
 *   handling (Ctrl-C draft-clear / abort+bye, Escape draft-clear, Enter
 *   submit with the editor's built-in multiline behavior), and the teardown
 *   path. Presenting the pane as a fullscreen overlay borrows the alternate
 *   screen buffer on first paint, so the shell launch command disappears
 *   behind the pane and the terminal is restored cleanly on exit.
 *
 * The attach protocol, server, registry, and vibe bridge are untouched: this
 * file only consumes the existing {@link AttachClient} transport seam.
 */

import type { Component, OverlayFocusOwner } from "@oh-my-pi/pi-tui";
import {
	Container,
	Editor,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { getEditorTheme, theme } from "../modes/theme/theme";
import { AttachClient, type AttachView, type AttachViewConnection, sanitizeAttachLine, TRIM_MARKER } from "./client";
import type { AttachError, AttachEvent, AttachSessionEntry, AttachWorkerState } from "./protocol";

/** Rows the header and composer chrome reserve; the transcript gets the rest. */
const HEADER_ROWS = 1;
/** Composer max height (top status border + up to two content rows + bottom border). */
const EDITOR_MAX_HEIGHT = 4;
/** Default transcript row bound. */
const DEFAULT_MAX_ROWS = 500;
/** Default cap for a single rendered transcript row. */
const DEFAULT_MAX_LINE_LENGTH = 200;

export type { AttachViewConnection };

export type AttachPaneRowKind = "followup" | "tool" | "intent" | "output" | "result" | "error" | "removed" | "bye";

/** One bounded, sanitized transcript row. */
export interface AttachPaneRow {
	readonly kind: AttachPaneRowKind;
	readonly text: string;
}

/** Compact status descriptor rendered in the composer's top border. */
export interface AttachPaneStatus {
	readonly connection: AttachViewConnection;
	readonly state: AttachWorkerState | null;
	readonly summary: string | null;
	readonly currentTool: string | null;
	readonly queued: number;
	readonly inFlight: boolean;
	readonly lastResult: string | null;
}

export interface AttachPaneModelOptions {
	/** Maximum transcript rows kept; older rows are dropped with a trim marker. Defaults to 500. */
	readonly maxRows?: number;
	/** Maximum characters per rendered row. Defaults to 200. */
	readonly maxLineLength?: number;
}

/**
 * Pure transcript + status model for the attach pane. No TUI imports, no I/O:
 * every observable behavior (empty suppression, tail-overlap dedupe, state
 * bursts producing no rows, row bounding) is unit-testable in isolation.
 */
export class AttachPaneModel {
	#rows: AttachPaneRow[] = [];
	#trimMarkerPrinted = false;
	/** Last progress `outputTail` seen, for longest-suffix-overlap merging. */
	#lastOutputTail: readonly string[] = [];
	#status: AttachPaneStatus = {
		connection: "connecting",
		state: null,
		summary: null,
		currentTool: null,
		queued: 0,
		inFlight: false,
		lastResult: null,
	};
	readonly #maxRows: number;
	readonly #maxLineLength: number;

	constructor(options: AttachPaneModelOptions = {}) {
		this.#maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
		this.#maxLineLength = Math.max(1, options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH);
	}

	get rows(): readonly AttachPaneRow[] {
		return this.#rows;
	}

	get status(): AttachPaneStatus {
		return this.#status;
	}

	setConnection(connection: AttachViewConnection): void {
		this.#status = { ...this.#status, connection };
	}

	/** Registry entry changes (snapshot / registered / updated) affect the header only. */
	applyEntry(entry: AttachSessionEntry): void {
		this.#status = { ...this.#status, state: entry.state, summary: entry.summary };
	}

	/** Lifecycle state events affect the header only — never the transcript. */
	setState(state: AttachWorkerState): void {
		this.#status = { ...this.#status, state };
	}

	setQueued(queued: number): void {
		this.#status = { ...this.#status, queued: Math.max(0, queued) };
	}

	setInFlight(inFlight: boolean): void {
		this.#status = { ...this.#status, inFlight };
	}

	/**
	 * One outstanding follow-up settled (a result, or a ref-carrying error).
	 * Decrements the outstanding count and keeps `inFlight` true iff another
	 * prompt is still outstanding — the transport synchronously flushes the
	 * next queued prompt when a follow-up settles, so the slot is busy again
	 * exactly when the count is still positive.
	 */
	settleOne(): void {
		const queued = Math.max(0, this.#status.queued - 1);
		this.#status = { ...this.#status, queued, inFlight: queued > 0 };
	}

	/** Immediate echo of a composer submit. */
	appendFollowUp(payload: string): void {
		const text = sanitizeAttachLine(payload, this.#maxLineLength);
		if (text.length === 0) return;
		this.#appendRow({ kind: "followup", text });
	}

	/**
	 * Apply one coalesced progress event: a tool row only when the tool label
	 * is non-empty, an intent row only when the intent is non-empty, and the
	 * output tail merged against the previous tail by longest suffix/prefix
	 * overlap so repeated tails never duplicate rows. `state`/`updated`
	 * bursts never reach this method — they are header-only.
	 */
	appendProgress(event: Extract<AttachEvent, { type: "progress" }>): void {
		if (event.currentTool !== undefined && event.currentTool.trim().length > 0) {
			const args =
				event.currentToolArgs !== undefined && event.currentToolArgs.trim().length > 0
					? ` ${event.currentToolArgs}`
					: "";
			const text = sanitizeAttachLine(`tool: ${event.currentTool}${args}`, this.#maxLineLength);
			if (text.length > 0) this.#appendRow({ kind: "tool", text });
		}
		if (event.lastIntent !== undefined && event.lastIntent.trim().length > 0) {
			const text = sanitizeAttachLine(`intent: ${event.lastIntent}`, this.#maxLineLength);
			if (text.length > 0) this.#appendRow({ kind: "intent", text });
		}
		this.#mergeOutputTail(event.outputTail);
		this.#status = {
			...this.#status,
			currentTool:
				event.currentTool !== undefined && event.currentTool.trim().length > 0
					? sanitizeAttachLine(event.currentTool, this.#maxLineLength)
					: null,
		};
	}

	appendResult(event: Extract<AttachEvent, { type: "follow_up_result" }>): void {
		const text = event.ok
			? event.payload === undefined
				? "[result] ok"
				: `[result] ${typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}`
			: `[result] error: ${event.error ?? "failed"}`;
		const sanitized = sanitizeAttachLine(text, this.#maxLineLength);
		if (sanitized.length === 0) return;
		this.#appendRow({ kind: event.ok ? "result" : "error", text: sanitized });
		// The turn settled: no tool is running anymore, and the result is the
		// latest outcome for the header.
		this.#status = { ...this.#status, lastResult: sanitized, currentTool: null };
	}

	appendError(error: AttachError): void {
		const text = sanitizeAttachLine(`[error] ${error.code}: ${error.message}`, this.#maxLineLength);
		if (text.length === 0) return;
		this.#appendRow({ kind: "error", text });
	}

	appendRemoved(reason: string): void {
		const text = sanitizeAttachLine(`[removed] ${reason}`, this.#maxLineLength);
		if (text.length === 0) return;
		this.#appendRow({ kind: "removed", text });
	}

	appendBye(): void {
		this.#appendRow({ kind: "bye", text: "[bye]" });
	}

	/** Append a row, dropping consecutive duplicates and bounding the window. */
	#appendRow(row: AttachPaneRow): void {
		const previous = this.#rows[this.#rows.length - 1];
		if (previous !== undefined && previous.kind === row.kind && previous.text === row.text) return;
		this.#rows.push(row);
		// The trim marker, once emitted, is pinned at the front; only content
		// rows count against the bound.
		const markerOffset = this.#trimMarkerPrinted ? 1 : 0;
		if (this.#rows.length - markerOffset > this.#maxRows) {
			this.#rows.splice(markerOffset, this.#rows.length - markerOffset - this.#maxRows);
			if (!this.#trimMarkerPrinted) {
				this.#trimMarkerPrinted = true;
				this.#rows.unshift({ kind: "output", text: TRIM_MARKER });
			}
		}
	}

	/**
	 * Append only the part of `tail` not already covered by the previous tail:
	 * `k` is the longest suffix of the previous tail that is also a prefix of
	 * the new tail, and `tail.slice(k)` is appended.
	 */
	#mergeOutputTail(tail: readonly string[]): void {
		const previous = this.#lastOutputTail;
		let overlap = 0;
		const max = Math.min(previous.length, tail.length);
		for (let k = max; k > 0; k -= 1) {
			let matches = true;
			for (let i = 0; i < k; i += 1) {
				if (previous[previous.length - k + i] !== tail[i]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				overlap = k;
				break;
			}
		}
		for (let i = overlap; i < tail.length; i += 1) {
			const text = sanitizeAttachLine(tail[i]!, this.#maxLineLength);
			if (text.length === 0) continue;
			this.#appendRow({ kind: "output", text });
		}
		this.#lastOutputTail = [...tail];
	}
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

export interface AttachPaneViewOptions {
	readonly ui: TUI;
	readonly model: AttachPaneModel;
	readonly scroll: ScrollView;
}

/**
 * {@link AttachView} adapter for the pane: mutates the pure model and repaints
 * the scroll view (sticking to the bottom unless the user scrolled up), then
 * requests a TUI render.
 */
export class AttachPaneView implements AttachView {
	readonly #ui: TUI;
	readonly #model: AttachPaneModel;
	readonly #scroll: ScrollView;
	/** Ref of the follow-up the transport is currently working on, if known. */
	#inFlightRef: string | null = null;

	constructor(options: AttachPaneViewOptions) {
		this.#ui = options.ui;
		this.#model = options.model;
		this.#scroll = options.scroll;
	}

	onConnection(connection: AttachViewConnection): void {
		this.#model.setConnection(connection);
		this.refresh();
	}

	onEntry(entry: AttachSessionEntry): void {
		this.#model.applyEntry(entry);
		this.refresh();
	}

	onState(state: AttachWorkerState): void {
		this.#model.setState(state);
		this.refresh();
	}

	onProgress(event: Extract<AttachEvent, { type: "progress" }>): void {
		this.#model.appendProgress(event);
		this.refresh();
	}

	onFollowUpAccepted(ref: string): void {
		// The server confirmed it is working on this follow-up; with the
		// client-side queue the transport only sends when the slot is free,
		// so this asserts the in-flight flag rather than toggling it.
		this.#inFlightRef = ref;
		this.#model.setInFlight(true);
		this.refresh();
	}

	onResult(event: Extract<AttachEvent, { type: "follow_up_result" }>): void {
		this.#model.appendResult(event);
		this.#inFlightRef = null;
		// The transport flushes the next queued prompt synchronously after a
		// result, so the slot is still busy when more prompts are outstanding.
		this.#model.settleOne();
		this.refresh();
	}

	onError(error: AttachError): void {
		this.#model.appendError(error);
		// Only follow-up errors carry a ref (server.ts echoes the offending
		// follow_up ref); such an error settles that outstanding prompt and
		// the transport immediately flushes the next queued one.
		if (error.ref !== undefined && (this.#inFlightRef === null || error.ref === this.#inFlightRef)) {
			this.#inFlightRef = null;
			this.#model.settleOne();
		}
		this.refresh();
	}

	onRemoved(reason: string): void {
		this.#model.appendRemoved(reason);
		this.refresh();
	}

	onBye(): void {
		this.#model.appendBye();
		this.refresh();
	}

	/** Rebuild the scroll lines from the model and repaint. */
	refresh(): void {
		const wasAtBottom = this.#scroll.getScrollOffset() >= this.#scroll.getMaxScrollOffset();
		this.#scroll.setLines(this.#model.rows.map(row => this.#styleRow(row)));
		if (wasAtBottom) this.#scroll.scrollToBottom();
		this.#ui.requestRender();
	}

	#styleRow(row: AttachPaneRow): string {
		const activeTheme = typeof theme === "undefined" ? undefined : theme;
		if (activeTheme === undefined) return row.text;
		switch (row.kind) {
			case "followup":
				return activeTheme.fg("userMessageText", `> ${row.text}`);
			case "tool":
				return activeTheme.fg("accent", row.text);
			case "intent":
				return activeTheme.fg("dim", row.text);
			case "result":
				return activeTheme.fg("success", row.text);
			case "error":
				return activeTheme.fg("error", row.text);
			case "removed":
				return activeTheme.fg("warning", row.text);
			case "bye":
				return activeTheme.fg("dim", row.text);
			case "output":
				return row.text;
		}
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
	/** Maximum transcript rows kept. Defaults to 500. */
	readonly maxRows?: number;
	/** Maximum characters per rendered row. Defaults to 200. */
	readonly maxLineLength?: number;
}

/**
 * Fullscreen attach pane: alternate-screen TUI with a clean header, a bounded
 * scrollable transcript, and a focused editor composer. Enter submits, the
 * editor's built-in Shift/Ctrl+Enter inserts newlines, Escape clears the
 * draft, and Ctrl-C clears the draft or (on an empty draft) aborts the
 * in-flight follow-up, sends bye, and exits 0.
 */
export class AttachPane {
	readonly #client: AttachClient;
	readonly #ui: TUI;
	readonly #model: AttachPaneModel;
	readonly #view: AttachPaneView;
	readonly #editor: Editor;
	readonly #root: Component;
	readonly #onExit: ((code: number) => void) | undefined;
	#started = false;
	#finished = false;

	constructor(socketPath: string, token: string, workerId: string, options: AttachPaneOptions = {}) {
		this.#model = new AttachPaneModel({ maxRows: options.maxRows, maxLineLength: options.maxLineLength });
		this.#ui = options.ui ?? new TUI(new ProcessTerminal());
		this.#onExit = options.onExit;

		const header = new Text(`attach ${workerId}`, 1, 0);
		header.setStyleFn(text => {
			const activeTheme = typeof theme === "undefined" ? undefined : theme;
			return activeTheme === undefined ? text : activeTheme.bold(text);
		});

		const scroll = new ScrollView([], { height: 1, scrollbar: "auto" });
		this.#view = new AttachPaneView({ ui: this.#ui, model: this.#model, scroll });

		const editor = new Editor(getEditorTheme());
		editor.setMaxHeight(EDITOR_MAX_HEIGHT);
		editor.setTopBorderProvider(availableWidth => this.#statusBorder(availableWidth));
		editor.onSubmit = text => this.#submit(text);
		this.#editor = editor;

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
		root.addChild(
			new HeightAdjustedScroll(
				scroll,
				() => this.#ui.terminal.rows,
				() => HEADER_ROWS + EDITOR_MAX_HEIGHT,
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
		return this.#model.status;
	}

	/** Current transcript rows (test seam). */
	getRows(): readonly AttachPaneRow[] {
		return this.#model.rows;
	}

	/**
	 * Present the pane (alternate screen on first paint) and connect to the
	 * attach server. Resolves once the handshake and subscribe snapshot have
	 * completed (or the pane exits early).
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

	/** Shut the transport down without invoking `onExit` (test/cleanup seam). */
	stop(): void {
		this.#client.stop();
		this.#ui.stop();
	}

	/** Build the composer's top-border status line, truncated to fit. */
	#statusBorder(availableWidth: number): { content: string; width: number } | undefined {
		const activeTheme = typeof theme === "undefined" ? undefined : theme;
		const status = this.#model.status;
		const parts: string[] = [];
		const state = status.state ?? (status.connection === "connected" ? "working" : status.connection);
		parts.push(activeTheme === undefined ? state : activeTheme.fg("accent", state));
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

	#submit(text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		this.#model.appendFollowUp(trimmed);
		this.#model.setQueued(this.#model.status.queued + 1);
		this.#model.setInFlight(true);
		this.#client.sendFollowUp(trimmed);
		// Rebuild the scroll lines NOW: when the prompt is queued client-side
		// (another follow-up in flight) no server event arrives until it
		// flushes, so the immediate user echo must be painted here, not in a
		// view callback.
		this.#view.refresh();
	}

	/** Composer keys the TUI input listener intercepts before the editor. */
	#handleKey(data: string): { consume: boolean } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			if (this.#editor.textEquals("")) {
				this.#client.interrupt();
			} else {
				this.#editor.setText("");
				this.#ui.requestRender();
			}
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
		setImmediate(() => this.#ui.stop());
		this.#onExit?.(code);
	}
}
