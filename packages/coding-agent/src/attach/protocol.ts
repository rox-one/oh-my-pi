/**
 * attach/protocol.ts — typed JSON-line wire protocol for the local worker-attach substrate.
 *
 * Transport: one Unix domain socket per owner scope. Every message is a single
 * line of JSON, newline (`\n`) terminated, decoded into a discriminated union.
 *
 * Security model
 * --------------
 * - Transport is local-only by construction: one Unix domain socket per owner
 *   scope inside a 0700 runtime directory. The socket file is created 0600 and
 *   the capability token file 0600 — both owned by the current UID, so access
 *   is restricted to that UID by filesystem permissions. There is no peer
 *   credential / UID inspection on the wire; the 0700/0600 filesystem layer is
 *   the same-UID guarantee.
 * - Authentication is strict hello-first: the FIRST frame a client sends MUST be
 *   `hello` carrying the random capability. No other message kind is processed
 *   before a successful hello. A failed hello closes the connection immediately.
 * - The capability is 256 bits of CSPRNG output, kept ONLY in the in-memory
 *   server and in a 0600 token file. It MUST never be placed in argv, env,
 *   logs, session transcripts, or any other observable surface.
 *
 * Framing and backpressure
 * ------------------------
 * - Frames are bounded: `ATTACH_MAX_FRAME_BYTES` (1 MiB) per line. The decoder
 *   and `AttachFrameAccumulator` fail fast on oversized frames instead of
 *   buffering without bound.
 * - Writes go through a bounded queue (`AttachBoundedQueue`): when a slow
 *   client pushes the queue past its high-water mark the server drops the
 *   connection rather than buffering unboundedly. `detach`/disconnect never
 *   kills the worker — only the client subscription is torn down.
 *
 * Lifecycle
 * ---------
 *   client -> hello             server -> hello_ok { snapshot } | error
 *   client -> subscribe         server -> snapshot (matching scope) then `event`*
 *   client -> follow_up         server -> event follow_up_accepted / follow_up_result
 *   client -> abort             server -> event abort_accepted
 *   client -> ping              server -> pong
 *   client -> bye               server -> bye, then close
 *
 * Follow-ups are serialized per worker: only one in-flight follow-up per
 * `AttachWorkerKey`; a second one gets `error { code: "busy" }`. Abort is
 * always allowed and cancels the in-flight follow-up.
 *
 * Progress events are ADDITIVE: `event { type: "progress" }` was introduced
 * without a protocol version bump and carries only live activity hints
 * (`currentTool` / `currentToolArgs` / `lastIntent` / `outputTail`) that a
 * client may ignore. Every progress field is bounded at the sender
 * (see `sanitizeAttachProgress`); older clients that do not recognize the
 * type simply skip it.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current wire protocol version. Bumped only on breaking wire changes. */
export const ATTACH_PROTOCOL_VERSION = 1 as const;

/** Frame delimiter: one JSON object per line. */
export const ATTACH_FRAME_DELIMITER = 0x0a; // '\n'

/** Upper bound for a single encoded frame (JSON + delimiter), in bytes. */
export const ATTACH_MAX_FRAME_BYTES = 1 << 20; // 1 MiB

/** Capability entropy, in bytes (256 bits). */
export const ATTACH_CAPABILITY_BYTES = 32;

/** Capability serialized length in hex characters. */
export const ATTACH_CAPABILITY_HEX_LENGTH = ATTACH_CAPABILITY_BYTES * 2;

/** Mode applied to the token file that stores the capability. */
export const ATTACH_TOKEN_FILE_MODE = 0o600;

/** Mode applied to the listen socket (Unix sockets honor chmod). */
export const ATTACH_SOCKET_MODE = 0o600;

/** Mode applied to the runtime directory containing socket + token. */
export const ATTACH_RUNTIME_DIR_MODE = 0o700;

/** A client must send a valid hello within this window or is dropped. */
export const ATTACH_HELLO_TIMEOUT_MS = 10_000;

