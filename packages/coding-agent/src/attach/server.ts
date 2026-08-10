/**
 * attach/server.ts — 0600 Unix-socket server for the local worker-attach substrate.
 *
 * Serves one owner scope (one root session's worker universe) on a single Unix
 * domain socket. Conventions deliberately mirror the launch broker
 * (`launch/broker.ts`): 0700 runtime dir, 0600 token file, 0600 socket via
 * `chmod` after `listen`, newline-delimited JSON frames with a hard byte cap,
 * and token authentication on every frame.
 *
 * Security:
 * - The runtime dir is 0700 and the socket file is chmod'd 0600, so the OS
 *   only lets the same UID connect. A connection that is not a Unix socket is
 *   destroyed immediately.
 * - Authentication is strict hello-first: the first frame MUST be a `hello`
 *   carrying the capability from the 0600 token file. Any other first frame
 *   gets `error { code: "hello_required" }` and the connection is destroyed.
 *   A wrong capability gets `error { code: "auth_failed" }` and is destroyed.
 * - The capability lives only in memory and in the 0600 token file; it is
 *   never written to argv, env, logs, or session transcripts.
 *
 * Backpressure and lifecycle:
 * - Inbound frames are bounded by `AttachFrameAccumulator` (fails fast above
 *   `ATTACH_MAX_FRAME_BYTES`).
 * - Outbound messages go through a per-connection `AttachBoundedQueue`; when
 *   a slow client exceeds the caps the connection is dropped.
 * - Detach/disconnect only tears down client subscriptions; it NEVER unregisters
 *   or kills a worker. Unregistration happens exclusively through the harness
 *   kill/teardown paths (`registry.unregister`).
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	ATTACH_HELLO_TIMEOUT_MS,
	ATTACH_PROTOCOL_VERSION,
	ATTACH_RUNTIME_DIR_MODE,
	ATTACH_SOCKET_MODE,
	ATTACH_TOKEN_FILE_MODE,
	AttachBoundedQueue,
	type AttachClientInfo,
	type AttachClientMessage,
	type AttachError,
	type AttachEvent,
	type AttachFollowUp,
	AttachFrameAccumulator,
	type AttachHello,
	type AttachMessage,
	AttachProtocolError,
	type AttachServerMessage,
	type AttachSnapshot,
	type AttachSubscribe,
	type AttachWorkerKey,
	decodeAttachLine,
	encodeAttachMessage,
	formatAttachKey,
	generateAttachCapability,
	isHelloMessage,
	shrinkAttachSnapshot,
} from "./protocol";
import { type AttachRegistry, attachKeyString, parseAttachKeyString } from "./registry";

/** Default basename of the attach socket inside the runtime dir. */
export const ATTACH_SOCKET_FILE = "attach.sock";
/** Default basename of the capability token file inside the runtime dir. */
export const ATTACH_TOKEN_FILE = "attach.token";

export interface AttachServerOptions {
	/** 0700 directory holding the socket + token files. */
	runtimeDir: string;
	/** Owner scope this server exposes (root session id / workspace). */
	ownerScope: string;
	/** Registry whose entries are served and whose events are streamed. */
	registry: AttachRegistry;
	/** Token file path override (defaults to `<runtimeDir>/attach.token`). */
	tokenFile?: string;
	/** Socket path override (defaults to `<runtimeDir>/attach.sock`). */
	socketFile?: string;
	/** Hello deadline override (ms). Tests shorten this. */
	helloTimeoutMs?: number;
}

interface AttachClientSubscription {
	/** Explicit worker-id allowlist; `undefined` = all ids. */
	workerIds?: Set<string>;
	/** Explicit owner-scope allowlist; `undefined` = all scopes. */
	ownerScopes?: Set<string>;
}

/**
 * One authenticated connection. Owns the inbound frame accumulator, the
 * outbound bounded queue, and the subscription filter used for event fan-out.
 */
