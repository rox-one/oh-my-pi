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
 * - Controller leases carry a second CSPRNG secret (the resume proof) that
 *   only the granted client ever sees. Every control frame must present the
 *   current lease id + proof + generation.
 *
 * Framing and backpressure
 * ------------------------
 * - Frames are bounded: `ATTACH_MAX_FRAME_BYTES` (1 MiB) per line. The decoder
 *   and `AttachFrameAccumulator` fail fast on oversized frames instead of
 *   buffering without bound. Transcript entries are byte-bounded per entry and
 *   chunked by the encoded frame byte budget (see `boundAttachTranscriptItems`)
 *   so every generated `transcript_items` / `transcript_append` frame fits
 *   within a bounded frame.
 * - Writes go through a bounded queue (`AttachBoundedQueue`): when a slow
 *   client pushes the queue past its high-water mark the server drops the
 *   connection rather than buffering unboundedly. `detach`/disconnect never
 *   kills the worker — only the client subscription is torn down.
 *
 * Protocol version 2 — view epochs and controller leases
 * -------------------------------------------------------
 * v2 replaces the pane subscribe path with an explicit `view_open` handshake:
 *
 *   client -> hello { version: 2 }          server -> hello_ok | error
 *   client -> view_open { key, resume? }    server -> view_open_ok { lease, epoch, entry }
 *                                                        | view_open_rejected { code }
 *   server -> transcript_begin { epoch, seq }
 *          -> transcript_items { epoch, seq, items }*   (bounded chunks)
 *          -> transcript_end { epoch, seq, watermark, model? }
 *          -> event { type: "transcript_append" ... }*  (live additions)
 *          -> event { type: "progress" | "updated" | "state" | ... }
 *   client -> prompt { lease, cmdSeq, cmdId, ref, text }
 *   server -> prompt_accepted { ref, cmdId } | control_rejected { ... }
 *   server -> prompt_result { ref, cmdId, ok, payload?, error? }
 *   client -> abort_turn { lease, cmdSeq, cmdId }
 *   server -> abort_accepted { ref?, cmdId } | control_rejected { ... }
 *   client -> detach { lease, reason? }      server -> bye { reason }, close
 *   client -> ping                           server -> pong
 *
 * - Every `view_open` acquires an atomic controller lease for the worker —
 *   reject-not-replace: a second pane client is rejected with `lease_busy`
 *   while the lease is held. `role: "observer"` clients (hello + subscribe)
 *   never acquire a lease and are read-only.
 * - The lease carries an opaque id, a secret resume proof, and a generation
 *   that bumps on every successful (re)acquire. Disconnect holds the lease
 *   for a short bounded grace so the SAME client instance can resume with
 *   `resume: { leaseId, proof, generation }`; grace expiry, explicit detach,
 *   worker removal, session switch, or shutdown releases it. Stale
 *   generations and foreign leases are rejected.
 * - Every control frame carries `leaseId + proof + generation` plus a
 *   client-monotonic `cmdSeq` and a random `cmdId`. The server rejects
 *   duplicate and out-of-order commands and caches bounded acknowledgements
 *   so a reconnect can recover whether an accepted input ran — without ever
 *   executing it twice.
 * - Transcript delivery is epoch-scoped: the server stamps every transcript
 *   frame with the view's epoch and a monotonic sequence. A reconnect
 *   establishes a fresh snapshot epoch; stale epoch/sequence frames are
 *   protocol errors that force a clean reconnect replay (no terminal-byte
 *   recovery). `transcript_reset` signals a branch switch/rotation and is
 *   followed by a fresh snapshot within the same epoch.
 *
 * Director/observer compatibility
 * -------------------------------
 * v1's `subscribe` + `snapshot` + `follow_up` + `abort` remain for
 * `role: "director"` clients (the in-process director path) and for
 * read-only `role: "observer"` clients; `follow_up`/`abort` are rejected
 * with `forbidden` for observers. Pane clients MUST use `view_open`/`prompt`.
 */
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionMessageEntry } from "../session/session-entries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current wire protocol version. Bumped only on breaking wire changes. */
export const ATTACH_PROTOCOL_VERSION = 2 as const;

/** Frame delimiter: one JSON object per line. */
export const ATTACH_FRAME_DELIMITER = 0x0a; // '\n'

/** Upper bound for a single encoded frame (JSON + delimiter), in bytes. */
export const ATTACH_MAX_FRAME_BYTES = 1 << 20; // 1 MiB

/** Capability entropy, in bytes (256 bits). */
export const ATTACH_CAPABILITY_BYTES = 32;

/** Capability serialized length in hex characters. */
export const ATTACH_CAPABILITY_HEX_LENGTH = ATTACH_CAPABILITY_BYTES * 2;

/** Lease proof entropy, in bytes (256 bits). */
export const ATTACH_LEASE_PROOF_BYTES = 32;