/** High-water mark for the per-connection bounded write queue (bytes). */
export const ATTACH_WRITE_QUEUE_HIGH_WATER_BYTES = 8 * 1024 * 1024;

/** Maximum queue length (frames) for the per-connection bounded write queue. */
export const ATTACH_WRITE_QUEUE_MAX_FRAMES = 1_024;

/** Default summary truncation length in snapshots. */
export const ATTACH_SNAPSHOT_MAX_SUMMARY_LENGTH = 256;

/** Max characters for `currentTool` in a progress event. */
export const ATTACH_PROGRESS_MAX_TOOL_LENGTH = 80;
/** Max characters for `currentToolArgs` in a progress event. */
export const ATTACH_PROGRESS_MAX_TOOL_ARGS_LENGTH = 60;
/** Max characters for `lastIntent` in a progress event. */
export const ATTACH_PROGRESS_MAX_INTENT_LENGTH = 80;
/** Max output lines kept in a progress event's `outputTail`. */
export const ATTACH_PROGRESS_MAX_OUTPUT_LINES = 3;
/** Max characters per `outputTail` line in a progress event. */
export const ATTACH_PROGRESS_MAX_LINE_LENGTH = 100;

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * Stable identity of a worker on the wire. The registry keys live sessions by
 * `(workerId, ownerScope)` so the same worker id in different owner scopes
 * (e.g. different root sessions) can never alias.
 */
export interface AttachWorkerKey {
	readonly workerId: string;
	readonly ownerScope: string;
}

/** Worker lifecycle state as observed through the attach substrate. */
export type AttachWorkerState = "starting" | "running" | "idle" | "parked" | "revived" | "finished" | "error";

/** Serializable view of a registered worker (the "SessionManager entry"). */
export interface AttachSessionEntry {
	readonly key: AttachWorkerKey;
	readonly state: AttachWorkerState;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Last time a follow-up was accepted or a result was produced. */
	readonly lastActivityAt: number | null;
	/** Number of follow-ups currently in flight (serialized per key: 0 or 1). */
	readonly pendingFollowUps: number;
	/** Number of attached clients subscribed to this key. */
	readonly attachedClients: number;
	/** Capped human-readable summary; `null` when none is available. */
	readonly summary: string | null;
}

/** Point-in-time view of every registered worker. */
export interface AttachSnapshot {
	readonly version: number;
	readonly generatedAt: number;
	readonly sessions: readonly AttachSessionEntry[];
}

/** Bounds applied when shrinking a snapshot before encoding it. */
export interface AttachSnapshotShrinkOptions {
	readonly maxSessions?: number;
	readonly maxSummaryLength?: number;
}

// ---------------------------------------------------------------------------
// Wire messages (client -> server)
// ---------------------------------------------------------------------------

export interface AttachClientInfo {
	/** `pane` = a pane-origin client; `director` = the session's director. */
	readonly role: "pane" | "director";
	/** Free-form client label for logs (never trusted for auth). */
	readonly name?: string;
}

/** First frame on every connection. Carries the capability and nothing else sensitive. */
export interface AttachHello {
	readonly kind: "hello";
	readonly version: number;
	readonly capability: string;
	readonly client: AttachClientInfo;
	/** When true, the server replies with hello_ok + snapshot and starts streaming. */
	readonly subscribe?: boolean;
}

/** Narrow the event stream. Empty arrays/omitted fields mean "everything". */
export interface AttachSubscribe {
	readonly kind: "subscribe";
	readonly workerIds?: readonly string[];
	readonly ownerScopes?: readonly string[];
}

/** Serialized follow-up prompt for a worker (same queue as vibe_send). */
export interface AttachFollowUp {
	readonly kind: "follow_up";
	/** Client-generated correlation id, echoed on follow_up_result. */
	readonly ref: string;
	readonly key: AttachWorkerKey;
	readonly payload: unknown;
	readonly timeoutMs?: number;
}

