/**
 * attach/client.ts — interactive pane client for the local worker-attach substrate.
 *
 * v2 client flow:
 *
 *   connect → hello { version: 2, role: "pane" } → hello_ok
 *           → view_open { key, resume? } → view_open_ok { lease, epoch } | view_open_rejected
 *           → transcript_begin / items* / end   (snapshot epoch)
 *           → event transcript_append*          (live additions)
 *           → event progress/updated/state/removed/…
 *   prompt { lease, cmdSeq, cmdId, ref, text }  → prompt_accepted | control_rejected
 *                                             → prompt_result { ref, cmdId, ok, payload? }
 *   abort_turn { lease, cmdSeq, cmdId }          (never exits; never kills the worker)
 *   detach { lease, reason? }                    → bye, close (restores terminal)
 *
 * Reconnect: the client keeps the last granted lease (id + proof + generation)
 * and resumes it within the server's disconnect grace — the SAME pane instance
 * reclaims its controller. A fresh view_open (no resume) is issued when the
 * lease expired and nobody else took it; `lease_busy` means another pane now
 * controls the worker and is terminal. Every reconnect replays the transcript
 * from a fresh snapshot epoch — no terminal-byte recovery. An in-flight prompt
 * survives the disconnect: its full frame is kept and replayed unchanged (same
 * cmdId/cmdSeq/ref) once the view reopens so the server's acknowledgement cache
 * settles it exactly once. Prompts queued while disconnected or mid-snapshot
 * are held until the snapshot epoch's transcript_end before flushing.
 *
 * Plain submissions become leased control intents with a client-monotonic
 * command sequence and a random idempotency key; locally queued rapid
 * submissions retain their order (one in flight per worker).
 */

import * as net from "node:net";
import { createInterface, type Interface } from "node:readline";
import {
	ATTACH_PROTOCOL_VERSION,
	type AttachAbortTurn,
	type AttachClientMessage,
	type AttachControlRejected,
	type AttachError,
	type AttachEvent,
	AttachFrameAccumulator,
	type AttachLease,
	type AttachMessage,
	type AttachPrompt,
	type AttachPromptResult,
	type AttachSessionEntry,
	type AttachTranscriptAppend,
	type AttachTranscriptBegin,
	type AttachTranscriptEnd,
	type AttachTranscriptItems,
	type AttachTranscriptReset,
	type AttachViewOpenOk,
	type AttachViewOpenRejected,
	type AttachWorkerState,
	decodeAttachLine,
	encodeAttachMessage,
	generateAttachCmdId,
} from "./protocol";