/** Lease proof serialized length in hex characters. */
export const ATTACH_LEASE_PROOF_HEX_LENGTH = ATTACH_LEASE_PROOF_BYTES * 2;

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

/** Maximum transcript entries per frame; chunks also split on the encoded byte budget. */
export const ATTACH_TRANSCRIPT_ITEMS_PER_FRAME = 25;

/**
 * Per-entry transcript serialization budget, enforced on the ENCODED entry
 * (JSON + UTF-8 bytes, see {@link boundAttachTranscriptEntry}). Entries that
 * exceed it are truncated, so a single entry always fits a frame alone and
 * byte-based chunking can never produce an oversized `transcript_items` frame.
 */
export const ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES = 384 * 1024;

/** Long strings inside a transcript entry are truncated to this many chars. */
export const ATTACH_TRANSCRIPT_MAX_STRING_CHARS = 16 * 1024;

/** Default disconnect grace for a controller lease, in ms. */
export const ATTACH_LEASE_GRACE_MS = 30_000;

/** Bounded command-acknowledgement cache size per worker. */
export const ATTACH_CMD_ACK_CACHE_SIZE = 64;

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

/**
 * Controller lease for one worker view. The holder's control frames must
 * present `leaseId + proof + generation`; `generation` bumps on every
 * successful (re)acquire so a stale client can never control the worker.
 */
export interface AttachLease {
	readonly leaseId: string;
	readonly proof: string;
	readonly generation: number;
	/** Disconnect grace before the lease is released, in ms. */
	readonly graceMs: number;
}

// ---------------------------------------------------------------------------
// Wire messages (client -> server)

export interface AttachClientInfo {
	/**
	 * `pane` = a pane-origin client (must use view_open/prompt; acquires the
	 * controller lease); `director` = the session's director (subscribe +
	 * follow_up path); `observer` = read-only subscriber (no controls).
	 */
	readonly role: "pane" | "director" | "observer";
	/** Free-form client label for logs (never trusted for auth). */
	readonly name?: string;
}

/** First frame on every connection. Carries the capability and nothing else sensitive. */
export interface AttachHello {
	readonly kind: "hello";
	readonly version: number;
	readonly capability: string;
	readonly client: AttachClientInfo;
}

/**
 * Acquire (or resume) the controller lease for one worker and start its
 * transcript view. `resume` is how a disconnected client reclaims its own
 * lease within the grace window: the server re-grants ONLY when the presented
 * lease id + proof + generation match the current holder. A fresh view_open
 * with no `resume` is rejected with `lease_busy` while any lease is held.
 */
export interface AttachViewOpen {
	readonly kind: "view_open";
	readonly key: AttachWorkerKey;
	readonly resume?: {
		readonly leaseId: string;
		readonly proof: string;
		readonly generation: number;
	};
}

/**
 * Submit one prompt to the worker through the Vibe turn queue (same queue as
 * `vibe_send`). Controller-only: requires the current lease. `cmdSeq` is
 * client-monotonic per lease; `cmdId` is a client-generated idempotency key.
 */
export interface AttachPrompt {
	readonly kind: "prompt";
	readonly key: AttachWorkerKey;
	readonly leaseId: string;
	readonly proof: string;
	readonly generation: number;
	readonly cmdSeq: number;
	readonly cmdId: string;
	/** Client-generated correlation id, echoed on prompt_accepted/prompt_result. */
	readonly ref: string;
	readonly text: string;
	readonly timeoutMs?: number;
}

/**
 * Cancel the in-flight turn for a worker (never kills the worker).
 * Controller-only; distinct from `detach` (which only releases the view).
 */
export interface AttachAbortTurn {
	readonly kind: "abort_turn";
	readonly key: AttachWorkerKey;
	readonly leaseId: string;
	readonly proof: string;
	readonly generation: number;
	readonly cmdSeq: number;
	readonly cmdId: string;
}

/**
 * Explicitly release the controller lease and close the view. The server
 * replies `bye` and closes the connection. Does NOT abort the worker.
 */
export interface AttachDetach {
	readonly kind: "detach";
	readonly key: AttachWorkerKey;
	readonly leaseId: string;
	readonly proof: string;
	readonly generation: number;
	readonly reason?: string;
}

/** Narrow the event stream (director/observer subscribe path). */
export interface AttachSubscribe {
	readonly kind: "subscribe";
	readonly workerIds?: readonly string[];
	readonly ownerScopes?: readonly string[];
}

/** Serialized follow-up prompt for a worker (director path; same queue as vibe_send). */
export interface AttachFollowUp {
	readonly kind: "follow_up";
	/** Client-generated correlation id, echoed on follow_up_result. */
	readonly ref: string;
	readonly key: AttachWorkerKey;
	readonly payload: unknown;
	readonly timeoutMs?: number;
}

/** Cancel the in-flight follow-up for a worker (director path). Never kills the worker. */
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