/** Cancel the in-flight follow-up for a worker. Never kills the worker. */
export interface AttachAbort {
	readonly kind: "abort";
	readonly key: AttachWorkerKey;
	readonly reason?: string;
}

/** Keepalive; the server answers with `pong`. */
export interface AttachPing {
	readonly kind: "ping";
	readonly nonce?: number;
}

/** Polite shutdown of the client side of the connection. */
export interface AttachBye {
	readonly kind: "bye";
}

export type AttachClientMessage = AttachHello | AttachSubscribe | AttachFollowUp | AttachAbort | AttachPing | AttachBye;

// ---------------------------------------------------------------------------
// Wire messages (server -> client)
// ---------------------------------------------------------------------------

/** Successful authentication. Always carries a full snapshot. */
export interface AttachHelloOk {
	readonly kind: "hello_ok";
	readonly version: number;
	readonly server: {
		readonly pid: number;
		readonly startedAt: number;
	};
	readonly snapshot: AttachSnapshot;
}

/** Push of a fresh snapshot (after `subscribe`, and on demand). */
export interface AttachSnapshotPush {
	readonly kind: "snapshot";
	readonly snapshot: AttachSnapshot;
}

/** Streamed lifecycle/state/follow-up event (see AttachEvent). */
export interface AttachEventMessage {
	readonly kind: "event";
	readonly event: AttachEvent;
}

export interface AttachPong {
	readonly kind: "pong";
	readonly nonce?: number;
}

/** Server-initiated close notice (shutdown or protocol violation). */
export interface AttachByeMessage {
	readonly kind: "bye";
	readonly reason?: string;
}

export type AttachErrorCode =
	| "protocol_version"
	| "hello_required"
	| "auth_failed"
	| "malformed"
	| "frame_too_large"
	| "unknown_kind"
	| "unknown_worker"
	| "busy"
	| "shutdown"
	| "internal";

export interface AttachError {
	readonly kind: "error";
	readonly code: AttachErrorCode;
	readonly message: string;
	/** Echo of the offending `ref` when the error answers a follow_up/abort. */
	readonly ref?: string;
}

export type AttachServerMessage =
	| AttachHelloOk
	| AttachSnapshotPush
	| AttachEventMessage
	| AttachPong
	| AttachByeMessage
	| AttachError;

export type AttachMessage = AttachClientMessage | AttachServerMessage;

// ---------------------------------------------------------------------------
// Streamed events
// ---------------------------------------------------------------------------

export type AttachEvent =
	| {
			readonly type: "registered";
			readonly key: AttachWorkerKey;
			readonly entry: AttachSessionEntry;
	  }
	| {
			readonly type: "updated";
			readonly key: AttachWorkerKey;
			readonly entry: AttachSessionEntry;
	  }
	| {
			readonly type: "state";
			readonly key: AttachWorkerKey;
			readonly state: AttachWorkerState;
			readonly at: number;
	  }
	| {
			readonly type: "removed";
			readonly key: AttachWorkerKey;
			readonly reason: string;
	  }
	| {
			readonly type: "follow_up_accepted";
			readonly key: AttachWorkerKey;
			readonly ref: string;
	  }
	| {
			readonly type: "follow_up_result";
			readonly key: AttachWorkerKey;
			readonly ref: string;
			readonly ok: boolean;
			readonly payload?: unknown;
			readonly error?: string;
	  }
	| {
			readonly type: "abort_accepted";
			readonly key: AttachWorkerKey;
			readonly ref?: string;
	  }
	| {
			readonly type: "progress";
			readonly key: AttachWorkerKey;
			readonly at: number;
			/** Live tool being executed, bounded. */
			readonly currentTool?: string;
			/** Bounded render of the tool's arguments. */
			readonly currentToolArgs?: string;
			/** Bounded last intent line. */
			readonly lastIntent?: string;
			/** Bounded tail of the worker's latest output lines (oldest first). */
			readonly outputTail: readonly string[];
	  };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised by encoding/decoding/validation helpers. */
