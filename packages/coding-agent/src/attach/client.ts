/**
 * attach/client.ts — interactive pane client for the local worker-attach substrate.
 *
 * Connects to the attach server over a Unix socket, authenticates with the
 * capability token, subscribes to a single worker, and forwards each stdin
 * line as a follow-up. All rendering is delegated to an {@link AttachView};
 * the client owns every I/O surface (socket, keepalive, reconnect backoff,
 * readline, signals, exit codes) so the transport is fully testable without a
 * TTY or a real server and interchangeable views (line dump, fullscreen TUI)
 * never touch the wire protocol.
 *
 * Follow-ups are serialized: while one is in flight, further input is queued
 * client-side and flushed in order once the in-flight follow-up settles, so
 * rapid follow-ups never hit the server's `busy` rejection.
 */

import * as net from "node:net";
import { createInterface, type Interface } from "node:readline";
import {
	ATTACH_PROTOCOL_VERSION,
	type AttachClientMessage,
	type AttachError,
	type AttachEvent,
	AttachFrameAccumulator,
	type AttachMessage,
	type AttachSessionEntry,
	type AttachSnapshot,
	type AttachWorkerKey,
	type AttachWorkerState,
	decodeAttachLine,
	encodeAttachMessage,
} from "./protocol";

/** Options for {@link AttachClient}; every field is injectable for tests. */
export interface AttachClientOptions {
	/** Stream rendered lines are written to. Defaults to `process.stdout`. */
	readonly stdout?: NodeJS.WritableStream;
	/** Stream read for follow-up input. Defaults to `process.stdin`. */
	readonly stdin?: NodeJS.ReadableStream;
	/** Milliseconds between keepalive pings. Defaults to 30000. */
	readonly pingIntervalMs?: number;
	/** Reconnect delays in milliseconds; the last value repeats. Defaults to [200, 500, 1000, 2000, 5000]. */
	readonly backoffMs?: readonly number[];
	/** Maximum lines kept in the rendered rolling window before trimming. Defaults to 500. */
	readonly maxRenderedLines?: number;
	/** Handle SIGINT (abort the in-flight follow-up, then bye). Defaults to true. */
	readonly enableSignals?: boolean;
	/**
	 * Read follow-up input from a readline interface over `stdin`. Defaults to
	 * true (line view). Fullscreen views that own the terminal (e.g. the TUI
	 * pane) MUST set this to false and drive {@link AttachClient.sendFollowUp}
	 * from their own input path — readline and the TUI cannot share stdin.
	 */
	readonly readline?: boolean;
	/** Invoked with the exit code when the client terminates itself. */
	readonly onExit?: (code: number) => void;
	/** Rendering surface for worker state and output. Defaults to {@link AttachLineView}. */
	readonly view?: AttachView;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [200, 500, 1000, 2000, 5000];

const MAX_RENDERED_LINE_LENGTH = 200;

/** Marker emitted when a bounded render window first drops earlier output. */
export const TRIM_MARKER = "[trimmed: earlier output dropped]";

/**
 * Sanitize one rendered line: strip ANSI escape sequences and control
 * characters, then cap the length. Every line written to stdout goes through
 * this so a worker can never inject terminal escapes or unbounded output.
 */
export function sanitizeAttachLine(text: string, maxLength = MAX_RENDERED_LINE_LENGTH): string {
	let clean = text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\r/g, "");
	if (clean.length > maxLength) clean = clean.slice(0, maxLength);
	return clean;
}

/** Connection phase reported to views: first attempt, authenticated, or reconnecting. */
export type AttachViewConnection = "connecting" | "connected" | "reconnecting";

/**
 * Rendering surface driven by {@link AttachClient}. The transport calls these
 * hooks for every protocol-visible transition; implementations decide how to
 * present them (a line dump, a fullscreen TUI, a test spy). Every hook is
 * optional so lightweight views implement only what they render.
 */