export type AttachClientMessage =
	| AttachHello
	| AttachViewOpen
	| AttachPrompt
	| AttachAbortTurn
	| AttachDetach
	| AttachSubscribe
	| AttachFollowUp
	| AttachAbort
	| AttachPing
	| AttachBye;

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

/**
 * Successful `view_open`: the caller holds the controller lease for `key`
 * and may send `prompt`/`abort_turn`/`detach` frames. `epoch` scopes every
 * subsequent transcript frame; `entry` is the worker's current state.
 */
export interface AttachViewOpenOk {
	readonly kind: "view_open_ok";
	readonly key: AttachWorkerKey;
	readonly lease: AttachLease;
	readonly epoch: number;
	readonly entry: AttachSessionEntry;
	/** Worker working directory (for path shortening in rendered components). */
	readonly cwd?: string;
}

export type AttachViewOpenRejectCode = "lease_busy" | "unknown_worker" | "stale_resume" | "internal";

/** Failed `view_open`. `holder` is present for `lease_busy` so the client can
 *  show why and when the lease frees. */
export interface AttachViewOpenRejected {
	readonly kind: "view_open_rejected";
	readonly key: AttachWorkerKey;
	readonly code: AttachViewOpenRejectCode;
	readonly message: string;
	readonly holder?: {
		readonly generation: number;
		readonly expiresInMs: number;
	};
}

/** Starts a snapshot epoch for a view: the following frames carry entries. */
export interface AttachTranscriptBegin {
	readonly kind: "transcript_begin";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
	readonly seq: number;
}

/** One bounded chunk of transcript entries within a snapshot epoch. */
export interface AttachTranscriptItems {
	readonly kind: "transcript_items";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
	readonly seq: number;
	readonly items: readonly SessionMessageEntry[];
}

/** Completes the snapshot epoch; `watermark` is the total entry count sent. */
export interface AttachTranscriptEnd {
	readonly kind: "transcript_end";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
	readonly seq: number;
	readonly watermark: number;
	readonly model?: string;
}

/** One bounded chunk of NEWLY appended transcript entries (live, after the
 *  snapshot epoch completed). The client appends these to its presenter. */
export interface AttachTranscriptAppend {
	readonly kind: "transcript_append";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
	readonly seq: number;
	readonly items: readonly SessionMessageEntry[];
	readonly watermark: number;
	readonly model?: string;
}

/** The worker's transcript branch was switched/rotated; discard and re-snapshot. */
export interface AttachTranscriptReset {
	readonly kind: "transcript_reset";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
	readonly seq: number;
	readonly reason: string;
}

/** The server accepted a controller prompt; `prompt_result` follows. */
export interface AttachPromptAccepted {
	readonly kind: "prompt_accepted";
	readonly key: AttachWorkerKey;
	readonly ref: string;
	readonly cmdId: string;
}

/** A controller prompt settled with the real turn outcome. */
export interface AttachPromptResult {
	readonly kind: "prompt_result";
	readonly key: AttachWorkerKey;
	readonly ref: string;
	readonly cmdId: string;
	readonly ok: boolean;
	readonly payload?: unknown;
	readonly error?: string;
}

export type AttachControlRejectCode =
	| "lease_required"
	| "stale_lease"
	| "stale_generation"
	| "foreign_client"
	| "duplicate"
	| "out_of_order"
	| "busy"
	| "forbidden"
	| "unknown_worker"
	| "internal";

/** A controller frame was rejected (lease/generation/sequence/idempotency). */
export interface AttachControlRejected {
	readonly kind: "control_rejected";
	readonly key: AttachWorkerKey;
	readonly cmdId?: string;
	readonly ref?: string;
	readonly code: AttachControlRejectCode;
	readonly message: string;
}