export class AttachProtocolError extends Error {
	readonly code: AttachErrorCode;

	constructor(code: AttachErrorCode, message: string) {
		super(message);
		this.name = "AttachProtocolError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/** CSPRNG 256-bit capability serialized as 64 lowercase hex characters. */
export function generateAttachCapability(): string {
	return randomBytes(ATTACH_CAPABILITY_BYTES).toString("hex");
}

/** True iff `capability` has the exact expected shape. */
export function isAttachCapability(capability: unknown): capability is string {
	return (
		typeof capability === "string" &&
		capability.length === ATTACH_CAPABILITY_HEX_LENGTH &&
		/^[0-9a-f]+$/.test(capability)
	);
}

// ---------------------------------------------------------------------------
// Frame encoding / decoding
// ---------------------------------------------------------------------------

/** Encode one message as a newline-terminated JSON frame (bounded). */
export function encodeAttachMessage(message: AttachMessage): Buffer {
	const json = JSON.stringify(message);
	const frame = Buffer.from(`${json}\n`, "utf8");
	if (frame.byteLength > ATTACH_MAX_FRAME_BYTES) {
		throw new AttachProtocolError(
			"frame_too_large",
			`encoded frame is ${frame.byteLength} bytes; limit is ${ATTACH_MAX_FRAME_BYTES}`,
		);
	}
	return frame;
}

/**
 * Decode and type-check one frame line. The line MUST NOT include the trailing
 * delimiter. Throws `AttachProtocolError` with `frame_too_large` or
 * `malformed` / `unknown_kind`.
 */
export function decodeAttachLine(line: Buffer): AttachMessage {
	if (line.byteLength > ATTACH_MAX_FRAME_BYTES) {
		throw new AttachProtocolError(
			"frame_too_large",
			`frame is ${line.byteLength} bytes; limit is ${ATTACH_MAX_FRAME_BYTES}`,
		);
	}
	if (line.byteLength === 0) {
		throw new AttachProtocolError("malformed", "empty frame");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.toString("utf8"));
	} catch {
		throw new AttachProtocolError("malformed", "frame is not valid JSON");
	}
	return validateAttachMessage(parsed);
}

/**
 * Validate an arbitrary value against the `AttachMessage` union. Throws
 * `AttachProtocolError('malformed' | 'unknown_kind')` on mismatch.
 */
export function validateAttachMessage(value: unknown): AttachMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AttachProtocolError("malformed", "message must be a JSON object");
	}
	const kind = (value as { kind?: unknown }).kind;
	if (typeof kind !== "string") {
		throw new AttachProtocolError("malformed", 'message is missing string field "kind"');
	}
	switch (kind) {
		case "hello":
			return validateHello(value as Record<string, unknown>);
		case "subscribe":
			return validateSubscribe(value as Record<string, unknown>);
		case "follow_up":
			return validateFollowUp(value as Record<string, unknown>);
		case "abort":
			return validateAbort(value as Record<string, unknown>);
		case "ping":
			return validatePing(value as Record<string, unknown>);
		case "bye":
			return validateBye(value as Record<string, unknown>);
		case "hello_ok":
		case "snapshot":
		case "event":
		case "pong":
		case "error":
			return validateServerMessage(kind, value as Record<string, unknown>);
		default:
			throw new AttachProtocolError("unknown_kind", `unknown message kind "${kind}"`);
	}
}

// ---------------------------------------------------------------------------
// Per-kind validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: Record<string, unknown>, field: string): string {
	const v = value[field];
	if (typeof v !== "string") {
		throw new AttachProtocolError("malformed", `field "${field}" must be a string`);
	}
	return v;
}

function expectOptionalString(value: Record<string, unknown>, field: string): string | undefined {
	const v = value[field];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new AttachProtocolError("malformed", `field "${field}" must be a string`);
	}
	return v;
}

function expectNumber(value: Record<string, unknown>, field: string): number {
	const v = value[field];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new AttachProtocolError("malformed", `field "${field}" must be a finite number`);
	}
	return v;
}