export interface AttachView {
	/** The transport started a connection attempt or re-authenticated. */
	onConnection?(connection: AttachViewConnection): void;
	/** The worker's registry entry changed (initial snapshot / registered / updated). */
	onEntry?(entry: AttachSessionEntry): void;
	/** The worker's lifecycle state changed. */
	onState?(state: AttachWorkerState): void;
	/** Coalesced live progress: tool / intent / output tail. */
	onProgress?(event: Extract<AttachEvent, { type: "progress" }>): void;
	/** The server accepted the follow-up with the given ref. */
	onFollowUpAccepted?(ref: string): void;
	/** A follow-up settled with a result (or an error payload). */
	onResult?(event: Extract<AttachEvent, { type: "follow_up_result" }>): void;
	/** A protocol-level error arrived (e.g. `busy` from an external client). */
	onError?(error: AttachError): void;
	/** The worker was removed; the client exits 0 immediately after. */
	onRemoved?(reason: string): void;
	/** The server sent a polite `bye`; the client exits 0 immediately after. */
	onBye?(): void;
	/** The client terminated itself with the given code. */
	onExit?(code: number): void;
}

/**
 * Default line-oriented view: writes bounded sanitized lines to a writable
 * stream, keeping a rolling window that emits `TRIM_MARKER` once when it
 * first overflows. Byte-compatible with the pre-seam rendering so existing
 * line-based consumers and tests keep their exact output contract.
 */
export class AttachLineView implements AttachView {
	readonly #stdout: NodeJS.WritableStream;
	readonly #maxRenderedLines: number;
	#renderedLines: string[] = [];
	#trimMarkerPrinted = false;

	constructor(options: { readonly stdout?: NodeJS.WritableStream; readonly maxRenderedLines?: number } = {}) {
		this.#stdout = options.stdout ?? process.stdout;
		this.#maxRenderedLines = options.maxRenderedLines ?? 500;
	}

	onEntry(entry: AttachSessionEntry): void {
		const summary = entry.summary !== null && entry.summary.length > 0 ? ` ${entry.summary}` : "";
		this.#renderLine(`[${entry.state}]${summary}`);
	}

	onState(state: AttachWorkerState): void {
		this.#renderLine(`[${state}]`);
	}

	onProgress(event: Extract<AttachEvent, { type: "progress" }>): void {
		if (event.currentTool !== undefined && event.currentTool.trim().length > 0) {
			const args =
				event.currentToolArgs !== undefined && event.currentToolArgs.trim().length > 0
					? ` ${event.currentToolArgs}`
					: "";
			this.#renderLine(`tool: ${event.currentTool}${args}`);
		}
		if (event.lastIntent !== undefined && event.lastIntent.trim().length > 0) {
			this.#renderLine(`intent: ${event.lastIntent}`);
		}
		for (const line of event.outputTail) {
			this.#renderLine(line);
		}
	}

	onResult(event: Extract<AttachEvent, { type: "follow_up_result" }>): void {
		if (!event.ok) this.#renderLine(`[result] error: ${event.error ?? "failed"}`);
		else if (event.payload === undefined) this.#renderLine("[result] ok");
		else
			this.#renderLine(
				`[result] ${typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}`,
			);
	}

	onError(error: AttachError): void {
		this.#renderLine(`[error] ${error.code}: ${error.message}`);
	}

	onRemoved(reason: string): void {
		this.#renderLine(`[removed] ${reason}`);
	}

	onBye(): void {
		this.#renderLine("[bye]");
	}

	/** Write one sanitized line, keeping the rolling window bounded. */
	#renderLine(text: string): void {
		const line = sanitizeAttachLine(text);
		if (line.length === 0) return;
		this.#renderedLines.push(line);
		if (this.#renderedLines.length > this.#maxRenderedLines) {
			this.#renderedLines.shift();
			if (!this.#trimMarkerPrinted) {
				this.#trimMarkerPrinted = true;
				this.#stdout.write(`${TRIM_MARKER}\n`);
			}
		}
		this.#stdout.write(`${line}\n`);
	}
}

