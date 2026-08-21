/**
 * attach/server.ts — 0600 Unix-socket server for the local worker-attach substrate.
 *
 * v2 additions on top of the v1 hello-first auth + bounded framing:
 *
 * - `view_open` acquires the worker's controller lease atomically
 *   (reject-not-replace) and starts a transcript view: the server subscribes
 *   to the worker's live session presentation source BEFORE building the
 *   snapshot, so nothing between subscribe and snapshot can be lost, then
 *   streams the initial transcript (begin/items/end) and flushes buffered
 *   live additions as `transcript_append`. Every transcript frame carries the
 *   view epoch + a monotonic per-view sequence; a reconnect always starts a
 *   fresh epoch, and stale epoch/sequence frames are protocol errors.
 * - `prompt`/`abort_turn` frames are lease-validated, sequence-checked, and
 *   idempotent via the registry's bounded command cache; `detach` explicitly
 *   releases the lease (never aborts the worker).
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { extractSessionMessages } from "../modes/presentation/shared-transcript";
import type { SessionMessageEntry } from "../session/session-entries";
import {
	ATTACH_HELLO_TIMEOUT_MS,
	ATTACH_PROTOCOL_VERSION,
	ATTACH_RUNTIME_DIR_MODE,
	ATTACH_SOCKET_MODE,
	ATTACH_TOKEN_FILE_MODE,
	type AttachAbortTurn,
	AttachBoundedQueue,
	type AttachClientInfo,
	type AttachClientMessage,
	type AttachControlRejected,
	type AttachDetach,
	type AttachError,
	type AttachEvent,
	type AttachFollowUp,
	AttachFrameAccumulator,
	type AttachHello,
	type AttachLease,
	type AttachMessage,
	type AttachPrompt,
	AttachProtocolError,
	type AttachServerMessage,
	type AttachSnapshot,
	type AttachSubscribe,
	type AttachViewOpen,
	type AttachWorkerKey,
	boundAttachTranscriptItems,
	decodeAttachLine,
	encodeAttachMessage,
	formatAttachKey,
	generateAttachCapability,
	isAttachCapability,
	isHelloMessage,
	shrinkAttachSnapshot,
} from "./protocol";
import { type AttachClaimPromptResult, type AttachRegistry, attachKeyString, parseAttachKeyString } from "./registry";

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

/** Per-view transcript feed state (epoch-scoped, per connection). */
interface AttachViewTranscriptState {
	branchId: string;
	sentIds: Set<string>;
	seq: number;
	unsubscribe: (() => void) | null;
}

/**
 * One authenticated connection. Owns the inbound frame accumulator, the
 * outbound bounded queue, the subscription filter used for event fan-out, and
 * (for pane clients) the controller view: lease + epoch + transcript feed.
 */
class AttachClientConnection {
	readonly id: string;
	readonly socket: net.Socket;
	readonly client: AttachClientInfo;
	/** Post-auth role/name, promoted from the authenticated hello. */
	role: "pane" | "director" | "observer";
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
	/** Controller view (pane clients after a successful view_open). */
	view: { key: AttachWorkerKey; lease: AttachLease; epoch: number; cwd: string } | null = null;
	/** Transcript feed state for the view. */
	transcript: AttachViewTranscriptState | null = null;
	/** Highest accepted client command sequence for the current view. */
	lastCmdSeq = 0;

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
		if (this.destroyed) return;
		logger.debug("attach: closing connection", { id: this.id, reason: this.closeReason ?? "unspecified" });
		this.destroyed = true;
		clearTimeout(this.helloTimeout);
		this.helloTimeout = undefined;
		this.socket.destroy();
	}

	/** Why this connection is being closed (set right before close()). */
	closeReason: string | undefined;
}

let connectionCounter = 0;
let epochCounter = 0;