class AttachClientConnection {
	readonly id: string;
	readonly socket: net.Socket;
	readonly client: AttachClientInfo;
	/** Post-auth role/name, promoted from the authenticated hello. */
	role: "pane" | "director";
	name: string | undefined;
	readonly accumulator = new AttachFrameAccumulator();
	readonly queue = new AttachBoundedQueue<Buffer>(frame => frame.byteLength);
	/** Worker keys this client is currently attached to (for counts + cleanup). */
	readonly attachedKeys = new Set<string>();
	subscription: AttachClientSubscription = {};
	/** True once the client authenticated with `subscribe` or sent `subscribe`. */
	subscribed = false;
	helloTimeout: NodeJS.Timeout | undefined;
	destroyed = false;

	constructor(id: string, socket: net.Socket, client: AttachClientInfo) {
		this.id = id;
		this.socket = socket;
		this.client = client;
		this.role = client.role;
		this.name = client.name;
	}

	/** True when the subscription filter covers `key`. */
	matches(key: AttachWorkerKey): boolean {
		const sub = this.subscription;
		if (sub.workerIds !== undefined && !sub.workerIds.has(key.workerId)) return false;
		if (sub.ownerScopes !== undefined && !sub.ownerScopes.has(key.ownerScope)) return false;
		return true;
	}

	/** Destroy the socket and release the hello timer, idempotently. */
	close(): void {
		this.destroyed = true;
		clearTimeout(this.helloTimeout);
		this.helloTimeout = undefined;
		this.socket.destroy();
	}
}

let connectionCounter = 0;

/**
 * Local worker-attach server. One instance per owner scope; binds a 0600 Unix
 * socket, authenticates hello-first, and streams registry snapshots/events to
 * subscribed pane/director clients.
 */
export class AttachServer {
	readonly runtimeDir: string;
	readonly ownerScope: string;
	readonly #registry: AttachRegistry;
	readonly #tokenFile: string;
	readonly #socketFile: string;
	readonly #helloTimeoutMs: number;
	readonly #server = net.createServer(socket => this.#accept(socket));
	readonly #clients = new Map<string, AttachClientConnection>();
	#unsubscribe: (() => void) | undefined;
	#token: string | undefined;
	#startedAt = 0;
	#stopped = false;

	constructor(options: AttachServerOptions) {
		this.runtimeDir = options.runtimeDir;
		this.ownerScope = options.ownerScope;
		this.#registry = options.registry;
		this.#tokenFile = options.tokenFile ?? path.join(options.runtimeDir, ATTACH_TOKEN_FILE);
		this.#socketFile = options.socketFile ?? path.join(options.runtimeDir, ATTACH_SOCKET_FILE);
		this.#helloTimeoutMs = options.helloTimeoutMs ?? ATTACH_HELLO_TIMEOUT_MS;
		this.#server.on("error", error => this.#onServerError(error));
	}

	get startedAt(): number {
		return this.#startedAt;
	}

	get socketFile(): string {
		return this.#socketFile;
	}

	get tokenFile(): string {
		return this.#tokenFile;
	}

	/** Number of currently connected clients. */
	get clientCount(): number {
		return this.#clients.size;
	}