/**
 * Interactive pane client for the attach substrate.
 *
 * Handshake: connect → `hello` (capability token) → `hello_ok` → `subscribe`
 * (worker id) → snapshot push. Afterwards the client forwards worker
 * state/summary, progress output, and follow-up results to the configured
 * {@link AttachView}, forwards each stdin line as a `follow_up` (queued while
 * one is in flight), pings to keep the connection alive, and reconnects with
 * backoff after unexpected disconnects. `removed`, a server `bye`, and
 * `auth_failed` are terminal (exit 0/0/1) and never reconnect.
 */
export class AttachClient {
	readonly #socketPath: string;
	readonly #token: string;
	readonly #workerId: string;
	readonly #view: AttachView;
	readonly #stdin: NodeJS.ReadableStream;
	readonly #pingIntervalMs: number;
	readonly #backoffMs: readonly number[];
	readonly #enableSignals: boolean;
	readonly #useReadline: boolean;
	readonly #onExit: ((code: number) => void) | undefined;

	#socket: net.Socket | null = null;
	#accumulator = new AttachFrameAccumulator();
	#authenticated = false;
	#ownerScope: string | null = null;
	#inFlightRef: string | null = null;
	#pendingFollowUps: string[] = [];
	#followUpCounter = 0;
	#pingTimer: ReturnType<typeof setInterval> | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempt = 0;
	#readline: Interface | null = null;
	#sigintHandler: (() => void) | null = null;
	#started = false;
	#exiting = false;
	#handshakeResolve: (() => void) | null = null;
	#handshakePromise: Promise<void> | null = null;
	#snapshotResolve: (() => void) | null = null;
	#snapshotPromise: Promise<void> | null = null;

	constructor(socketPath: string, token: string, workerId: string, options: AttachClientOptions = {}) {
		this.#socketPath = socketPath;
		this.#token = token;
		this.#workerId = workerId;
		this.#view =
			options.view ?? new AttachLineView({ stdout: options.stdout, maxRenderedLines: options.maxRenderedLines });
		this.#stdin = options.stdin ?? process.stdin;
		this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
		this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.#enableSignals = options.enableSignals ?? true;
		this.#useReadline = options.readline ?? true;
		this.#onExit = options.onExit;
	}

