/**
 * attach/client.ts — interactive pane client for the local worker-attach substrate.
 *
 * Connects to the attach server over a Unix socket, authenticates with the
 * capability token, subscribes to a single worker, renders worker state and
 * live output as bounded sanitized lines, and forwards each stdin line as a
 * follow-up. Every I/O surface is injectable so the client is fully testable
 * without a TTY or a real server.
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
	/** Invoked with the exit code when the client terminates itself. */
	readonly onExit?: (code: number) => void;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [200, 500, 1000, 2000, 5000];

const MAX_RENDERED_LINE_LENGTH = 200;

const TRIM_MARKER = "[trimmed: earlier output dropped]";

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

/**
 * Interactive pane client for the attach substrate.
 *
 * Handshake: connect → `hello` (capability token) → `hello_ok` → `subscribe`
 * (worker id) → snapshot push. Afterwards the client renders worker
 * state/summary, progress output, and follow-up results as bounded sanitized
 * lines, forwards each stdin line as a `follow_up`, pings to keep the
 * connection alive, and reconnects with backoff after unexpected disconnects.
 * `removed`, a server `bye`, and `auth_failed` are terminal (exit 0/0/1) and
 * never reconnect.
 */
export class AttachClient {
	readonly #socketPath: string;
	readonly #token: string;
	readonly #workerId: string;
	readonly #stdout: NodeJS.WritableStream;
	readonly #stdin: NodeJS.ReadableStream;
	readonly #pingIntervalMs: number;
	readonly #backoffMs: readonly number[];
	readonly #maxRenderedLines: number;
	readonly #enableSignals: boolean;
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
	#renderedLines: string[] = [];
	#trimMarkerPrinted = false;
	#handshakeResolve: (() => void) | null = null;
	#handshakePromise: Promise<void> | null = null;
	#snapshotResolve: (() => void) | null = null;
	#snapshotPromise: Promise<void> | null = null;

	constructor(socketPath: string, token: string, workerId: string, options: AttachClientOptions = {}) {
		this.#socketPath = socketPath;
		this.#token = token;
		this.#workerId = workerId;
		this.#stdout = options.stdout ?? process.stdout;
		this.#stdin = options.stdin ?? process.stdin;
		this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
		this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.#maxRenderedLines = options.maxRenderedLines ?? 500;
		this.#enableSignals = options.enableSignals ?? true;
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
		this.#setupReadline();
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
				this.#renderLine("[bye]");
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
		this.#captureOwnerScope(message.snapshot);
		const entry = this.#findEntry(message.snapshot);
		if (entry) this.#renderEntry(entry);
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
		if (entry) this.#renderEntry(entry);
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
				this.#renderEntry(event.entry);
				return;
			case "updated":
				if (event.key.workerId !== this.#workerId) return;
				this.#renderEntry(event.entry);
				return;
			case "state":
				if (event.key.workerId !== this.#workerId) return;
				this.#renderLine(`[${event.state}]`);
				return;
			case "removed":
				if (event.key.workerId !== this.#workerId) return;
				this.#renderLine(`[removed] ${event.reason}`);
				this.#exit(0);
				return;
			case "follow_up_accepted":
				return;
			case "follow_up_result":
				if (event.key.workerId !== this.#workerId) return;
				this.#inFlightRef = null;
				this.#renderLine(this.#formatResult(event));
				this.#flushPendingFollowUps();
				return;
			case "abort_accepted":
				return;
			case "progress":
				if (event.key.workerId !== this.#workerId) return;
				this.#renderProgress(event);
				return;
		}
	}

	#formatResult(event: Extract<AttachEvent, { type: "follow_up_result" }>): string {
		if (!event.ok) return `[result] error: ${event.error ?? "failed"}`;
		if (event.payload === undefined) return "[result] ok";
		const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
		return `[result] ${payload}`;
	}

	#renderProgress(event: Extract<AttachEvent, { type: "progress" }>): void {
		if (event.currentTool !== undefined) {
			this.#renderLine(`tool: ${event.currentTool}${event.currentToolArgs ? ` ${event.currentToolArgs}` : ""}`);
		}
		if (event.lastIntent !== undefined) {
			this.#renderLine(`intent: ${event.lastIntent}`);
		}
		for (const line of event.outputTail) {
			this.#renderLine(line);
		}
	}

	#renderEntry(entry: AttachSessionEntry): void {
		const summary = entry.summary !== null && entry.summary.length > 0 ? ` ${entry.summary}` : "";
		this.#renderLine(`[${entry.state}]${summary}`);
	}

	#onError(error: AttachError): void {
		if (error.code === "auth_failed") {
			process.stderr.write(`attach: authentication failed: ${error.message}\n`);
			this.#exit(1);
			return;
		}
		this.#renderLine(`[error] ${error.code}: ${error.message}`);
		if (error.ref !== undefined && error.ref === this.#inFlightRef) {
			this.#inFlightRef = null;
		}
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
		if (line.trim().length === 0) return;
		if (this.#ownerScope === null || !this.#authenticated) {
			// The worker may not be registered yet (or we are reconnecting):
			// hold the line and send it once we know where it belongs.
			this.#pendingFollowUps.push(line);
			return;
		}
		this.#sendFollowUp(line);
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