function expectOptionalNumber(value: Record<string, unknown>, field: string): number | undefined {
	const v = value[field];
	if (v === undefined) return undefined;
	return expectNumber(value, field);
}

function expectBoolean(value: Record<string, unknown>, field: string): boolean {
	const v = value[field];
	if (typeof v !== "boolean") {
		throw new AttachProtocolError("malformed", `field "${field}" must be a boolean`);
	}
	return v;
}

function expectOptionalBoolean(value: Record<string, unknown>, field: string): boolean | undefined {
	const v = value[field];
	if (v === undefined) return undefined;
	return expectBoolean(value, field);
}

function expectWorkerKey(value: Record<string, unknown>, field: string): AttachWorkerKey {
	const raw = value[field];
	if (!isRecord(raw)) {
		throw new AttachProtocolError("malformed", `field "${field}" must be an object`);
	}
	return {
		workerId: expectString(raw, "workerId"),
		ownerScope: expectString(raw, "ownerScope"),
	};
}

function expectStringArray(value: Record<string, unknown>, field: string): readonly string[] {
	const v = value[field];
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some(item => typeof item !== "string")) {
		throw new AttachProtocolError("malformed", `field "${field}" must be an array of strings`);
	}
	return v as readonly string[];
}

function validateHello(value: Record<string, unknown>): AttachHello {
	const version = expectNumber(value, "version");
	if (!Number.isInteger(version) || version < 1) {
		throw new AttachProtocolError("malformed", 'field "version" must be a positive integer');
	}
	const capability = expectString(value, "capability");
	if (!isAttachCapability(capability)) {
		throw new AttachProtocolError("auth_failed", 'field "capability" has an invalid shape');
	}
	const client = value.client;
	if (!isRecord(client)) {
		throw new AttachProtocolError("malformed", 'field "client" must be an object');
	}
	const role = client.role;
	if (role !== "pane" && role !== "director") {
		throw new AttachProtocolError("malformed", 'field "client.role" must be "pane" or "director"');
	}
	return {
		kind: "hello",
		version,
		capability,
		client: {
			role,
			name: expectOptionalString(client, "name"),
		},
		subscribe: expectOptionalBoolean(value, "subscribe"),
	};
}

function validateSubscribe(value: Record<string, unknown>): AttachSubscribe {
	return {
		kind: "subscribe",
		workerIds: expectStringArray(value, "workerIds"),
		ownerScopes: expectStringArray(value, "ownerScopes"),
	};
}

function validateFollowUp(value: Record<string, unknown>): AttachFollowUp {
	const ref = expectString(value, "ref");
	if (ref.length === 0) {
		throw new AttachProtocolError("malformed", 'field "ref" must not be empty');
	}
	if (!("payload" in value)) {
		throw new AttachProtocolError("malformed", 'field "payload" is required');
	}
	return {
		kind: "follow_up",
		ref,
		key: expectWorkerKey(value, "key"),
		payload: value.payload,
		timeoutMs: expectOptionalNumber(value, "timeoutMs"),
	};
}

function validateAbort(value: Record<string, unknown>): AttachAbort {
	return {
		kind: "abort",
		key: expectWorkerKey(value, "key"),
		reason: expectOptionalString(value, "reason"),
	};
}

function validatePing(value: Record<string, unknown>): AttachPing {
	return {
		kind: "ping",
		nonce: expectOptionalNumber(value, "nonce"),
	};
}

function validateBye(value: Record<string, unknown>): AttachBye {
	void value;
	return { kind: "bye" };
}