/** Options for {@link AttachClient}; every field is injectable for tests. */
export interface AttachClientOptions {
	/** Rendering surface (defaults to the line view). */
	view?: AttachView;
	/** Input stream (defaults to process.stdin). */
	stdin?: NodeJS.ReadableStream;
	/** Output stream for the default line view (defaults to process.stdout). */
	stdout?: NodeJS.WritableStream;
	/** Rolling render window for the default line view. */
	maxRenderedLines?: number;
	/** Keepalive ping interval (ms). */
	pingIntervalMs?: number;
	/**
	 * Max time to wait for the server `bye` after {@link AttachClient.detach}
	 * before exiting locally (ms). Bounds a stalled peer that never replies.
	 */
	detachTimeoutMs?: number;
	/** Reconnect delays (ms). */
	backoffMs?: readonly number[];
	/** Install SIGINT handling. */
	enableSignals?: boolean;
	/** Wrap stdin in readline (line mode). Disable for fullscreen TUIs. */
	readline?: boolean;
	/** Terminal exit callback. */
	onExit?: (code: number) => void;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [200, 500, 1000, 2000, 5000];

/** Fallback bound for waiting on the server `bye` after `detach()` (ms). */
const DEFAULT_DETACH_TIMEOUT_MS = 2000;

const MAX_RENDERED_LINE_LENGTH = 200;

/** Marker emitted when a bounded render window first drops earlier output. */
export const TRIM_MARKER = "[trimmed: earlier output dropped]";

/**
 * Sanitize one rendered line: strip ANSI escape sequences and control
 * characters, then cap the length. Every line written to stdout goes through
 * this so a worker can never inject terminal escapes or unbounded output.
 */
export function sanitizeAttachLine(text: string, maxLength = MAX_RENDERED_LINE_LENGTH): string {
	const clean = text
		.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}

/** Connection phase reported to views: first attempt, authenticated, or reconnecting. */
export type AttachViewConnection = "connecting" | "connected" | "reconnecting";

/** Outcome of a view_open (granted lease or rejection). */
export type AttachViewOpenOutcome =
	| { ok: true; lease: AttachLease; epoch: number; cwd?: string; entry: AttachSessionEntry }
	| { ok: false; rejection: AttachViewOpenRejected };

/**
 * Rendering surface driven by {@link AttachClient}. The transport calls these
 * callbacks as frames arrive; views decide how to render (lines, fullscreen
 * TUI, tests).
 */
export interface AttachView {
	onConnection?(connection: AttachViewConnection): void;
	onEntry?(entry: AttachSessionEntry): void;
	onState?(state: AttachWorkerState): void;
	onViewOpen?(outcome: AttachViewOpenOutcome): void;
	onTranscriptBegin?(frame: AttachTranscriptBegin): void;
	onTranscriptItems?(frame: AttachTranscriptItems): void;
	onTranscriptEnd?(frame: AttachTranscriptEnd): void;
	onTranscriptAppend?(frame: AttachTranscriptAppend): void;
	onTranscriptReset?(frame: AttachTranscriptReset): void;
	/** Coalesced live progress: tool / intent / output tail. */
	onProgress?(event: Extract<AttachEvent, { type: "progress" }>): void;
	/** The server accepted the prompt with the given ref. */
	onPromptAccepted?(ref: string): void;
	/** A prompt settled with a result (or an error payload). */
	onPromptResult?(event: AttachPromptResult): void;
	/** A control frame was rejected (lease/sequence/idempotency/busy). */
	onControlRejected?(rejection: AttachControlRejected): void;
	/** A protocol-level error arrived. */
	onError?(error: AttachError): void;
	/** The worker was removed; the client exits 0 immediately after. */
	onRemoved?(reason: string): void;
	/** The server sent a polite `bye`; the client exits 0 immediately after. */
	onBye?(reason?: string): void;
	/** The client terminated itself with the given code. */
	onExit?(code: number): void;
}

/**
 * Default line-oriented view: writes bounded sanitized lines to a writable
 * stream, keeping a rolling window that emits `TRIM_MARKER` once when it
 * first overflows. Byte-compatible with the v1 line rendering so existing
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

	onViewOpen(outcome: AttachViewOpenOutcome): void {
		if (!outcome.ok) {
			this.#renderLine(`[view] rejected: ${outcome.rejection.code}: ${outcome.rejection.message}`);
		}
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

	onPromptResult(event: AttachPromptResult): void {
		if (!event.ok) this.#renderLine(`[result] error: ${event.error ?? "failed"}`);
		else if (event.payload === undefined) this.#renderLine("[result] ok");
		else
			this.#renderLine(
				`[result] ${typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}`,
			);
	}

	onControlRejected(rejection: AttachControlRejected): void {
		this.#renderLine(`[control] ${rejection.code}: ${rejection.message}`);
	}

	onError(error: AttachError): void {
		this.#renderLine(`[error] ${error.code}: ${error.message}`);
	}

	onRemoved(reason: string): void {
		this.#renderLine(`[removed] ${reason}`);
	}

	onBye(reason?: string): void {
		this.#renderLine(reason !== undefined && reason.length > 0 ? `[bye] ${reason}` : "[bye]");
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
 * Interactive pane client for the attach substrate (protocol v2).
 *
 * Handshake: connect → `hello` (capability token) → `hello_ok` → `view_open`
 * (with resume when a lease is held) → `view_open_ok` → transcript snapshot
 * epoch, then live events. The client forwards worker state/summary, progress
 * output, transcript frames, and prompt results to the configured
 * {@link AttachView}, forwards each submitted prompt as a leased `prompt`
 * control (queued while one is in flight), pings to keep the connection
 * alive, and reconnects with backoff after unexpected disconnects (resuming
 * its lease within the grace window). `removed`, a server `bye`, `auth_failed`
 * and `lease_busy` are terminal and never reconnect.
 */
export class AttachClient {
	readonly #socketPath: string;
	readonly #token: string;
	readonly #workerId: string;
	readonly #ownerScope: string;
	readonly #view: AttachView;
	readonly #stdin: NodeJS.ReadableStream;
	readonly #pingIntervalMs: number;
	readonly #backoffMs: readonly number[];
	readonly #detachTimeoutMs: number;
	readonly #enableSignals: boolean;
	readonly #useReadline: boolean;
	readonly #onExit: ((code: number) => void) | undefined;