/**
 * Local worker-attach server. One instance per owner scope; binds a 0600 Unix
 * socket, authenticates hello-first, and streams registry snapshots/events to
 * subscribed pane/director/observer clients.
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
			this.#releaseView(client, "server stopped");
			// Polite bye FIRST: a live pane client must exit 0 (its exit poll
			// then closes the owned pane) instead of reconnecting into a dead
			// socket forever.
			this.#send(client, { kind: "bye", reason: "server stopped" });
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
			this.#releaseView(client, "server error");
			this.#send(client, { kind: "bye", reason: "server error" });
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
		logger.debug("attach: connection accepted", { id: connection.id });
		this.#clients.set(connection.id, connection);
		// Strict hello-first: the client has one window to authenticate.
		connection.helloTimeout = setTimeout(() => {
			this.#reject(connection, { kind: "error", code: "hello_required", message: "hello not received in time" });
			connection.closeReason = "hello timeout";
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
			connection.closeReason = "undecodable frame";
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
			connection.closeReason = "undecodable frame";
			connection.close();
			return;
		}
		// Log only decoded non-secret metadata — never raw frame bytes (hello
		// carries the capability in the first ~60 bytes).
		logger.debug("attach: inbound frame", {
			id: connection.id,
			kind: message.kind,
			authenticated: connection.helloTimeout === undefined,
		});
		if (connection.helloTimeout !== undefined) {
			// First frame must be hello.
			if (!isHelloMessage(message)) {
				this.#reject(connection, {
					kind: "error",
					code: "hello_required",
					message: `first frame must be hello, got "${message.kind}"`,
				});
				connection.closeReason = "first frame not hello";
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
			connection.closeReason = "protocol version mismatch";
			connection.close();
			return;
		}
		if (hello.capability !== this.#token) {
			this.#reject(connection, { kind: "error", code: "auth_failed", message: "bad capability" });
			connection.closeReason = "auth failed";
			connection.close();
			return;
		}
		connection.role = hello.client.role;
		connection.name = hello.client.name;
		this.#send(connection, {
			kind: "hello_ok",
			version: ATTACH_PROTOCOL_VERSION,
			server: { pid: process.pid, startedAt: this.#startedAt },
			snapshot: this.#shrink(this.#registry.snapshot()),
		});
	}

	async #handleAuthenticated(connection: AttachClientConnection, message: AttachClientMessage): Promise<void> {
		switch (message.kind) {
			case "hello":
				// Duplicate hello after a successful one: protocol violation.
				this.#reject(connection, { kind: "error", code: "hello_required", message: "duplicate hello" });
				connection.closeReason = "duplicate hello";
				connection.close();
				return;
			case "view_open":
				this.#handleViewOpen(connection, message);
				return;
			case "prompt":
				await this.#handlePrompt(connection, message);
				return;
			case "abort_turn":
				this.#handleAbortTurn(connection, message);
				return;
			case "detach":
				this.#handleDetach(connection, message);
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
				connection.closeReason = "client bye";
				connection.close();
				return;
		}
	}

	// -----------------------------------------------------------------------
	// v2: view_open / controller lease / transcript feed
	// -----------------------------------------------------------------------

	#handleViewOpen(connection: AttachClientConnection, viewOpen: AttachViewOpen): void {
		if (connection.role !== "pane") {
			this.#reject(connection, {
				kind: "error",
				code: "internal",
				message: "view_open is only valid for pane clients",
			});
			connection.closeReason = "view_open non-pane";
			connection.close();
			return;
		}
		if (connection.view) {
			// Re-opening a view on the same connection: release the old view
			// first (the client already detached its previous lease).
			this.#releaseView(connection, "re-opened view");
		}
		// This server is scoped to exactly one owner scope, so an empty
		// ownerScope from the client means "this server's scope" (the pane
		// client derives the worker id only).
		const key: AttachWorkerKey =
			viewOpen.key.ownerScope === "" ? { ...viewOpen.key, ownerScope: this.ownerScope } : viewOpen.key;
		const resume = viewOpen.resume;
		const acquired = this.#registry.acquireView(key, connection.id, resume);
		if (!acquired.ok) {
			const holder = acquired.holder ?? this.#registry.leaseInfo(key);
			this.#send(connection, {
				kind: "view_open_rejected",
				key,
				code: acquired.code,
				message: acquired.message,
				holder,
			});
			return;
		}
		const source = this.#registry.liveSession(key);
		const epoch = ++epochCounter;
		const cwd = source?.getCwd() ?? "";
		connection.view = {
			key,
			lease: acquired.lease,
			epoch,
			cwd,
		};
		connection.lastCmdSeq = 0;
		// Subscribe the connection to its worker's broadcast events.
		connection.subscription = {
			workerIds: new Set([key.workerId]),
			ownerScopes: new Set([key.ownerScope]),
		};
		connection.subscribed = true;
		// Attachment accounting so the entry's attachedClients count is live.
		connection.attachedKeys.add(attachKeyString(key));
		this.#registry.attach(key, connection.id);
		// Start the transcript feed BEFORE the snapshot so nothing appended
		// between subscribe and snapshot is lost: the subscribe callback below
		// is synchronous until the first listener() call, and the snapshot is
		// read after it is registered.
		const entry = this.#registry.snapshot().sessions.find(e => attachKeyString(e.key) === attachKeyString(key));
		this.#send(connection, {
			kind: "view_open_ok",
			key,
			lease: acquired.lease,
			epoch,
			entry: entry ?? this.#fallbackEntry(key),
			cwd: cwd || undefined,
		});
		this.#beginTranscriptFeed(connection);
	}

	/** Entry for a worker that vanished between acquire and snapshot (rare). */
	#fallbackEntry(key: AttachWorkerKey): {
		key: AttachWorkerKey;
		state: "starting";
		createdAt: number;
		updatedAt: number;
		lastActivityAt: null;
		pendingFollowUps: 0;
		attachedClients: 1;
		summary: null;
	} {
		const now = Date.now();
		return {
			key,
			state: "starting",
			createdAt: now,
			updatedAt: now,
			lastActivityAt: null,
			pendingFollowUps: 0,
			attachedClients: 1,
			summary: null,
		};
	}

	/** Subscribe to the worker's live session source and send the snapshot. */
	#beginTranscriptFeed(connection: AttachClientConnection): void {
		const view = connection.view;
		if (!view) return;
		const source = this.#registry.liveSession(view.key);
		if (!source) {
			// No live session (worker's session not materialized yet): emit an
			// EMPTY snapshot boundary for the current epoch (monotonic seq,
			// watermark 0) so the client's prompt gate opens, then park an
			// empty feed state; #onRegistryEvent re-syncs (transcript_reset +
			// fresh snapshot) when the worker's session materializes.
			logger.debug("attach feed: source not materialized yet", { key: formatAttachKey(view.key) });
			const state: AttachViewTranscriptState = {
				branchId: "",
				sentIds: new Set(),
				seq: 0,
				unsubscribe: null,
			};
			connection.transcript = state;
			this.#send(connection, { kind: "transcript_begin", key: view.key, epoch: view.epoch, seq: ++state.seq });
			this.#send(connection, {
				kind: "transcript_end",
				key: view.key,
				epoch: view.epoch,
				seq: ++state.seq,
				watermark: 0,
			});
			return;
		}
		const state: AttachViewTranscriptState = {
			branchId: source.branchId,
			sentIds: new Set(),
			seq: 0,
			unsubscribe: null,
		};
		connection.transcript = state;
		state.unsubscribe = source.subscribe(() => this.#syncTranscript(connection));
		// Snapshot AFTER subscribing: events that fired during the subscribe
		// are covered by the re-sync below (the branch is read fresh).
		this.#syncTranscript(connection);
	}

	/**
	 * Re-sync the view's transcript: detect branch switches (reset + fresh
	 * snapshot), then send any entries not yet delivered as live appends.
	 */
	#syncTranscript(connection: AttachClientConnection): void {
		const view = connection.view;
		if (!view || connection.destroyed) return;
		const source = this.#registry.liveSession(view.key);
		if (!source) {
			return;
		}
		const entries = extractSessionMessages(source.getBranchEntries());
		const state = connection.transcript;
		if (!state || state.branchId !== source.branchId) {
			// Branch switched/rotated — or the parked empty feed (empty
			// boundary, no source yet) now has a live source: subscribe when
			// the feed was parked, then discard and re-snapshot in the same
			// epoch.
			const fresh: AttachViewTranscriptState = {
				branchId: source.branchId,
				sentIds: new Set(),
				seq: 0,
				unsubscribe: state?.unsubscribe ?? source.subscribe(() => this.#syncTranscript(connection)),
			};
			connection.transcript = fresh;
			this.#send(connection, {
				kind: "transcript_reset",
				key: view.key,
				epoch: view.epoch,
				seq: ++fresh.seq,
				reason: "transcript branch switched",
			});
			this.#sendTranscriptSnapshot(connection, fresh, entries);
			return;
		}
		const fresh = entries.filter(entry => !state.sentIds.has(entry.id));
		if (fresh.length === 0) return;
		this.#sendTranscriptAppend(connection, state, fresh);
	}

	/** Initial snapshot: begin → bounded items chunks → end. */
	#sendTranscriptSnapshot(
		connection: AttachClientConnection,
		state: AttachViewTranscriptState,
		entries: readonly SessionMessageEntry[],
	): void {
		const view = connection.view;
		if (!view) return;
		this.#send(connection, { kind: "transcript_begin", key: view.key, epoch: view.epoch, seq: ++state.seq });
		for (const chunk of this.#boundTranscriptChunks(connection, entries, "transcript_items")) {
			this.#send(connection, {
				kind: "transcript_items",
				key: view.key,
				epoch: view.epoch,
				seq: ++state.seq,
				items: chunk,
			});
		}
		for (const entry of entries) state.sentIds.add(entry.id);
		this.#send(connection, {
			kind: "transcript_end",
			key: view.key,
			epoch: view.epoch,
			seq: ++state.seq,
			watermark: state.sentIds.size,
		});
	}

	/** Live additions since the last sync, chunked. */
	#sendTranscriptAppend(
		connection: AttachClientConnection,
		state: AttachViewTranscriptState,
		entries: readonly SessionMessageEntry[],
	): void {
		const view = connection.view;
		if (!view) return;
		for (const chunk of this.#boundTranscriptChunks(connection, entries, "transcript_append")) {
			this.#send(connection, {
				kind: "transcript_append",
				key: view.key,
				epoch: view.epoch,
				seq: ++state.seq,
				items: chunk,
				watermark: state.sentIds.size,
			});
		}
		for (const entry of entries) state.sentIds.add(entry.id);
		this.#send(connection, {
			kind: "transcript_end",
			key: view.key,
			epoch: view.epoch,
			seq: ++state.seq,
			watermark: state.sentIds.size,
		});
	}

	/** Release the view's lease + transcript subscription (detach/shutdown/close). */
	#releaseView(connection: AttachClientConnection, reason: string): void {
		const view = connection.view;
		if (!view) return;
		const state = connection.transcript;
		if (state?.unsubscribe) {
			state.unsubscribe();
			state.unsubscribe = null;
		}
		connection.transcript = null;
		this.#registry.releaseView(view.key, connection.id, view.lease.proof, reason);
		connection.view = null;
		connection.lastCmdSeq = 0;
	}

	// -----------------------------------------------------------------------
	// v2: controller commands (lease + sequence + idempotency)
	// -----------------------------------------------------------------------

	#validateControl(
		connection: AttachClientConnection,
		message: AttachPrompt | AttachAbortTurn,
	): AttachControlRejected | null {
		const view = connection.view;
		if (!view) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "lease_required",
				message: "no controller view open for this worker",
			};
		}
		// Same empty-ownerScope normalization as view_open.
		const messageKey: AttachWorkerKey =
			message.key.ownerScope === "" ? { ...message.key, ownerScope: this.ownerScope } : message.key;
		if (attachKeyString(view.key) !== attachKeyString(messageKey)) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "foreign_client",
				message: "view is for a different worker",
			};
		}
		if (message.leaseId !== view.lease.leaseId) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "stale_lease",
				message: "lease id does not match the current view",
			};
		}
		if (message.proof !== view.lease.proof) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "foreign_client",
				message: "lease proof does not match",
			};
		}
		if (message.generation !== view.lease.generation) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "stale_generation",
				message: `lease generation ${message.generation} is stale; current is ${view.lease.generation}`,
			};
		}
		if (message.cmdSeq <= connection.lastCmdSeq) {
			return {
				kind: "control_rejected",
				key: message.key,
				cmdId: message.cmdId,
				code: "out_of_order",
				message: `command sequence ${message.cmdSeq} is not newer than ${connection.lastCmdSeq}`,
			};
		}
		return null;
	}

	#rejectControl(connection: AttachClientConnection, rejection: AttachControlRejected): void {
		this.#send(connection, rejection);
	}

	async #handlePrompt(connection: AttachClientConnection, prompt: AttachPrompt): Promise<void> {
		const rejection = this.#validateControl(connection, prompt);
		if (rejection) {
			this.#rejectControl(connection, rejection);
			return;
		}
		const key: AttachWorkerKey =
			prompt.key.ownerScope === "" ? { ...prompt.key, ownerScope: this.ownerScope } : prompt.key;
		const cached = this.#registry.cachedCommand(key, prompt.cmdId);
		if (cached) {
			// Reconnect replay after the command settled: deliver the cached
			// outcome without executing it again.
			this.#send(connection, { kind: "prompt_accepted", key, ref: prompt.ref, cmdId: prompt.cmdId });
			this.#send(connection, {
				kind: "prompt_result",
				key,
				ref: prompt.ref,
				cmdId: prompt.cmdId,
				ok: cached.ok,
				payload: cached.payload,
				error: cached.error,
			});
			return;
		}
		// Claim (or join) the worker's active prompt slot by command identity:
		// the same cmdId while the original run is still in flight JOINS the
		// shared outcome; a different command stays busy.
		let claim: AttachClaimPromptResult;
		try {
			claim = this.#registry.claimPrompt(key, prompt.cmdId, prompt.text, prompt.timeoutMs);
		} catch (error) {
			// Unknown worker (registry entry vanished mid-view): settle as a
			// failed prompt, matching the pre-claim runPrompt contract.
			const failed = { ok: false, error: error instanceof Error ? error.message : String(error) };
			this.#registry.rememberCommand(key, prompt.cmdId, failed);
			this.#send(connection, { kind: "prompt_accepted", key, ref: prompt.ref, cmdId: prompt.cmdId });
			this.#send(connection, {
				kind: "prompt_result",
				key,
				ref: prompt.ref,
				cmdId: prompt.cmdId,
				...failed,
			});
			return;
		}
		if (claim.status === "busy") {
			this.#rejectControl(connection, {
				kind: "control_rejected",
				key,
				cmdId: prompt.cmdId,
				ref: prompt.ref,
				code: "busy",
				message: "a prompt is already in flight for this worker",
			});
			return;
		}
		// Started and joined both deliver prompt_accepted now; only a started
		// command advances this connection's command sequence (a joined replay
		// is idempotent — re-sending it must keep joining, never re-run).
		if (claim.status === "started") connection.lastCmdSeq = prompt.cmdSeq;
		this.#send(connection, { kind: "prompt_accepted", key, ref: prompt.ref, cmdId: prompt.cmdId });
		const result = await claim.outcome;
		this.#send(connection, {
			kind: "prompt_result",
			key,
			ref: prompt.ref,
			cmdId: prompt.cmdId,
			ok: result.ok,
			payload: result.payload,
			error: result.error,
		});
	}

	#handleAbortTurn(connection: AttachClientConnection, abortTurn: AttachAbortTurn): void {
		const rejection = this.#validateControl(connection, abortTurn);
		if (rejection) {
			this.#rejectControl(connection, rejection);
			return;
		}
		// Same empty-ownerScope normalization as view_open/prompt: the client
		// derives the worker id only, so the abort key must be resolved to this
		// server's scope before the registry (which registered the worker under
		// the real scope) can find the entry. Without this, abort() misses the
		// entry and the abort silently never fires.
		const key: AttachWorkerKey =
			abortTurn.key.ownerScope === "" ? { ...abortTurn.key, ownerScope: this.ownerScope } : abortTurn.key;
		if (this.#registry.cachedCommand(key, abortTurn.cmdId)) {
			// Reconnect replay of an accepted abort: idempotent by construction.
			return;
		}
		connection.lastCmdSeq = abortTurn.cmdSeq;
		void this.#registry.abort(key, "pane abort").then(() => {
			this.#registry.rememberCommand(key, abortTurn.cmdId, { ok: true });
		});
	}

	#handleDetach(connection: AttachClientConnection, detach: AttachDetach): void {
		// Detach has no cmdSeq/cmdId: validate the lease directly.
		const view = connection.view;
		if (!view) {
			this.#rejectControl(connection, {
				kind: "control_rejected",
				key: detach.key,
				code: "lease_required",
				message: "no controller view open for this worker",
			});
			return;
		}
		const messageKey: AttachWorkerKey =
			detach.key.ownerScope === "" ? { ...detach.key, ownerScope: this.ownerScope } : detach.key;
		if (
			attachKeyString(view.key) !== attachKeyString(messageKey) ||
			detach.leaseId !== view.lease.leaseId ||
			detach.proof !== view.lease.proof ||
			detach.generation !== view.lease.generation
		) {
			this.#rejectControl(connection, {
				kind: "control_rejected",
				key: detach.key,
				code: detach.leaseId !== view.lease.leaseId ? "stale_lease" : "stale_generation",
				message: "lease does not match the current view",
			});
			return;
		}
		this.#releaseView(connection, `client detach: ${detach.reason ?? "user"}`);
		this.#send(connection, { kind: "bye", reason: detach.reason ?? "detached" });
		connection.closeReason = "detach";
		connection.close();
	}

	// -----------------------------------------------------------------------
	// v1 director/observer subscribe path
	// -----------------------------------------------------------------------

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
		if (connection.role === "observer") {
			this.#rejectControl(connection, {
				kind: "control_rejected",
				key: followUp.key,
				ref: followUp.ref,
				code: "forbidden",
				message: "observer clients are read-only",
			});
			return;
		}
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

	#handleAbort(connection: AttachClientConnection, message: Extract<AttachClientMessage, { kind: "abort" }>): void {
		if (connection.role === "observer") {
			// Observers are read-only subscribers; they hold no controller
			// lease and must not cancel a worker's in-flight turn (same
			// boundary as follow_up).
			this.#rejectControl(connection, {
				kind: "control_rejected",
				key: message.key,
				code: "forbidden",
				message: "observer clients are read-only",
			});
			return;
		}
		void this.#registry.abort(message.key, message.reason).catch(() => {
			// Abort is best-effort: a missing worker is already gone.
		});
	}

	#onClose(connection: AttachClientConnection): void {
		logger.debug("attach: connection closed", { id: connection.id, hadView: connection.view !== null });
		if (connection.view) {
			// Disconnect: keep the lease for the bounded grace so the SAME
			// client instance can resume; detach accounting now.
			const view = connection.view;
			const state = connection.transcript;
			if (state?.unsubscribe) {
				state.unsubscribe();
				state.unsubscribe = null;
			}
			connection.transcript = null;
			this.#registry.beginGrace(view.key, connection.id);
			connection.view = null;
			connection.lastCmdSeq = 0;
		}
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
			// a plain hello (no subscribe/view) receives hello_ok and nothing else.
			if (connection.helloTimeout !== undefined || !connection.subscribed) continue;
			if (!connection.matches(event.key)) continue;
			// A viewer whose worker session materialized late starts its feed now.
			if (connection.view && attachKeyString(connection.view.key) === attachKeyString(event.key)) {
				const state = connection.transcript;
				if (state && state.unsubscribe === null && this.#registry.liveSession(connection.view.key) !== null) {
					// The empty boundary already opened the client's prompt
					// gate; re-syncing now hits the parked branchId mismatch
					// ("") and emits transcript_reset + a fresh snapshot while
					// installing the live subscription.
					this.#syncTranscript(connection);
				}
			}
			if (event.type === "registered") {
				connection.attachedKeys.add(attachKeyString(event.key));
				this.#registry.attach(event.key, connection.id);
			} else if (event.type === "removed") {
				connection.attachedKeys.delete(attachKeyString(event.key));
				this.#registry.detach(event.key, connection.id);
				// A viewer's worker vanished: tear the feed down (the client
				// exits on the removed event itself).
				if (connection.view && attachKeyString(connection.view.key) === attachKeyString(event.key)) {
					const state = connection.transcript;
					if (state?.unsubscribe) {
						state.unsubscribe();
						state.unsubscribe = null;
					}
					connection.transcript = null;
					connection.view = null;
				}
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

	/**
	 * Bound transcript entries into chunks that each fit a single encoded
	 * frame. On a protocol-level violation (an entry too large to ever
	 * transmit, even after bounding) the connection is failed explicitly
	 * instead of emitting an oversized frame or crashing the sync callback.
	 */
	#boundTranscriptChunks(
		connection: AttachClientConnection,
		entries: readonly SessionMessageEntry[],
		kind: "transcript_items" | "transcript_append",
	): readonly (readonly SessionMessageEntry[])[] {
		const view = connection.view;
		if (!view) return [];
		try {
			return boundAttachTranscriptItems(entries, { kind, key: view.key, epoch: view.epoch });
		} catch (error) {
			logger.warn("attach server cannot fit transcript entries into a frame", {
				kind,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#reject(connection, {
				kind: "error",
				code: "internal",
				message: "transcript entry exceeds protocol frame limits",
			});
			connection.closeReason = "transcript frame overflow";
			connection.close();
			return [];
		}
	}

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
			// Never drop a frame silently: a missing transcript seq makes the
			// client's epoch unresolvable and reconnects forever. Fail the
			// connection explicitly instead.
			this.#reject(connection, {
				kind: "error",
				code: "internal",
				message: "outbound frame exceeds protocol limits",
			});
			connection.closeReason = "encode failure";
			connection.close();
			return;
		}
		if (!connection.queue.enqueue(frame)) {
			// Backpressure: the client cannot keep up; drop the connection.
			logger.debug("attach server dropping slow client", { client: connection.id });
			this.#reject(connection, { kind: "error", code: "internal", message: "outbound queue overflow" });
			connection.closeReason = "queue overflow";
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
			if (isAttachCapability(existing)) {
				await fs.chmod(this.#tokenFile, ATTACH_TOKEN_FILE_MODE);
				return existing;
			}
		} catch {
			// Missing or unreadable: create below.
		}
		// Invalid/truncated/corrupt content (or missing file): mint a fresh
		// 64-char lowercase hex capability and replace the token file.
		const token = generateAttachCapability();
		await fs.writeFile(this.#tokenFile, token, { mode: ATTACH_TOKEN_FILE_MODE });
		await fs.chmod(this.#tokenFile, ATTACH_TOKEN_FILE_MODE);
		return token;
	}
}

export { formatAttachKey };