function validateServerMessage(kind: string, value: Record<string, unknown>): AttachServerMessage {
	// Server-bound messages are produced by the server itself; we still verify
	// the shape so the decode path rejects garbage (e.g. hostile peers echoing
	// server kinds back at us).
	switch (kind) {
		case "hello_ok": {
			const server = value.server;
			if (!isRecord(server)) {
				throw new AttachProtocolError("malformed", 'field "server" must be an object');
			}
			return {
				kind: "hello_ok",
				version: expectNumber(value, "version"),
				server: {
					pid: expectNumber(server, "pid"),
					startedAt: expectNumber(server, "startedAt"),
				},
				snapshot: expectSnapshot(value.snapshot),
			};
		}
		case "snapshot":
			return { kind: "snapshot", snapshot: expectSnapshot(value.snapshot) };
		case "event":
			return { kind: "event", event: expectEvent(value.event) };
		case "pong":
			return { kind: "pong", nonce: expectOptionalNumber(value, "nonce") };
		case "error":
			return {
				kind: "error",
				code: expectErrorCode(value.code),
				message: expectString(value, "message"),
				ref: expectOptionalString(value, "ref"),
			};
		default:
			throw new AttachProtocolError("unknown_kind", `unknown message kind "${kind}"`);
	}
}

function expectErrorCode(value: unknown): AttachErrorCode {
	const codes: readonly AttachErrorCode[] = [
		"protocol_version",
		"hello_required",
		"auth_failed",
		"malformed",
		"frame_too_large",
		"unknown_kind",
		"unknown_worker",
		"busy",
		"shutdown",
		"internal",
	];
	if (typeof value !== "string" || !codes.includes(value as AttachErrorCode)) {
		throw new AttachProtocolError("malformed", 'field "code" is not a valid error code');
	}
	return value as AttachErrorCode;
}

function expectWorkerState(value: unknown): AttachWorkerState {
	const states: readonly AttachWorkerState[] = [
		"starting",
		"running",
		"idle",
		"parked",
		"revived",
		"finished",
		"error",
	];
	if (typeof value !== "string" || !states.includes(value as AttachWorkerState)) {
		throw new AttachProtocolError("malformed", 'field "state" is not a valid worker state');
	}
	return value as AttachWorkerState;
}

function expectSessionEntry(value: unknown): AttachSessionEntry {
	if (!isRecord(value)) {
		throw new AttachProtocolError("malformed", "session entry must be an object");
	}
	const rawSummary = value.summary;
	if (rawSummary !== null && rawSummary !== undefined && typeof rawSummary !== "string") {
		throw new AttachProtocolError("malformed", 'field "summary" must be a string or null');
	}
	const rawActivity = value.lastActivityAt;
	if (
		rawActivity !== null &&
		rawActivity !== undefined &&
		(typeof rawActivity !== "number" || !Number.isFinite(rawActivity))
	) {
		throw new AttachProtocolError("malformed", 'field "lastActivityAt" must be a number or null');
	}
	return {
		key: expectWorkerKey(value, "key"),
		state: expectWorkerState(value.state),
		createdAt: expectNumber(value, "createdAt"),
		updatedAt: expectNumber(value, "updatedAt"),
		lastActivityAt: rawActivity === null || rawActivity === undefined ? null : (rawActivity as number),
		pendingFollowUps: expectNumber(value, "pendingFollowUps"),
		attachedClients: expectNumber(value, "attachedClients"),
		summary: rawSummary === null || rawSummary === undefined ? null : (rawSummary as string),
	};
}

function expectSnapshot(value: unknown): AttachSnapshot {
	if (!isRecord(value)) {
		throw new AttachProtocolError("malformed", "snapshot must be an object");
	}
	const sessions = value.sessions;
	if (!Array.isArray(sessions)) {
		throw new AttachProtocolError("malformed", 'field "sessions" must be an array');
	}
	return {
		version: expectNumber(value, "version"),
		generatedAt: expectNumber(value, "generatedAt"),
		sessions: sessions.map(expectSessionEntry),
	};
}