	/** Bind the socket, write the token file, and start accepting. */
	async start(): Promise<void> {
		if (process.platform === "win32") {
			throw new Error("Attach server requires a Unix socket; Windows is not supported");
		}
		this.#stopped = false;
		await fs.mkdir(this.runtimeDir, { recursive: true, mode: ATTACH_RUNTIME_DIR_MODE });
		await fs.chmod(this.runtimeDir, ATTACH_RUNTIME_DIR_MODE);
		this.#token = await this.#readOrCreateToken();
		await fs.rm(this.#socketFile, { force: true });
		const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
		this.#server.once("listening", resolve);
		this.#server.once("error", reject);
		this.#server.listen(this.#socketFile);
		await listening;
		await fs.chmod(this.#socketFile, ATTACH_SOCKET_MODE);
		this.#startedAt = Date.now();
		// (Re)subscribe on every start so a restarted server (parent rehydrate)
		// keeps streaming registry events; the previous subscription was released
		// by stop().
		this.#unsubscribe?.();
		this.#unsubscribe = this.#registry.subscribe(event => this.#onRegistryEvent(event));
		logger.debug("attach server listening", {
			socket: this.#socketFile,
			ownerScope: this.ownerScope,
		});
	}

	/** Close the server, drop all clients, and remove socket + token files. */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const client of this.#clients.values()) {
			this.#detachAll(client);
			client.close();
		}
		this.#clients.clear();
		if (this.#server.listening) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
		await fs.rm(this.#socketFile, { force: true });
		await fs.rm(this.#tokenFile, { force: true });
		logger.debug("attach server stopped", { ownerScope: this.ownerScope });
	}

	/**
	 * Persistent error handling for the accept server: a post-listen failure
	 * (e.g. EMFILE on a fresh connection) must degrade the server instead of
	 * crashing the process. Startup races still surface through start()'s own
	 * once("error") rejection.
	 */
	#onServerError(error: Error): void {
		if (this.#startedAt === 0) return; // startup path: start() rejects itself
		logger.warn("attach server error; closing clients", {
			ownerScope: this.ownerScope,
			error: error.message,
		});
		for (const client of this.#clients.values()) {
			this.#detachAll(client);
			client.close();
		}
		this.#clients.clear();
		this.#startedAt = 0;
	}

	// -----------------------------------------------------------------------
	// Connection lifecycle
	// -----------------------------------------------------------------------

	#accept(socket: net.Socket): void {
		if (this.#stopped) {
			socket.destroy();
			return;
		}
		// getpeername exists at runtime on net.Socket but is missing from this
		// @types/node's declarations; the server only ever listens on a 0600 Unix
		// socket, so this is a defensive check against non-local transports.
		const getPeer = (socket as unknown as { getpeername?: () => { family?: string } }).getpeername;
		const peer = getPeer?.call(socket);
		if (peer && typeof peer === "object" && "family" in peer && peer.family !== "Unix") {
			socket.destroy();
			return;
		}
		const connection = new AttachClientConnection(`${process.pid}.${++connectionCounter}`, socket, {
			role: "pane",
			name: "pending-hello",
		});
		this.#clients.set(connection.id, connection);
		// Strict hello-first: the client has one window to authenticate.
		connection.helloTimeout = setTimeout(() => {
			this.#reject(connection, { kind: "error", code: "hello_required", message: "hello not received in time" });
			connection.close();
		}, this.#helloTimeoutMs);
		socket.on("data", (chunk: Buffer) => this.#onData(connection, chunk));
		socket.on("error", () => {
			// Closure performs accounting; keep the connection object until close.
		});
		socket.on("close", () => this.#onClose(connection));
	}

	#onData(connection: AttachClientConnection, chunk: Buffer): void {
		let frames: Buffer[];
		try {
			frames = connection.accumulator.push(chunk);
		} catch (error) {
			const code = error instanceof AttachProtocolError ? error.code : "internal";
			this.#reject(connection, {
				kind: "error",
				code,
				message: error instanceof Error ? error.message : String(error),
			});
			connection.close();
			return;
		}
		for (const frame of frames) {
			if (connection.destroyed) return;
			this.#handleFrame(connection, frame);
		}
	}

	#handleFrame(connection: AttachClientConnection, frame: Buffer): void {
		let message: AttachMessage;
		try {
			message = decodeAttachLine(frame);
		} catch (error) {
			const code = error instanceof AttachProtocolError ? error.code : "internal";
			this.#reject(connection, {
				kind: "error",
				code,
				message: error instanceof Error ? error.message : String(error),
			});
			connection.close();
			return;
		}
		if (connection.helloTimeout !== undefined) {
			// First frame must be hello.
			if (!isHelloMessage(message)) {
				this.#reject(connection, {
					kind: "error",
					code: "hello_required",
					message: `first frame must be hello, got "${message.kind}"`,
				});
				connection.close();
				return;
			}
			this.#handleHello(connection, message);
			return;
		}
		void this.#handleAuthenticated(connection, message as AttachClientMessage);
	}

	#handleHello(connection: AttachClientConnection, hello: AttachHello): void {
		clearTimeout(connection.helloTimeout);
		connection.helloTimeout = undefined;
		if (hello.version !== ATTACH_PROTOCOL_VERSION) {
			this.#reject(connection, {
				kind: "error",
				code: "protocol_version",
				message: `client version ${hello.version} != server version ${ATTACH_PROTOCOL_VERSION}`,
			});
			connection.close();
			return;
		}
		if (hello.capability !== this.#token) {
			this.#reject(connection, { kind: "error", code: "auth_failed", message: "bad capability" });
			connection.close();
			return;
		}
		connection.role = hello.client.role;
		connection.name = hello.client.name;
		if (hello.subscribe === true) {
			connection.subscription = {};
			connection.subscribed = true;
		}
		this.#send(connection, {
			kind: "hello_ok",
			version: ATTACH_PROTOCOL_VERSION,
			server: { pid: process.pid, startedAt: this.#startedAt },
			snapshot: this.#shrink(this.#registry.snapshot()),
		});
		if (hello.subscribe === true) {
			this.#attachToSnapshot(connection);
		}
	}

	async #handleAuthenticated(connection: AttachClientConnection, message: AttachClientMessage): Promise<void> {
		switch (message.kind) {
			case "hello":
				// Duplicate hello after a successful one: protocol violation.
				this.#reject(connection, { kind: "error", code: "hello_required", message: "duplicate hello" });
				connection.close();
				return;
			case "subscribe":
				this.#handleSubscribe(connection, message);
				return;
			case "follow_up":
				this.#handleFollowUp(connection, message);
				return;
			case "abort":
				this.#handleAbort(connection, message);
				return;
			case "ping":
				this.#send(connection, { kind: "pong", nonce: message.nonce });
				return;
			case "bye":
				this.#send(connection, { kind: "bye" });
				connection.close();
				return;
		}
	}

	#handleSubscribe(connection: AttachClientConnection, subscribe: AttachSubscribe): void {
		connection.subscription = {
			workerIds: subscribe.workerIds && subscribe.workerIds.length > 0 ? new Set(subscribe.workerIds) : undefined,
			ownerScopes:
				subscribe.ownerScopes && subscribe.ownerScopes.length > 0 ? new Set(subscribe.ownerScopes) : undefined,
		};
		connection.subscribed = true;
		this.#attachToSnapshot(connection);
		this.#send(connection, { kind: "snapshot", snapshot: this.#shrink(this.#registry.snapshot()) });
	}

	#handleFollowUp(connection: AttachClientConnection, followUp: AttachFollowUp): void {
		void this.#registry.followUp(followUp.key, followUp.ref, followUp.payload, followUp.timeoutMs).catch(error => {
			const message =
				error instanceof AttachProtocolError
					? error.message
					: error instanceof Error
						? error.message
						: String(error);
			const code = error instanceof AttachProtocolError ? error.code : "internal";
			this.#send(connection, { kind: "error", code, message, ref: followUp.ref });
		});
	}

	#handleAbort(_connection: AttachClientConnection, message: Extract<AttachClientMessage, { kind: "abort" }>): void {
		void this.#registry.abort(message.key, message.reason).catch(() => {
			// Abort is best-effort: a missing worker is already gone.
		});
	}

	#onClose(connection: AttachClientConnection): void {
		// Detach never kills workers: only subscription accounting is undone.
		this.#detachAll(connection);
		this.#clients.delete(connection.id);
	}

	// -----------------------------------------------------------------------
	// Registry event fan-out
	// -----------------------------------------------------------------------

	#onRegistryEvent(event: AttachEvent): void {
		for (const connection of this.#clients.values()) {
			// Fan-out and attachment accounting apply to subscribed clients only;
			// a plain hello (no subscribe) receives the initial snapshot and
			// nothing else.
			if (connection.helloTimeout !== undefined || !connection.subscribed) continue;
			if (!connection.matches(event.key)) continue;
			if (event.type === "registered") {
				connection.attachedKeys.add(attachKeyString(event.key));
				this.#registry.attach(event.key, connection.id);
			} else if (event.type === "removed") {
				connection.attachedKeys.delete(attachKeyString(event.key));
				this.#registry.detach(event.key, connection.id);
			}
			this.#send(connection, { kind: "event", event });
		}
	}

	/** Attach the client to every currently registered key its filter covers. */
	#attachToSnapshot(connection: AttachClientConnection): void {
		for (const entry of this.#registry.snapshot().sessions) {
			if (!connection.matches(entry.key)) continue;
			connection.attachedKeys.add(attachKeyString(entry.key));
			this.#registry.attach(entry.key, connection.id);
		}
	}

	/** Undo every attachment this client holds (disconnect / un-subscribe). */
	#detachAll(connection: AttachClientConnection): void {
		for (const keyString of connection.attachedKeys) {
			this.#registry.detach(parseAttachKeyString(keyString), connection.id);
		}
		connection.attachedKeys.clear();
	}

	// -----------------------------------------------------------------------
	// Outbound path
	// -----------------------------------------------------------------------

	#send(connection: AttachClientConnection, message: AttachServerMessage): void {
		if (connection.destroyed || connection.socket.destroyed) return;
		let frame: Buffer;
		try {
			frame = encodeAttachMessage(message);
		} catch (error) {
			logger.warn("attach server failed to encode outbound frame", {
				kind: message.kind,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!connection.queue.enqueue(frame)) {
			// Backpressure: the client cannot keep up; drop the connection.
			logger.debug("attach server dropping slow client", { client: connection.id });
			this.#reject(connection, { kind: "error", code: "internal", message: "outbound queue overflow" });
			connection.close();
			return;
		}
		this.#flush(connection);
	}

	#flush(connection: AttachClientConnection): void {
		const socket = connection.socket;
		for (;;) {
			if (connection.destroyed || socket.destroyed) return;
			const frame = connection.queue.dequeue();
			if (frame === undefined) return;
			const canContinue = socket.write(frame);
			if (!canContinue) {
				// Wait for drain, then continue flushing; the queue is bounded so
				// a client that never drains is dropped by #send on the next push.
				socket.once("drain", () => this.#flush(connection));
				return;
			}
		}
	}

	#reject(connection: AttachClientConnection, error: AttachError): void {
		try {
			const frame = encodeAttachMessage(error);
			if (!connection.socket.destroyed) connection.socket.write(frame);
		} catch {
			// Peer is gone or frame is malformed; nothing more to say.
		}
	}

	#shrink(snapshot: AttachSnapshot): AttachSnapshot {
		return shrinkAttachSnapshot(snapshot);
	}

	async #readOrCreateToken(): Promise<string> {
		try {
			const existing = (await fs.readFile(this.#tokenFile, "utf8")).trim();
			if (existing.length > 0) {
				await fs.chmod(this.#tokenFile, ATTACH_TOKEN_FILE_MODE);
				return existing;
			}
		} catch {
			// Missing or unreadable: create below.
		}
		const token = generateAttachCapability();
		await fs.writeFile(this.#tokenFile, token, { mode: ATTACH_TOKEN_FILE_MODE });
		await fs.chmod(this.#tokenFile, ATTACH_TOKEN_FILE_MODE);
		return token;
	}
}

export { formatAttachKey };
