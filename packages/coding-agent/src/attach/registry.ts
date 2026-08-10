/**
 * attach/registry.ts — worker registry backing the local worker-attach substrate.
 *
 * Maps a `(workerId, ownerScope)` key to the live worker (the harness
 * `AgentSession` instance) plus the serialized follow-up/abort callbacks the
 * substrate drives. This is the single source of truth for the attach server's
 * snapshots and event stream.
 *
 * Ownership and lifecycle rules:
 * - A worker is registered when it becomes live (spawn) and unregistered only
 *   on harness teardown (kill / mode-exit / unrecoverable failure). Detaching
 *   a client NEVER unregisters a worker — `detach` only decrements the
 *   attached-client count.
 * - Follow-ups are serialized per key: exactly one in-flight follow-up at a
 *   time; a second one is rejected with `busy`. Abort cancels the in-flight
 *   follow-up through the abort callback (which never kills the worker itself).
 */
import {
	type AttachEvent,
	type AttachProgressInput,
	AttachProtocolError,
	type AttachSessionEntry,
	type AttachSnapshot,
	type AttachWorkerKey,
	type AttachWorkerState,
} from "./protocol";

/** Outcome of one serialized follow-up, as delivered to subscribers. */
export interface AttachFollowUpResult {
	readonly ok: boolean;
	readonly payload?: unknown;
	readonly error?: string;
}

/**
 * Runs one follow-up prompt for a worker. Implementations MUST serialize per
 * worker (the registry already rejects concurrent follow-ups with `busy`); the
 * harness wiring routes this through the same turn-job queue as `vibe_send`.
 */
export type AttachFollowUpCallback = (
	key: AttachWorkerKey,
	payload: unknown,
	options?: { timeoutMs?: number },
) => Promise<AttachFollowUpResult>;

/**
 * Cancels the in-flight follow-up for a worker. Returns true when a follow-up
 * was actually in flight and cancelled. Must never kill the worker.
 */
export type AttachAbortCallback = (key: AttachWorkerKey, reason?: string) => Promise<boolean>;

export interface AttachRegistryOptions {
	/** Follow-up runner (see {@link AttachFollowUpCallback}). */
	followUp: AttachFollowUpCallback;
	/** Optional abort runner (see {@link AttachAbortCallback}). */
	abort?: AttachAbortCallback;
	/** Clock injection for deterministic tests. */
	now?: () => number;
}

export type AttachEventListener = (event: AttachEvent) => void;

interface MutableEntry {
	key: AttachWorkerKey;
	state: AttachWorkerState;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number | null;
	/** 0 or 1 while a follow-up is in flight (serialized per key). */
	pendingFollowUps: number;
	summary: string | null;
	/** The harness's live AgentSession instance (opaque to the substrate). */
	liveSession: unknown;
}

const EMPTY_ATTACHMENTS: ReadonlySet<string> = new Set();

/**
 * Registry of attachable workers for one process. One instance per owner
 * scope, owned by the harness wiring; the attach server reads it.
 */
export class AttachRegistry {
	readonly #entries = new Map<string, MutableEntry>();
	readonly #attachments = new Map<string, Set<string>>();
	readonly #listeners = new Set<AttachEventListener>();
	readonly #followUp: AttachFollowUpCallback;
	readonly #abort: AttachAbortCallback | undefined;
	readonly #now: () => number;

	constructor(options: AttachRegistryOptions) {
		this.#followUp = options.followUp;
		this.#abort = options.abort;
		this.#now = options.now ?? Date.now;
	}

	/** Number of registered workers. */
	get size(): number {
		return this.#entries.size;
	}

	// -----------------------------------------------------------------------
	// Registration lifecycle (called by the harness wiring only)
	// -----------------------------------------------------------------------

	/**
	 * Register a live worker. Emits `registered`. Throws on duplicate keys —
	 * a worker id can never alias within one owner scope.
	 */
	register(key: AttachWorkerKey, liveSession: unknown, summary?: string | null): void {
		const keyString = attachKeyString(key);
		if (this.#entries.has(keyString)) {
			throw new Error(`Attach worker already registered: ${keyString}`);
		}
		const now = this.#now();
		const entry: MutableEntry = {
			key,
			state: "starting",
			createdAt: now,
			updatedAt: now,
			lastActivityAt: null,
			pendingFollowUps: 0,
			summary: summary ?? null,
			liveSession,
		};
		this.#entries.set(keyString, entry);
		this.#emit({ type: "registered", key, entry: this.#wireEntry(entry) });
	}