function expectEvent(value: unknown): AttachEvent {
	if (!isRecord(value)) {
		throw new AttachProtocolError("malformed", "event must be an object");
	}
	const type = value.type;
	if (typeof type !== "string") {
		throw new AttachProtocolError("malformed", 'event is missing string field "type"');
	}
	const key = expectWorkerKey(value, "key");
	switch (type) {
		case "registered":
		case "updated":
			return { type, key, entry: expectSessionEntry(value.entry) };
		case "state":
			return { type, key, state: expectWorkerState(value.state), at: expectNumber(value, "at") };
		case "removed":
			return { type, key, reason: expectString(value, "reason") };
		case "follow_up_accepted":
			return { type, key, ref: expectString(value, "ref") };
		case "follow_up_result":
			return {
				type,
				key,
				ref: expectString(value, "ref"),
				ok: expectBoolean(value, "ok"),
				payload: "payload" in value ? value.payload : undefined,
				error: expectOptionalString(value, "error"),
			};
		case "abort_accepted":
			return { type, key, ref: expectOptionalString(value, "ref") };
		case "progress":
			return {
				type,
				key,
				at: expectNumber(value, "at"),
				currentTool: expectOptionalString(value, "currentTool"),
				currentToolArgs: expectOptionalString(value, "currentToolArgs"),
				lastIntent: expectOptionalString(value, "lastIntent"),
				outputTail: expectStringArray(value, "outputTail"),
			};
		default:
			throw new AttachProtocolError("unknown_kind", `unknown event type "${type}"`);
	}
}

// ---------------------------------------------------------------------------
// Incremental frame reader (bounded)
// ---------------------------------------------------------------------------

/**
 * Incrementally splits a byte stream into newline-terminated frames without
 * ever buffering more than `ATTACH_MAX_FRAME_BYTES` bytes. Throws
 * `AttachProtocolError('frame_too_large')` the moment a frame exceeds the cap,
 * so a hostile peer cannot grow memory without bound.
 */
export class AttachFrameAccumulator {
	private chunks: Buffer[] = [];
	private buffered = 0;

	/** Feed a chunk; returns complete frames (without their trailing newline). */
	push(chunk: Buffer): Buffer[] {
		const frames: Buffer[] = [];
		let start = 0;
		for (let i = 0; i < chunk.byteLength; i++) {
			if (chunk[i] === ATTACH_FRAME_DELIMITER) {
				const frame = Buffer.concat([...this.chunks, chunk.subarray(start, i)]);
				this.chunks = [];
				this.buffered = 0;
				if (frame.byteLength > ATTACH_MAX_FRAME_BYTES) {
					throw new AttachProtocolError(
						"frame_too_large",
						`frame is ${frame.byteLength} bytes; limit is ${ATTACH_MAX_FRAME_BYTES}`,
					);
				}
				frames.push(frame);
				start = i + 1;
			}
		}
		const rest = chunk.subarray(start);
		if (rest.byteLength > 0) {
			this.buffered += rest.byteLength;
			if (this.buffered > ATTACH_MAX_FRAME_BYTES) {
				throw new AttachProtocolError(
					"frame_too_large",
					`partial frame reached ${this.buffered} bytes; limit is ${ATTACH_MAX_FRAME_BYTES}`,
				);
			}
			this.chunks.push(Buffer.from(rest));
		}
		return frames;
	}

	/** Bytes currently buffered awaiting a newline. */
	get pendingBytes(): number {
		return this.buffered;
	}
}

// ---------------------------------------------------------------------------
// Bounded write queue
// ---------------------------------------------------------------------------

/**
 * Per-connection outbound queue with hard byte and frame caps. `enqueue`
 * returns false once either cap is exceeded; the server MUST drop the
 * connection in that case instead of growing the queue.
 */
export class AttachBoundedQueue<T> {
	private readonly items: T[] = [];
	private totalBytes = 0;

	constructor(
		private readonly sizeOf: (item: T) => number,
		private readonly maxFrames = ATTACH_WRITE_QUEUE_MAX_FRAMES,
		private readonly maxBytes = ATTACH_WRITE_QUEUE_HIGH_WATER_BYTES,
	) {}