	#socket: net.Socket | null = null;
	#accumulator = new AttachFrameAccumulator();
	#authenticated = false;
	#inFlightRef: string | null = null;
	/** Full frame of the in-flight prompt; replayed unchanged on reconnect. */
	#inFlightFrame: AttachPrompt | null = null;
	#pendingPrompts: string[] = [];
	#promptCounter = 0;
	#cmdSeq = 0;
	#pingTimer: NodeJS.Timeout | null = null;
	#reconnectTimer: NodeJS.Timeout | null = null;
	#detachTimer: NodeJS.Timeout | null = null;
	#detaching = false;
	#reconnectAttempt = 0;
	#readline: Interface | null = null;
	#sigintHandler: (() => void) | null = null;
	#started = false;
	#exiting = false;
	#handshakeResolve: (() => void) | null = null;
	#handshakePromise: Promise<void> | null = null;
	#viewOpenResolve: (() => void) | null = null;
	#viewOpenPromise: Promise<void> | null = null;
	/** Current lease granted by the server (resumed across reconnects). */
	#lease: AttachLease | null = null;
	#epoch = 0;
	/** Expected transcript sequence within the current epoch. */
	#expectedSeq = 0;
	/** Whether we have transcript frames in flight (initial snapshot pending). */
	#snapshotPending = false;

	constructor(socketPath: string, token: string, workerId: string, options: AttachClientOptions = {}) {
		this.#socketPath = socketPath;
		this.#token = token;
		this.#workerId = workerId;
		this.#ownerScope = "";
		this.#view =
			options.view ?? new AttachLineView({ stdout: options.stdout, maxRenderedLines: options.maxRenderedLines });
		this.#stdin = options.stdin ?? process.stdin;
		this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
		this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.#detachTimeoutMs = options.detachTimeoutMs ?? DEFAULT_DETACH_TIMEOUT_MS;
		this.#enableSignals = options.enableSignals ?? true;
		this.#useReadline = options.readline ?? true;
		this.#onExit = options.onExit;
	}