	/** Remove a worker (kill / mode-exit / unrecoverable failure). */
	unregister(key: AttachWorkerKey, reason: string): boolean {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) return false;
		this.#entries.delete(keyString);
		this.#attachments.delete(keyString);
		this.#emit({ type: "removed", key, reason });
		return true;
	}

	/** True when a worker is currently registered. */
	has(key: AttachWorkerKey): boolean {
		return this.#entries.has(attachKeyString(key));
	}

	/** The live harness session for a worker, or undefined. */
	liveSession(key: AttachWorkerKey): unknown {
		return this.#entries.get(attachKeyString(key))?.liveSession;
	}

	// -----------------------------------------------------------------------
	// State streaming
	// -----------------------------------------------------------------------

	/** Update the worker's lifecycle state; emits `state` + `updated`. */
	updateState(key: AttachWorkerKey, state: AttachWorkerState, summary?: string | null): void {
		const entry = this.#entries.get(attachKeyString(key));
		if (!entry) return;
		const now = this.#now();
		entry.state = state;
		entry.updatedAt = now;
		if (summary !== undefined) entry.summary = summary ?? null;
		this.#emit({ type: "state", key, state, at: now });
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
	}

	/** Update the worker's one-line summary without touching state. */
	setSummary(key: AttachWorkerKey, summary: string | null): void {
		const entry = this.#entries.get(attachKeyString(key));
		if (!entry || entry.summary === summary) return;
		entry.summary = summary;
		entry.updatedAt = this.#now();
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
	}

	/** Record activity (follow-up accepted / result produced). */
	touch(key: AttachWorkerKey): void {
		const entry = this.#entries.get(attachKeyString(key));
		if (!entry) return;
		entry.lastActivityAt = this.#now();
		entry.updatedAt = entry.lastActivityAt;
	}

	// -----------------------------------------------------------------------
	// Snapshots
	// -----------------------------------------------------------------------

	/** Immutable snapshot of every registered worker. */
	snapshot(): AttachSnapshot {
		const now = this.#now();
		const sessions: AttachSessionEntry[] = [];
		for (const entry of this.#entries.values()) {
			sessions.push(this.#wireEntry(entry));
		}
		return { version: 1, generatedAt: now, sessions };
	}

	// -----------------------------------------------------------------------
	// Subscriptions
	// -----------------------------------------------------------------------

	/** Subscribe to registry events; returns the unsubscribe function. */
	subscribe(listener: AttachEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// -----------------------------------------------------------------------
	// Attached-client accounting (server-driven; never unregisters)
	// -----------------------------------------------------------------------

	/** Record that `clientId` is attached to `key`. */
	attach(key: AttachWorkerKey, clientId: string): void {
		const keyString = attachKeyString(key);
		if (!this.#entries.has(keyString)) return;
		let set = this.#attachments.get(keyString);
		if (!set) {
			set = new Set();
			this.#attachments.set(keyString, set);
		}
		set.add(clientId);
	}

	/**
	 * Emit a live-progress event for a registered worker. `fields` MUST already
	 * be sanitized to wire bounds (the bridge sanitizes before calling); the
	 * event is ignored when the worker is not registered.
	 */
	emitProgress(key: AttachWorkerKey, fields: Required<AttachProgressInput>, at: number): void {
		if (!this.#entries.has(attachKeyString(key))) return;
		this.#emit({ type: "progress", key, at, ...fields });
	}

	/** Drop one client attachment; does NOT unregister the worker. */
	detach(key: AttachWorkerKey, clientId: string): void {
		const keyString = attachKeyString(key);
		const set = this.#attachments.get(keyString);
		if (!set) return;
		set.delete(clientId);
		if (set.size === 0) this.#attachments.delete(keyString);
	}

	// -----------------------------------------------------------------------
	// Follow-up / abort (serialized per key)
	// -----------------------------------------------------------------------

	/**
	 * Run one follow-up for a worker. Rejects with `unknown_worker` when the
	 * worker is not registered and `busy` when another follow-up for the same
	 * key is still in flight. Emits `follow_up_accepted` before running and
	 * `follow_up_result` after. `ref` correlates the result.
	 */
	async followUp(key: AttachWorkerKey, ref: string, payload: unknown, timeoutMs?: number): Promise<void> {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) {
			throw new AttachProtocolError("unknown_worker", `no such attach worker: ${attachKeyString(key)}`);
		}
		if (entry.pendingFollowUps > 0) {
			throw new AttachProtocolError("busy", `follow-up already in flight for ${attachKeyString(key)}`);
		}
		const now = this.#now();
		entry.pendingFollowUps = 1;
		entry.lastActivityAt = now;
		entry.updatedAt = now;
		this.#emit({ type: "follow_up_accepted", key, ref });
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
		let result: AttachFollowUpResult;
		try {
			result = await this.#followUp(key, payload, { timeoutMs });
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		entry.pendingFollowUps = 0;
		entry.lastActivityAt = this.#now();
		entry.updatedAt = entry.lastActivityAt;
		this.#emit({
			type: "follow_up_result",
			key,
			ref,
			ok: result.ok,
			payload: result.payload,
			error: result.error,
		});
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
	}

	/**
	 * Abort the in-flight follow-up for a worker (best-effort). Returns true
	 * when a follow-up was in flight. Never kills the worker.
	 *
	 * The pending-follow-up counter is NOT touched here: the in-flight
	 * `followUp()` owns that slot and clears it only when ITS callback settles,
	 * so an abort that resolves before the turn winds down can never admit a
	 * concurrent follow-up.
	 */
	async abort(key: AttachWorkerKey, reason?: string): Promise<boolean> {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) return false;
		const hadFollowUp = entry.pendingFollowUps > 0;
		if (hadFollowUp && this.#abort) {
			try {
				await this.#abort(key, reason);
			} catch {
				// Abort is best-effort; the follow-up result will surface the error.
			}
		}
		this.#emit({ type: "abort_accepted", key, ref: undefined });
		return hadFollowUp;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	#wireEntry(entry: MutableEntry): AttachSessionEntry {
		const attachments = this.#attachments.get(attachKeyString(entry.key)) ?? EMPTY_ATTACHMENTS;
		return {
			key: entry.key,
			state: entry.state,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			lastActivityAt: entry.lastActivityAt,
			pendingFollowUps: entry.pendingFollowUps,
			attachedClients: attachments.size,
			summary: entry.summary,
		};
	}

	#emit(event: AttachEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

/** Stable registry/server key string: `ownerScope \0 workerId`. */
export function attachKeyString(key: AttachWorkerKey): string {
	return `${key.ownerScope}\u0000${key.workerId}`;
}

/** Parse a key string produced by {@link attachKeyString}. */
export function parseAttachKeyString(keyString: string): AttachWorkerKey {
	const separator = keyString.indexOf("\u0000");
	if (separator < 0) return { ownerScope: "", workerId: keyString };
	return { ownerScope: keyString.slice(0, separator), workerId: keyString.slice(separator + 1) };
}