	/**
	 * Connect, authenticate, subscribe to the worker, and resolve once the
	 * `hello_ok` handshake and the subscribe snapshot push have completed (or
	 * the client exits early).
	 */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#handshakePromise = new Promise<void>(resolve => {
			this.#handshakeResolve = resolve;
		});
		this.#snapshotPromise = new Promise<void>(resolve => {
			this.#snapshotResolve = resolve;
		});
		this.#connect();
		if (this.#useReadline) this.#setupReadline();
		if (this.#enableSignals) {
			this.#sigintHandler = () => this.#handleSigint();
			process.on("SIGINT", this.#sigintHandler);
		}
		await this.#handshakePromise;
		await this.#snapshotPromise;
	}

	/** Shut the client down without invoking `onExit`. Idempotent. */
	stop(): void {
		if (!this.#started || this.#exiting) return;
		this.#exiting = true;
		this.#cleanup();
		this.#finishHandshake();
		this.#finishSnapshot();
	}

	#finishHandshake(): void {
		const resolve = this.#handshakeResolve;
		this.#handshakeResolve = null;
		resolve?.();
	}

	#finishSnapshot(): void {
		const resolve = this.#snapshotResolve;
		this.#snapshotResolve = null;
		resolve?.();
	}

	#connect(): void {
		this.#accumulator = new AttachFrameAccumulator();
		this.#authenticated = false;
		this.#view.onConnection?.(this.#reconnectAttempt > 0 ? "reconnecting" : "connecting");
		const socket = net.createConnection(this.#socketPath);
		this.#socket = socket;
		socket.on("connect", () => this.#onConnect());
		socket.on("data", (chunk: Buffer) => this.#onData(chunk));
		socket.on("error", () => this.#scheduleReconnect());
		socket.on("close", () => this.#onSocketClose());
	}

	#onConnect(): void {
		this.#send({
			kind: "hello",
			version: ATTACH_PROTOCOL_VERSION,
			capability: this.#token,
			client: { role: "pane", name: "omp-attach" },
		});
	}

	#onData(chunk: Buffer): void {
		let frames: Buffer[];
		try {
			frames = this.#accumulator.push(chunk);
		} catch (error) {
			this.#fatal(error);
			return;
		}
		for (const frame of frames) {
			let message: AttachMessage;
			try {
				message = decodeAttachLine(frame);
			} catch (error) {
				this.#fatal(error);
				return;
			}
			this.#handleMessage(message);
		}
	}

	/** A frame we cannot decode is a protocol violation: exit 1. */
	#fatal(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(`attach: protocol error: ${detail}\n`);
		this.#exit(1);
	}

	#onSocketClose(): void {
		if (this.#exiting) return;
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (this.#exiting || this.#reconnectTimer !== null) return;
		const index = Math.min(this.#reconnectAttempt, this.#backoffMs.length - 1);
		this.#reconnectAttempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#connect();
		}, this.#backoffMs[index]);
	}

	#handleMessage(message: AttachMessage): void {
		switch (message.kind) {
			case "hello_ok":
				this.#onHelloOk(message);
				return;
			case "snapshot":
				this.#onSnapshot(message.snapshot);
				return;
			case "event":
				this.#onEvent(message.event);
				return;
			case "pong":
				return;
			case "bye":
				this.#view.onBye?.();
				this.#exit(0);
				return;
			case "error":
				this.#onError(message);
				return;
		}
	}

	#onHelloOk(message: Extract<AttachMessage, { kind: "hello_ok" }>): void {
		this.#reconnectAttempt = 0;
		this.#authenticated = true;
		this.#view.onConnection?.("connected");
		this.#captureOwnerScope(message.snapshot);
		const entry = this.#findEntry(message.snapshot);
		if (entry) this.#view.onEntry?.(entry);
		this.#finishHandshake();
		if (this.#pingTimer === null) {
			this.#pingTimer = setInterval(() => this.#send({ kind: "ping" }), this.#pingIntervalMs);
		}
		this.#send({ kind: "subscribe", workerIds: [this.#workerId] });
		this.#flushPendingFollowUps();
	}

	#onSnapshot(snapshot: AttachSnapshot): void {
		this.#captureOwnerScope(snapshot);
		const entry = this.#findEntry(snapshot);
		if (entry) this.#view.onEntry?.(entry);
		this.#finishSnapshot();
	}

	#onEvent(event: AttachEvent): void {
		switch (event.type) {
			case "registered":
				if (event.key.workerId !== this.#workerId) return;
				if (this.#ownerScope === null) {
					this.#ownerScope = event.key.ownerScope;
					this.#flushPendingFollowUps();
				}
				this.#view.onEntry?.(event.entry);
				return;
			case "updated":
				if (event.key.workerId !== this.#workerId) return;
				this.#view.onEntry?.(event.entry);
				return;
			case "state":
				if (event.key.workerId !== this.#workerId) return;
				this.#view.onState?.(event.state);
				return;
			case "removed":
				if (event.key.workerId !== this.#workerId) return;
				this.#view.onRemoved?.(event.reason);
				this.#exit(0);
				return;
			case "follow_up_accepted":
				if (event.key.workerId !== this.#workerId) return;
				this.#view.onFollowUpAccepted?.(event.ref);
				return;
			case "follow_up_result":
				if (event.key.workerId !== this.#workerId) return;
				this.#inFlightRef = null;
				this.#view.onResult?.(event);
				this.#flushPendingFollowUps();
				return;
			case "abort_accepted":
				return;
			case "progress":
				if (event.key.workerId !== this.#workerId) return;
				this.#view.onProgress?.(event);
				return;
		}
	}

	#onError(error: AttachError): void {
		if (error.code === "auth_failed") {
			process.stderr.write(`attach: authentication failed: ${error.message}\n`);
			this.#exit(1);
			return;
		}
		this.#view.onError?.(error);
		if (error.ref !== undefined && error.ref === this.#inFlightRef) {
			this.#inFlightRef = null;
			// An error settled the in-flight follow-up (e.g. `unknown_worker`):
			// the slot is free again, so drain the client-side queue.
			this.#flushPendingFollowUps();
		}
	}

	#captureOwnerScope(snapshot: AttachSnapshot): void {
		if (this.#ownerScope !== null) return;
		const entry = this.#findEntry(snapshot);
		if (!entry) return;
		this.#ownerScope = entry.key.ownerScope;
		this.#flushPendingFollowUps();
	}

	#findEntry(snapshot: AttachSnapshot): AttachSessionEntry | undefined {
		return snapshot.sessions.find(
			entry =>
				entry.key.workerId === this.#workerId &&
				(this.#ownerScope === null || entry.key.ownerScope === this.#ownerScope),
		);
	}

	#setupReadline(): void {
		const readline = createInterface({ input: this.#stdin, terminal: this.#enableSignals });
		this.#readline = readline;
		readline.on("line", line => this.#onInputLine(line));
		if (this.#enableSignals) {
			readline.on("SIGINT", () => this.#handleSigint());
		}
	}

	#onInputLine(line: string): void {
		this.sendFollowUp(line);
	}

	/**
	 * Queue or send one follow-up prompt. While the worker is unknown, the
	 * connection is reconnecting, or another follow-up is in flight, the
	 * prompt is held and flushed in order once the slot is free. Used by both
	 * the readline line view and the fullscreen pane's composer.
	 */
	sendFollowUp(payload: string): void {
		if (payload.trim().length === 0) return;
		if (this.#ownerScope === null || !this.#authenticated || this.#inFlightRef !== null) {
			this.#pendingFollowUps.push(payload);
			return;
		}
		this.#sendFollowUp(payload);
	}

	#sendFollowUp(payload: string): void {
		this.#followUpCounter += 1;
		const ref = `f${this.#followUpCounter}`;
		this.#inFlightRef = ref;
		this.#send({ kind: "follow_up", ref, key: this.#followUpKey(), payload });
	}

	#flushPendingFollowUps(): void {
		while (this.#pendingFollowUps.length > 0 && this.#inFlightRef === null && this.#authenticated) {
			const payload = this.#pendingFollowUps.shift();
			if (payload === undefined) return;
			this.#sendFollowUp(payload);
		}
	}

	#followUpKey(): AttachWorkerKey {
		return { workerId: this.#workerId, ownerScope: this.#ownerScope ?? "" };
	}

	/**
	 * Cancel the in-flight follow-up (if any), send a polite `bye`, and exit
	 * 0. Used by the SIGINT handler and by the fullscreen pane's Ctrl-C on an
	 * empty draft.
	 */
	interrupt(): void {
		this.#handleSigint();
	}

	#handleSigint(): void {
		if (this.#exiting) return;
		if (this.#inFlightRef !== null && this.#ownerScope !== null) {
			this.#send({ kind: "abort", key: this.#followUpKey() });
		}
		this.#send({ kind: "bye" });
		this.#exit(0);
	}

	#send(message: AttachClientMessage): void {
		if (this.#socket === null || this.#socket.destroyed) return;
		this.#socket.write(encodeAttachMessage(message));
	}

	#exit(code: number): void {
		if (this.#exiting) return;
		this.#exiting = true;
		this.#cleanup();
		this.#finishHandshake();
		this.#finishSnapshot();
		this.#view.onExit?.(code);
		this.#onExit?.(code);
	}

	#cleanup(): void {
		if (this.#pingTimer !== null) {
			clearInterval(this.#pingTimer);
			this.#pingTimer = null;
		}
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		if (this.#readline !== null) {
			this.#readline.close();
			this.#readline = null;
		}
		if (this.#sigintHandler !== null) {
			process.removeListener("SIGINT", this.#sigintHandler);
			this.#sigintHandler = null;
		}
		if (this.#socket !== null) {
			const socket = this.#socket;
			this.#socket = null;
			socket.destroy();
		}
		this.#authenticated = false;
	}
}