/** Push of a fresh snapshot (director/observer subscribe path). */
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
	| AttachViewOpenOk
	| AttachViewOpenRejected
	| AttachTranscriptBegin
	| AttachTranscriptItems
	| AttachTranscriptEnd
	| AttachTranscriptAppend
	| AttachTranscriptReset
	| AttachPromptAccepted
	| AttachPromptResult
	| AttachControlRejected
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
			readonly type: "lease_granted";
			readonly key: AttachWorkerKey;
			readonly generation: number;
	  }
	| {
			readonly type: "lease_expired";
			readonly key: AttachWorkerKey;
			readonly reason: string;
	  }
	| {
			readonly type: "lease_revoked";
			readonly key: AttachWorkerKey;
			readonly reason: string;
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
// Capability + lease secrets
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

/** CSPRNG 256-bit lease proof serialized as 64 lowercase hex characters. */
export function generateAttachLeaseProof(): string {
	return randomBytes(ATTACH_LEASE_PROOF_BYTES).toString("hex");
}

/** True iff `proof` has the exact expected shape. */
export function isAttachLeaseProof(proof: unknown): proof is string {
	return typeof proof === "string" && proof.length === ATTACH_LEASE_PROOF_HEX_LENGTH && /^[0-9a-f]+$/.test(proof);
}

/** Unique lease id (v4 UUID). */
export function generateAttachLeaseId(): string {
	return randomUUID();
}

/** Unique command id. */
export function generateAttachCmdId(): string {
	return randomUUID();
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
	const kind: unknown = "kind" in value ? value.kind : undefined;
	if (typeof kind !== "string") {
		throw new AttachProtocolError("malformed", 'message is missing string field "kind"');
	}
	switch (kind) {
		case "hello":
			return validateHello(value as Record<string, unknown>);
		case "view_open":
			return validateViewOpen(value as Record<string, unknown>);
		case "prompt":
			return validatePrompt(value as Record<string, unknown>);
		case "abort_turn":
			return validateAbortTurn(value as Record<string, unknown>);
		case "detach":
			return validateDetach(value as Record<string, unknown>);
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
		case "view_open_ok":
		case "view_open_rejected":
		case "transcript_begin":
		case "transcript_items":
		case "transcript_end":
		case "transcript_append":
		case "transcript_reset":
		case "prompt_accepted":
		case "prompt_result":
		case "control_rejected":
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

function expectLease(value: Record<string, unknown>, field: string): AttachLease {
	const raw = value[field];
	if (!isRecord(raw)) {
		throw new AttachProtocolError("malformed", `field "${field}" must be an object`);
	}
	const leaseId = expectString(raw, "leaseId");
	if (leaseId.length === 0) {
		throw new AttachProtocolError("malformed", 'field "leaseId" must not be empty');
	}
	const proof = expectString(raw, "proof");
	if (!isAttachLeaseProof(proof)) {
		throw new AttachProtocolError("malformed", 'field "proof" has an invalid shape');
	}
	return {
		leaseId,
		proof,
		generation: expectNumber(raw, "generation"),
		graceMs: expectNumber(raw, "graceMs"),
	};
}

function expectResume(value: Record<string, unknown>, field: string): AttachViewOpen["resume"] {
	const raw = value[field];
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) {
		throw new AttachProtocolError("malformed", `field "${field}" must be an object`);
	}
	const leaseId = expectString(raw, "leaseId");
	if (leaseId.length === 0) {
		throw new AttachProtocolError("malformed", 'field "resume.leaseId" must not be empty');
	}
	const proof = expectString(raw, "proof");
	if (!isAttachLeaseProof(proof)) {
		throw new AttachProtocolError("malformed", 'field "resume.proof" has an invalid shape');
	}
	return {
		leaseId,
		proof,
		generation: expectNumber(raw, "generation"),
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
	if (role !== "pane" && role !== "director" && role !== "observer") {
		throw new AttachProtocolError("malformed", 'field "client.role" must be "pane", "director", or "observer"');
	}
	return {
		kind: "hello",
		version,
		capability,
		client: {
			role,
			name: expectOptionalString(client, "name"),
		},
	};
}

function validateViewOpen(value: Record<string, unknown>): AttachViewOpen {
	return {
		kind: "view_open",
		key: expectWorkerKey(value, "key"),
		resume: expectResume(value, "resume"),
	};
}

function validateLeaseFields(value: Record<string, unknown>): {
	leaseId: string;
	proof: string;
	generation: number;
} {
	const leaseId = expectString(value, "leaseId");
	if (leaseId.length === 0) {
		throw new AttachProtocolError("malformed", 'field "leaseId" must not be empty');
	}
	const proof = expectString(value, "proof");
	if (!isAttachLeaseProof(proof)) {
		throw new AttachProtocolError("malformed", 'field "proof" has an invalid shape');
	}
	return {
		leaseId,
		proof,
		generation: expectNumber(value, "generation"),
	};
}

function validateControlHeader(value: Record<string, unknown>): {
	key: AttachWorkerKey;
	leaseId: string;
	proof: string;
	generation: number;
	cmdSeq: number;
	cmdId: string;
} {
	const key = expectWorkerKey(value, "key");
	const lease = validateLeaseFields(value);
	const cmdSeq = expectNumber(value, "cmdSeq");
	if (!Number.isInteger(cmdSeq) || cmdSeq < 1) {
		throw new AttachProtocolError("malformed", 'field "cmdSeq" must be a positive integer');
	}
	const cmdId = expectString(value, "cmdId");
	if (cmdId.length === 0) {
		throw new AttachProtocolError("malformed", 'field "cmdId" must not be empty');
	}
	return { key, leaseId: lease.leaseId, proof: lease.proof, generation: lease.generation, cmdSeq, cmdId };
}

function validatePrompt(value: Record<string, unknown>): AttachPrompt {
	const header = validateControlHeader(value);
	const ref = expectString(value, "ref");
	if (ref.length === 0) {
		throw new AttachProtocolError("malformed", 'field "ref" must not be empty');
	}
	const text = expectString(value, "text");
	return {
		kind: "prompt",
		key: header.key,
		leaseId: header.leaseId,
		proof: header.proof,
		generation: header.generation,
		cmdSeq: header.cmdSeq,
		cmdId: header.cmdId,
		ref,
		text,
		timeoutMs: expectOptionalNumber(value, "timeoutMs"),
	};
}

function validateAbortTurn(value: Record<string, unknown>): AttachAbortTurn {
	const header = validateControlHeader(value);
	return {
		kind: "abort_turn",
		key: header.key,
		leaseId: header.leaseId,
		proof: header.proof,
		generation: header.generation,
		cmdSeq: header.cmdSeq,
		cmdId: header.cmdId,
	};
}

function validateDetach(value: Record<string, unknown>): AttachDetach {
	const key = expectWorkerKey(value, "key");
	const lease = validateLeaseFields(value);
	return {
		kind: "detach",
		key,
		leaseId: lease.leaseId,
		proof: lease.proof,
		generation: expectNumber(value, "generation"),
		reason: expectOptionalString(value, "reason"),
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

function expectTranscriptItems(value: unknown): readonly SessionMessageEntry[] {
	if (!Array.isArray(value)) {
		throw new AttachProtocolError("malformed", 'field "items" must be an array');
	}
	for (const item of value) {
		if (!isRecord(item) || item.type !== "message" || !isRecord(item.message)) {
			throw new AttachProtocolError("malformed", "transcript item must be a session message entry");
		}
		if (typeof item.id !== "string" || typeof item.timestamp !== "string") {
			throw new AttachProtocolError("malformed", "transcript item is missing id or timestamp");
		}
	}
	return value as unknown as readonly SessionMessageEntry[];
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
		case "view_open_ok":
			return {
				kind: "view_open_ok",
				key: expectWorkerKey(value, "key"),
				lease: expectLease(value, "lease"),
				epoch: expectNumber(value, "epoch"),
				entry: expectSessionEntry(value.entry),
				cwd: expectOptionalString(value, "cwd"),
			};
		case "view_open_rejected": {
			const code = value.code;
			const codes: readonly AttachViewOpenRejectCode[] = [
				"lease_busy",
				"unknown_worker",
				"stale_resume",
				"internal",
			];
			if (typeof code !== "string" || !codes.includes(code as AttachViewOpenRejectCode)) {
				throw new AttachProtocolError("malformed", 'field "code" is not a valid rejection code');
			}
			const holder = value.holder;
			return {
				kind: "view_open_rejected",
				key: expectWorkerKey(value, "key"),
				code: code as AttachViewOpenRejectCode,
				message: expectString(value, "message"),
				holder:
					holder === undefined || holder === null
						? undefined
						: isRecord(holder)
							? {
									generation: expectNumber(holder, "generation"),
									expiresInMs: expectNumber(holder, "expiresInMs"),
								}
							: (() => {
									throw new AttachProtocolError("malformed", 'field "holder" must be an object');
								})(),
			};
		}
		case "transcript_begin":
			return {
				kind: "transcript_begin",
				key: expectWorkerKey(value, "key"),
				epoch: expectNumber(value, "epoch"),
				seq: expectNumber(value, "seq"),
			};
		case "transcript_items":
			return {
				kind: "transcript_items",
				key: expectWorkerKey(value, "key"),
				epoch: expectNumber(value, "epoch"),
				seq: expectNumber(value, "seq"),
				items: expectTranscriptItems(value.items),
			};
		case "transcript_end":
			return {
				kind: "transcript_end",
				key: expectWorkerKey(value, "key"),
				epoch: expectNumber(value, "epoch"),
				seq: expectNumber(value, "seq"),
				watermark: expectNumber(value, "watermark"),
				model: expectOptionalString(value, "model"),
			};
		case "transcript_append":
			return {
				kind: "transcript_append",
				key: expectWorkerKey(value, "key"),
				epoch: expectNumber(value, "epoch"),
				seq: expectNumber(value, "seq"),
				items: expectTranscriptItems(value.items),
				watermark: expectNumber(value, "watermark"),
				model: expectOptionalString(value, "model"),
			};
		case "transcript_reset":
			return {
				kind: "transcript_reset",
				key: expectWorkerKey(value, "key"),
				epoch: expectNumber(value, "epoch"),
				seq: expectNumber(value, "seq"),
				reason: expectString(value, "reason"),
			};
		case "prompt_accepted":
			return {
				kind: "prompt_accepted",
				key: expectWorkerKey(value, "key"),
				ref: expectString(value, "ref"),
				cmdId: expectString(value, "cmdId"),
			};
		case "prompt_result":
			return {
				kind: "prompt_result",
				key: expectWorkerKey(value, "key"),
				ref: expectString(value, "ref"),
				cmdId: expectString(value, "cmdId"),
				ok: expectBoolean(value, "ok"),
				payload: "payload" in value ? value.payload : undefined,
				error: expectOptionalString(value, "error"),
			};
		case "control_rejected": {
			const code = value.code;
			const codes: readonly AttachControlRejectCode[] = [
				"lease_required",
				"stale_lease",
				"stale_generation",
				"foreign_client",
				"duplicate",
				"out_of_order",
				"busy",
				"forbidden",
				"unknown_worker",
				"internal",
			];
			if (typeof code !== "string" || !codes.includes(code as AttachControlRejectCode)) {
				throw new AttachProtocolError("malformed", 'field "code" is not a valid rejection code');
			}
			return {
				kind: "control_rejected",
				key: expectWorkerKey(value, "key"),
				cmdId: expectOptionalString(value, "cmdId"),
				ref: expectOptionalString(value, "ref"),
				code: code as AttachControlRejectCode,
				message: expectString(value, "message"),
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
		case "lease_granted":
			return { type, key, generation: expectNumber(value, "generation") };
		case "lease_expired":
		case "lease_revoked":
			return { type, key, reason: expectString(value, "reason") };
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
// Transcript entry bounding
// ---------------------------------------------------------------------------

/**
 * Bound a transcript entry for the wire: long strings inside the message are
 * truncated to `ATTACH_TRANSCRIPT_MAX_STRING_CHARS` and, when the encoded
 * entry still exceeds `ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES`, every string in
 * the message is shrunk until the encoded entry fits the per-entry budget.
 * Applied to every message shape (content arrays, nested objects, and
 * non-content kinds such as `bashExecution`). Mutates nothing — returns the
 * same entry when no truncation was needed, otherwise a new entry.
 */
export function boundAttachTranscriptEntry(entry: SessionMessageEntry): SessionMessageEntry {
	return boundAttachTranscriptEntryWithSize(entry).entry;
}

/**
 * Bound one entry and measure its encoded JSON byte length (UTF-8, after
 * `JSON.stringify`, so escape inflation and multibyte text count) in a single
 * pass — byte-based chunking reuses the measurement instead of re-serializing.
 */
function boundAttachTranscriptEntryWithSize(entry: SessionMessageEntry): { entry: SessionMessageEntry; bytes: number } {
	const boundedMessage = boundMessageForWire(entry.message);
	const candidate = boundedMessage === entry.message ? entry : { ...entry, message: boundedMessage };
	const bytes = encodedAttachJsonBytes(candidate);
	if (bytes <= ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES) {
		return { entry: candidate, bytes };
	}
	// The char pass only bounds strings inside `content`, leaves short content
	// untouched, and skips non-content messages entirely, so many bounded
	// strings, nested objects, or a non-content message can still exceed the
	// byte budget. Shrink every string in the message, halving the per-string
	// cap, until the encoded entry fits.
	return boundEntryToBudget(entry, ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
}

/** The frame a chunk will be carried in: its kind and fixed fields. */
export interface AttachTranscriptChunkFrame {
	/** Frame kind; `transcript_append` frames also carry a `watermark` field. */
	readonly kind: "transcript_items" | "transcript_append";
	readonly key: AttachWorkerKey;
	readonly epoch: number;
}

/**
 * Bound an array of transcript entries for the wire, splitting into chunks
 * that each fit a single encoded frame. Chunks split on the ENCODED byte
 * budget (`ATTACH_MAX_FRAME_BYTES`, including the frame wrapper
 * kind/key/epoch/seq, per-entry JSON, separators, and the trailing newline),
 * with `ATTACH_TRANSCRIPT_ITEMS_PER_FRAME` as a maximum count. Entry order is
 * preserved across chunks and every returned chunk encodes within the frame
 * budget. Throws `AttachProtocolError('frame_too_large')` when a single entry
 * cannot fit a frame even after bounding — such an entry can never be
 * transmitted, so the caller must fail the connection rather than emit an
 * oversized frame.
 */
export function boundAttachTranscriptItems(
	items: readonly SessionMessageEntry[],
	frame: AttachTranscriptChunkFrame,
): readonly (readonly SessionMessageEntry[])[] {
	const shellBytes = attachTranscriptShellBytes(frame);
	const chunks: SessionMessageEntry[][] = [];
	let chunk: SessionMessageEntry[] | null = null;
	let chunkBytes = 0;
	for (const item of items) {
		const { entry, bytes } = boundAttachTranscriptEntryWithSize(item);
		// One byte per entry reserves the JSON comma separator; the leading
		// entry's unused comma keeps the estimate conservative.
		const added = bytes + 1;
		if (
			chunk !== null &&
			(chunk.length >= ATTACH_TRANSCRIPT_ITEMS_PER_FRAME || chunkBytes + added > ATTACH_MAX_FRAME_BYTES)
		) {
			chunks.push(chunk);
			chunk = null;
		}
		if (chunk === null) {
			if (shellBytes + added > ATTACH_MAX_FRAME_BYTES) {
				throw new AttachProtocolError(
					"frame_too_large",
					`transcript entry encodes to ${bytes} bytes and cannot fit a single frame`,
				);
			}
			chunk = [];
			chunkBytes = shellBytes;
		}
		chunk.push(entry);
		chunkBytes += added;
	}
	if (chunk !== null) chunks.push(chunk);
	return chunks;
}

/**
 * Encoded size of a transcript chunk frame with an empty `items` array: the
 * wrapper fields (kind/key/epoch/seq, plus watermark on append frames), the
 * array brackets, and the trailing newline. `seq` and `watermark` are
 * budgeted at `Number.MAX_SAFE_INTEGER` (16 digits), which is at least as
 * wide as any real counter the server can produce (`++seq` on an exact
 * integer), so the estimated frame is an upper bound on the real frame.
 */
function attachTranscriptShellBytes(frame: AttachTranscriptChunkFrame): number {
	const shell: AttachServerMessage =
		frame.kind === "transcript_append"
			? {
					kind: "transcript_append",
					key: frame.key,
					epoch: frame.epoch,
					seq: Number.MAX_SAFE_INTEGER,
					items: [],
					watermark: Number.MAX_SAFE_INTEGER,
				}
			: {
					kind: "transcript_items",
					key: frame.key,
					epoch: frame.epoch,
					seq: Number.MAX_SAFE_INTEGER,
					items: [],
				};
	return Buffer.byteLength(JSON.stringify(shell), "utf8") + 1;
}

/** Exact UTF-8 byte length of a value's JSON serialization (escape-inflated). */
function encodedAttachJsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Shrink every string in a message (recursively, all shapes) until the whole
 * entry encodes within `budget`, halving the per-string character cap each
 * pass. Bounded by `ATTACH_TRANSCRIPT_MAX_STRING_CHARS` down to 1 (≤ 15
 * passes), so a realistic message always converges.
 */
function boundEntryToBudget(entry: SessionMessageEntry, budget: number): { entry: SessionMessageEntry; bytes: number } {
	let cap = ATTACH_TRANSCRIPT_MAX_STRING_CHARS;
	let candidate: SessionMessageEntry = { ...entry, message: truncateAllStrings(entry.message, cap) as AgentMessage };
	let bytes = encodedAttachJsonBytes(candidate);
	while (bytes > budget && cap > 1) {
		cap = Math.ceil(cap / 2);
		candidate = { ...entry, message: truncateAllStrings(candidate.message, cap) as AgentMessage };
		bytes = encodedAttachJsonBytes(candidate);
	}
	return { entry: candidate, bytes };
}

/**
 * Deep copy of a JSON-ish value with every string truncated to at most `max`
 * characters (code-point safe). Values that serialize themselves (`toJSON`)
 * are left untouched.
 */
function truncateAllStrings(value: unknown, max: number): unknown {
	if (typeof value === "string") {
		return value.length <= max ? value : `${boundStringSlice(value, max)}\n…[truncated]`;
	}
	if (Array.isArray(value)) {
		let mutated: unknown[] | null = null;
		for (let i = 0; i < value.length; i++) {
			const next = truncateAllStrings(value[i], max);
			if (next !== value[i]) {
				if (mutated === null) mutated = value.slice();
				mutated[i] = next;
			}
		}
		return mutated ?? value;
	}
	if (typeof value === "object" && value !== null) {
		if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
		const record = value as Record<string, unknown>;
		let mutated: Record<string, unknown> | null = null;
		for (const key of Object.keys(record)) {
			const next = truncateAllStrings(record[key], max);
			if (next !== record[key]) {
				if (mutated === null) mutated = { ...record };
				mutated[key] = next;
			}
		}
		return mutated ?? value;
	}
	return value;
}

/** `value.slice(0, max)` without ever splitting a surrogate pair (a lone high
 *  surrogate would serialize as a `\udXXX` escape and decode as a broken code
 *  point). */
function boundStringSlice(value: string, max: number): string {
	if (value.length <= max) return value;
	const sliced = value.slice(0, max);
	const last = sliced.charCodeAt(sliced.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Truncate long strings in a message to keep the encoded entry bounded.
 * Non-content message kinds (bashExecution, pythonExecution, …) carry their
 * payload in role-specific fields and are returned untouched — their strings
 * are already bounded by the executor. The per-entry ENCODED byte budget is
 * enforced separately by {@link boundAttachTranscriptEntry}, which falls back
 * to {@link truncateAllStrings} over every field when this pass is not enough.
 */
function boundMessageForWire(message: AgentMessage): AgentMessage {
	if (!("content" in message)) return message;
	const max = ATTACH_TRANSCRIPT_MAX_STRING_CHARS;

	const boundString = (value: string): string => {
		return value.length <= max ? value : `${boundStringSlice(value, max)}\n…[truncated]`;
	};

	const boundBlocks = (blocks: readonly unknown[]): readonly unknown[] | null => {
		let mutated: unknown[] | null = null;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			if (typeof block !== "object" || block === null) continue;
			const next: Record<string, unknown> = {};
			let blockChanged = false;
			for (const [key, value] of Object.entries(block)) {
				if (typeof value === "string") {
					const bounded = boundString(value);
					if (bounded !== value) {
						next[key] = bounded;
						blockChanged = true;
					} else {
						next[key] = value;
					}
				} else if (Array.isArray(value)) {
					const nested = boundBlocks(value);
					if (nested !== null) {
						next[key] = nested;
						blockChanged = true;
					} else {
						next[key] = value;
					}
				} else {
					next[key] = value;
				}
			}
			if (blockChanged) {
				if (mutated === null) mutated = blocks.slice();
				mutated[i] = next;
			}
		}
		return mutated;
	};

	const content = message.content;
	if (typeof content === "string") {
		const bounded = boundString(content);
		return bounded === content ? message : ({ ...message, content: bounded } as AgentMessage);
	}
	if (Array.isArray(content)) {
		const bounded = boundBlocks(content);
		return bounded === null ? message : ({ ...message, content: bounded } as AgentMessage);
	}
	return message;
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
	#chunks: Buffer[] = [];
	#buffered = 0;

	/** Feed a chunk; returns complete frames (without their trailing newline). */
	push(chunk: Buffer): Buffer[] {
		const frames: Buffer[] = [];
		let start = 0;
		for (let i = 0; i < chunk.byteLength; i++) {
			if (chunk[i] === ATTACH_FRAME_DELIMITER) {
				const frame = Buffer.concat([...this.#chunks, chunk.subarray(start, i)]);
				this.#chunks = [];
				this.#buffered = 0;
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
			this.#buffered += rest.byteLength;
			if (this.#buffered > ATTACH_MAX_FRAME_BYTES) {
				throw new AttachProtocolError(
					"frame_too_large",
					`partial frame reached ${this.#buffered} bytes; limit is ${ATTACH_MAX_FRAME_BYTES}`,
				);
			}
			this.#chunks.push(Buffer.from(rest));
		}
		return frames;
	}

	/** Bytes currently buffered awaiting a newline. */
	get pendingBytes(): number {
		return this.#buffered;
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
	#items: T[] = [];
	#totalBytes = 0;
	#sizeOf: (item: T) => number;
	#maxFrames: number;
	#maxBytes: number;

	constructor(
		sizeOf: (item: T) => number,
		maxFrames = ATTACH_WRITE_QUEUE_MAX_FRAMES,
		maxBytes = ATTACH_WRITE_QUEUE_HIGH_WATER_BYTES,
	) {
		this.#sizeOf = sizeOf;
		this.#maxFrames = maxFrames;
		this.#maxBytes = maxBytes;
	}

	/** True iff the item was accepted; false when a cap is exceeded. */
	enqueue(item: T): boolean {
		const size = this.#sizeOf(item);
		if (this.#items.length >= this.#maxFrames || this.#totalBytes + size > this.#maxBytes) {
			return false;
		}
		this.#items.push(item);
		this.#totalBytes += size;
		return true;
	}

	/** Remove and return the oldest item, or undefined when empty. */
	dequeue(): T | undefined {
		const item = this.#items.shift();
		if (item !== undefined) {
			this.#totalBytes -= this.#sizeOf(item);
		}
		return item;
	}

	get length(): number {
		return this.#items.length;
	}

	get bytes(): number {
		return this.#totalBytes;
	}

	get isOverHighWater(): boolean {
		return this.length >= this.#maxFrames || this.bytes >= this.#maxBytes;
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
 *
 * `currentTool` / `currentToolArgs` / `lastIntent` are OMITTED when their
 * bounded value is empty or whitespace-only, so clients never receive a
 * `tool: ` / `intent: ` row with no content (the fields are optional on the
 * wire and the decoder already handles absent fields).
 */
export function sanitizeAttachProgress(input: AttachProgressInput): AttachProgressInput {
	const optional = (value: string | undefined, max: number): string | undefined => {
		if (value === undefined) return undefined;
		const bounded = boundedLine(value, max);
		return bounded.trim().length > 0 ? bounded : undefined;
	};
	const currentTool = optional(input.currentTool, ATTACH_PROGRESS_MAX_TOOL_LENGTH);
	const currentToolArgs = optional(input.currentToolArgs, ATTACH_PROGRESS_MAX_TOOL_ARGS_LENGTH);
	const lastIntent = optional(input.lastIntent, ATTACH_PROGRESS_MAX_INTENT_LENGTH);
	return {
		outputTail: input.outputTail
			.slice(-ATTACH_PROGRESS_MAX_OUTPUT_LINES)
			.map(line => boundedLine(line, ATTACH_PROGRESS_MAX_LINE_LENGTH)),
		...(currentTool !== undefined && { currentTool }),
		...(currentToolArgs !== undefined && { currentToolArgs }),
		...(lastIntent !== undefined && { lastIntent }),
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

/** True iff the client role may submit controls (pane/director). */
export function isControllerRole(role: AttachClientInfo["role"]): boolean {
	return role === "pane" || role === "director";
}