	/**
	 * Connect, authenticate, open the worker view, and resolve once the
	 * `view_open` has settled (or the client exits early).
	 */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#handshakePromise = new Promise<void>(resolve => {
			this.#handshakeResolve = resolve;
		});
		this.#viewOpenPromise = new Promise<void>(resolve => {
			this.#viewOpenResolve = resolve;
		});
		this.#connect();
		if (this.#useReadline) this.#setupReadline();
		if (this.#enableSignals) {
			this.#sigintHandler = () => this.#handleSigint();
			process.on("SIGINT", this.#sigintHandler);
		}
		await this.#handshakePromise;
		await this.#viewOpenPromise;
	}

	/** Shut the client down without invoking `onExit`. Idempotent. */
	stop(): void {
		if (!this.#started || this.#exiting) return;
		this.#exiting = true;
		this.#cleanup();
		this.#finishHandshake();
		this.#finishViewOpen();
	}

	#finishHandshake(): void {
		const resolve = this.#handshakeResolve;
		this.#handshakeResolve = null;
		resolve?.();
	}

	#finishViewOpen(): void {
		const resolve = this.#viewOpenResolve;
		this.#viewOpenResolve = null;
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
		// The connection is gone: drop the live send path immediately so a
		// submission during the reconnect backoff is queued instead of being
		// silently dropped through a destroyed socket.
		this.#socket = null;
		this.#authenticated = false;
		if (this.#exiting) return;
		if (this.#detaching) {
			// `bye` can never arrive on a dead socket; the server observed the
			// close and releases the lease through its disconnect path.
			this.#exit(0);
			return;
		}
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
				this.#onHelloOk();
				return;
			case "view_open_ok":
				this.#onViewOpenOk(message);
				return;
			case "view_open_rejected":
				this.#onViewOpenRejected(message);
				return;
			case "transcript_begin":
				this.#onTranscriptBegin(message);
				return;
			case "transcript_items":
				this.#onTranscriptItems(message);
				return;
			case "transcript_end":
				this.#onTranscriptEnd(message);
				return;
			case "transcript_append":
				this.#onTranscriptAppend(message);
				return;
			case "transcript_reset":
				this.#onTranscriptReset(message);
				return;
			case "prompt_accepted":
				this.#view.onPromptAccepted?.(message.ref);
				return;
			case "prompt_result":
				this.#onPromptResult(message);
				return;
			case "control_rejected":
				this.#onControlRejected(message);
				return;
			case "snapshot":
				return;
			case "event":
				this.#onEvent(message.event);
				return;
			case "pong":
				return;
			case "bye":
				this.#view.onBye?.("reason" in message ? message.reason : undefined);
				this.#exit(0);
				return;
			case "error":
				this.#onError(message);
				return;
		}
	}

	#onHelloOk(): void {
		this.#reconnectAttempt = 0;
		this.#authenticated = true;
		this.#view.onConnection?.("connected");
		this.#finishHandshake();
		if (this.#pingTimer === null) {
			this.#pingTimer = setInterval(() => this.#send({ kind: "ping" }), this.#pingIntervalMs);
		}
		// Open (or resume) the worker view. A held lease is presented as resume
		// so the same pane instance reclaims its controller across reconnects.
		this.#send({
			kind: "view_open",
			key: { workerId: this.#workerId, ownerScope: this.#ownerScope },
			...(this.#lease !== null && {
				resume: {
					leaseId: this.#lease.leaseId,
					proof: this.#lease.proof,
					generation: this.#lease.generation,
				},
			}),
		});
	}

	#onViewOpenOk(message: AttachViewOpenOk): void {
		this.#lease = message.lease;
		this.#epoch = message.epoch;
		this.#expectedSeq = 0;
		this.#snapshotPending = true;
		this.#view.onViewOpen?.({
			ok: true,
			lease: message.lease,
			epoch: message.epoch,
			cwd: message.cwd,
			entry: message.entry,
		});
		this.#view.onEntry?.(message.entry);
		this.#finishViewOpen();
		// A reconnect resumed the view while a prompt was in flight: resend the
		// persisted frame with the SAME cmdId/cmdSeq/ref/text so the server's
		// acknowledgement cache settles it (never executing it twice),
		// refreshing only the lease fields to the just-granted (resumed) lease
		// so the server's generation validation accepts the replay.
		if (this.#inFlightFrame !== null && this.#lease !== null) {
			const lease = this.#lease;
			this.#send({
				...this.#inFlightFrame,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
			});
		}
		// New queued prompts are NOT flushed here: they stay gated on the
		// snapshot epoch and flush at the matching transcript_end.
	}

	#onViewOpenRejected(message: AttachViewOpenRejected): void {
		this.#view.onViewOpen?.({ ok: false, rejection: message });
		if (message.code === "lease_busy") {
			process.stderr.write(
				`attach: worker is controlled by another pane client${message.holder ? ` (lease frees in ~${Math.ceil(message.holder.expiresInMs / 1000)}s)` : ""}\n`,
			);
			this.#exit(1);
			return;
		}
		if (message.code === "unknown_worker") {
			process.stderr.write(`attach: unknown worker: ${message.message}\n`);
			this.#exit(1);
			return;
		}
		if (message.code === "stale_resume") {
			// Our lease expired without another client taking it: open a fresh
			// view (a new lease is granted). Only try this once per rejection.
			this.#lease = null;
			this.#send({ kind: "view_open", key: { workerId: this.#workerId, ownerScope: this.#ownerScope } });
			return;
		}
		this.#exit(1);
	}

	#expectTranscriptFrame(message: { epoch: number; seq: number }): boolean {
		if (message.epoch !== this.#epoch) return false;
		const expected = this.#expectedSeq + 1;
		if (message.seq !== expected) return false;
		this.#expectedSeq = message.seq;
		return true;
	}

	#onTranscriptBegin(message: AttachTranscriptBegin): void {
		if (!this.#expectTranscriptFrame(message)) {
			this.#protocolViolation(`transcript_begin out of order (epoch ${message.epoch} seq ${message.seq})`);
			return;
		}
		this.#view.onTranscriptBegin?.(message);
	}

	#onTranscriptItems(message: AttachTranscriptItems): void {
		if (!this.#expectTranscriptFrame(message)) {
			this.#protocolViolation(`transcript_items out of order (epoch ${message.epoch} seq ${message.seq})`);
			return;
		}
		this.#view.onTranscriptItems?.(message);
	}

	#onTranscriptEnd(message: AttachTranscriptEnd): void {
		if (!this.#expectTranscriptFrame(message)) {
			this.#protocolViolation(`transcript_end out of order (epoch ${message.epoch} seq ${message.seq})`);
			return;
		}
		this.#snapshotPending = false;
		this.#view.onTranscriptEnd?.(message);
		// The snapshot epoch completed: flush prompts that were queued while
		// the transcript was being (re)played.
		this.#flushPendingPrompts();
	}

	#onTranscriptAppend(message: AttachTranscriptAppend): void {
		if (!this.#expectTranscriptFrame(message)) {
			this.#protocolViolation(`transcript_append out of order (epoch ${message.epoch} seq ${message.seq})`);
			return;
		}
		this.#view.onTranscriptAppend?.(message);
	}

	#onTranscriptReset(message: AttachTranscriptReset): void {
		// A reset is a boundary marker: it may arrive at ANY point in the
		// epoch (a live branch switch between snapshot frames). Validate the
		// epoch only, then resync the sequence expectation to the reset's seq
		// so the fresh snapshot's frames are monotonic from here.
		if (message.epoch !== this.#epoch) {
			this.#protocolViolation(`transcript_reset out of order (epoch ${message.epoch} seq ${message.seq})`);
			return;
		}
		this.#expectedSeq = message.seq;
		// A reset is always followed by a fresh snapshot within the epoch:
		// gate queued prompts again until that snapshot's transcript_end.
		this.#snapshotPending = true;
		this.#view.onTranscriptReset?.(message);
	}

	/** Stale epoch/sequence frames mean the view was superseded: DESTROY the
	 *  offending socket first (its frames must never keep arriving while the
	 *  reconnect replays from a fresh snapshot epoch), then reconnect. */
	#protocolViolation(detail: string): void {
		process.stderr.write(`attach: protocol violation (${detail}); reconnecting\n`);
		if (this.#socket !== null && !this.#socket.destroyed) {
			this.#socket.destroy();
			this.#socket = null;
		}
		this.#scheduleReconnect();
	}

	#onPromptResult(message: AttachPromptResult): void {
		this.#clearInFlight();
		this.#view.onPromptResult?.(message);
		this.#flushPendingPrompts();
	}

	#onControlRejected(message: AttachControlRejected): void {
		this.#view.onControlRejected?.(message);
		// A ref-carrying rejection settled the in-flight prompt: the slot is
		// free again, so drain the client-side queue.
		if (message.ref !== undefined && (this.#inFlightRef === null || message.ref === this.#inFlightRef)) {
			this.#clearInFlight();
			this.#flushPendingPrompts();
		}
	}

	#onEvent(event: AttachEvent): void {
		switch (event.type) {
			case "registered":
				if (event.key.workerId !== this.#workerId) return;
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
			case "follow_up_result":
				return;
			case "abort_accepted":
				return;
			case "lease_granted":
			case "lease_expired":
			case "lease_revoked":
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
			// An error settled the in-flight prompt (e.g. `unknown_worker`):
			// the slot is free again, so drain the client-side queue.
			this.#clearInFlight();
			this.#flushPendingPrompts();
		}
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
		this.sendPrompt(line);
	}

	/**
	 * Queue or send one prompt. While the view is not yet open, the connection
	 * is reconnecting, or another prompt is in flight, the prompt is held and
	 * flushed in order once the slot is free. Used by both the readline line
	 * view and the fullscreen pane's composer.
	 */
	sendPrompt(text: string): void {
		if (text.trim().length === 0) return;
		if (
			this.#lease === null ||
			!this.#authenticated ||
			this.#inFlightRef !== null ||
			this.#snapshotPending ||
			this.#socket === null ||
			this.#socket.destroyed
		) {
			this.#pendingPrompts.push(text);
			return;
		}
		this.#sendPrompt(text);
	}

	#sendPrompt(text: string): void {
		this.#promptCounter += 1;
		const ref = `p${this.#promptCounter}`;
		this.#cmdSeq += 1;
		const frame: AttachPrompt = {
			kind: "prompt",
			key: { workerId: this.#workerId, ownerScope: this.#ownerScope },
			leaseId: this.#lease!.leaseId,
			proof: this.#lease!.proof,
			generation: this.#lease!.generation,
			cmdSeq: this.#cmdSeq,
			cmdId: generateAttachCmdId(),
			ref,
			text,
		};
		this.#inFlightRef = ref;
		this.#inFlightFrame = frame;
		this.#send(frame);
	}

	/** The in-flight prompt settled: free the slot and drop its persisted frame. */
	#clearInFlight(): void {
		this.#inFlightRef = null;
		this.#inFlightFrame = null;
	}

	#flushPendingPrompts(): void {
		while (
			this.#pendingPrompts.length > 0 &&
			this.#inFlightRef === null &&
			!this.#snapshotPending &&
			this.#authenticated &&
			this.#lease !== null &&
			this.#socket !== null &&
			!this.#socket.destroyed
		) {
			const text = this.#pendingPrompts.shift();
			if (text === undefined) return;
			this.#sendPrompt(text);
		}
	}

	/**
	 * Cancel the in-flight turn for the worker (abort-current-turn). Never
	 * kills the worker and never closes the view; the pane stays attached.
	 */
	abortTurn(): void {
		if (this.#exiting || this.#lease === null || !this.#authenticated) return;
		this.#cmdSeq += 1;
		const frame: AttachAbortTurn = {
			kind: "abort_turn",
			key: { workerId: this.#workerId, ownerScope: this.#ownerScope },
			leaseId: this.#lease.leaseId,
			proof: this.#lease.proof,
			generation: this.#lease.generation,
			cmdSeq: this.#cmdSeq,
			cmdId: generateAttachCmdId(),
		};
		this.#send(frame);
	}

	/**
	 * Detach: release the controller lease and close the view. The server
	 * replies `bye`; the client waits for it and exits 0, so the detach frame
	 * is definitely processed (lease released) before the socket is torn down.
	 * A bounded fallback timer covers a stalled peer that never replies. Does
	 * NOT abort or kill the worker — the worker keeps running.
	 */
	detach(reason?: string): void {
		if (this.#exiting || this.#detaching) return;
		if (this.#lease === null || !this.#authenticated) {
			this.#exit(0);
			return;
		}
		this.#detaching = true;
		this.#send({
			kind: "detach",
			key: { workerId: this.#workerId, ownerScope: this.#ownerScope },
			leaseId: this.#lease.leaseId,
			proof: this.#lease.proof,
			generation: this.#lease.generation,
			reason,
		});
		this.#detachTimer = setTimeout(() => {
			this.#detachTimer = null;
			this.#exit(0);
		}, this.#detachTimeoutMs);
	}

	/**
	 * Legacy alias kept for tests: same as {@link sendPrompt}.
	 */
	sendFollowUp(payload: string): void {
		this.sendPrompt(payload);
	}

	#handleSigint(): void {
		if (this.#exiting) return;
		// v2 semantics: Ctrl-C aborts the in-flight turn; the pane stays open.
		this.abortTurn();
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
		this.#finishViewOpen();
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
		if (this.#detachTimer !== null) {
			clearTimeout(this.#detachTimer);
			this.#detachTimer = null;
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