	/** True iff the item was accepted; false when a cap is exceeded. */
	enqueue(item: T): boolean {
		const size = this.sizeOf(item);
		if (this.items.length >= this.maxFrames || this.totalBytes + size > this.maxBytes) {
			return false;
		}
		this.items.push(item);
		this.totalBytes += size;
		return true;
	}

	/** Remove and return the oldest item, or undefined when empty. */
	dequeue(): T | undefined {
		const item = this.items.shift();
		if (item !== undefined) {
			this.totalBytes -= this.sizeOf(item);
		}
		return item;
	}

	get length(): number {
		return this.items.length;
	}

	get bytes(): number {
		return this.totalBytes;
	}

	get isOverHighWater(): boolean {
		return this.length >= this.maxFrames || this.bytes >= this.maxBytes;
	}
}

// ---------------------------------------------------------------------------
// Snapshot shrinking
// ---------------------------------------------------------------------------

/**
 * Shrink a snapshot to the given bounds: truncates summaries to
 * `maxSummaryLength` chars and keeps the `maxSessions` most recently updated
 * entries. Used before encoding so snapshots always fit a single frame.
 */
export function shrinkAttachSnapshot(
	snapshot: AttachSnapshot,
	options: AttachSnapshotShrinkOptions = {},
): AttachSnapshot {
	const maxSummaryLength = options.maxSummaryLength ?? ATTACH_SNAPSHOT_MAX_SUMMARY_LENGTH;
	let sessions = snapshot.sessions;
	if (options.maxSessions !== undefined && sessions.length > options.maxSessions) {
		sessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, options.maxSessions);
	}
	const shrunk = sessions.map((entry): AttachSessionEntry => {
		const summary =
			entry.summary !== null && entry.summary.length > maxSummaryLength
				? `${entry.summary.slice(0, maxSummaryLength - 1)}…`
				: entry.summary;
		return summary === entry.summary ? entry : { ...entry, summary };
	});
	return {
		version: snapshot.version,
		generatedAt: snapshot.generatedAt,
		sessions: shrunk,
	};
}

// ---------------------------------------------------------------------------
// Progress sanitization
// ---------------------------------------------------------------------------

/** Normalize one progress text fragment to a single bounded line. */
function boundedLine(text: string, max: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > max ? line.slice(0, max) : line;
}

export interface AttachProgressInput {
	readonly currentTool?: string;
	readonly currentToolArgs?: string;
	readonly lastIntent?: string;
	readonly outputTail: readonly string[];
}

/**
 * Sanitize live progress fields to strict wire bounds: every string is
 * collapsed to its first line and capped, and `outputTail` keeps at most
 * `ATTACH_PROGRESS_MAX_OUTPUT_LINES` capped lines (oldest first). Applied
 * before encoding so a progress event can never exceed its frame budget or
 * carry multi-line noise.
 */
export function sanitizeAttachProgress(input: AttachProgressInput): Required<AttachProgressInput> {
	return {
		currentTool:
			input.currentTool === undefined ? "" : boundedLine(input.currentTool, ATTACH_PROGRESS_MAX_TOOL_LENGTH),
		currentToolArgs:
			input.currentToolArgs === undefined
				? ""
				: boundedLine(input.currentToolArgs, ATTACH_PROGRESS_MAX_TOOL_ARGS_LENGTH),
		lastIntent:
			input.lastIntent === undefined ? "" : boundedLine(input.lastIntent, ATTACH_PROGRESS_MAX_INTENT_LENGTH),
		outputTail: input.outputTail
			.slice(-ATTACH_PROGRESS_MAX_OUTPUT_LINES)
			.map(line => boundedLine(line, ATTACH_PROGRESS_MAX_LINE_LENGTH)),
	};
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stable label for a worker key, e.g. for pane titles and log lines. */
export function formatAttachKey(key: AttachWorkerKey): string {
	return `${key.ownerScope}/${key.workerId}`;
}

/** True iff the message is a valid `hello` (used for strict hello-first auth). */
export function isHelloMessage(message: AttachMessage): message is AttachHello {
	return message.kind === "hello";
}
