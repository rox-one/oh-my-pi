/**
 * attach/registry.ts — worker registry backing the local worker-attach substrate.
 *
 * One {@link AttachRegistry} exists per owner scope and holds:
 *
 * - the registered worker entries (state, summary, activity, attachments);
 * - each worker's typed live-session presentation source
 *   ({@link AttachLiveSessionSource} — never the raw AgentSession);
 * - the atomic controller leases (one pane client per worker, reject-not-
 *   replace, disconnect grace, resume-by-proof);
 * - the bounded command-acknowledgement cache (reconnect recovery without
 *   double execution);
 * - the serialized follow-up/prompt runner shared with `vibe_send`.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AttachLiveSessionSource } from "./live-session";
import {
	ATTACH_CMD_ACK_CACHE_SIZE,
	ATTACH_LEASE_GRACE_MS,
	type AttachEvent,
	type AttachLease,
	type AttachProgressInput,
	AttachProtocolError,
	type AttachSessionEntry,
	type AttachSnapshot,
	type AttachWorkerKey,
	type AttachWorkerState,
	generateAttachLeaseId,
	generateAttachLeaseProof,
} from "./protocol";

/** Outcome of one serialized prompt/follow-up, as delivered to subscribers. */
export interface AttachPromptOutcome {
	readonly ok: boolean;
	readonly payload?: unknown;
	readonly error?: string;
}

/** Legacy name for {@link AttachPromptOutcome} (director follow-up path). */
export type AttachFollowUpResult = AttachPromptOutcome;

/** Result of claiming the serialized prompt slot for a worker (pane path). */
export type AttachClaimPromptResult =
	| { status: "busy" }
	| { status: "joined"; outcome: Promise<AttachPromptOutcome> }
	| { status: "started"; outcome: Promise<AttachPromptOutcome> };

/**
 * Runs one prompt for a worker. Implementations MUST serialize per worker
 * (the registry already rejects concurrent prompts with `busy`); the harness
 * wiring routes this through the same turn-job queue as `vibe_send`.
 */
export type AttachPromptCallback = (
	key: AttachWorkerKey,
	text: string,
	options?: { timeoutMs?: number },
) => Promise<AttachPromptOutcome>;

/** Serialized follow-up for a worker (director path; payload = prompt text). */
export type AttachFollowUpCallback = (
	key: AttachWorkerKey,
	payload: unknown,
	options?: { timeoutMs?: number },
) => Promise<AttachPromptOutcome>;

/**
 * Cancels the in-flight prompt for a worker. Returns true when a prompt was
 * actually in flight and cancelled. Must never kill the worker.
 */
export type AttachAbortCallback = (key: AttachWorkerKey, reason?: string) => Promise<boolean>;

export interface AttachRegistryOptions {
	/** Serialized prompt runner (pane path; same queue as vibe_send). */
	runPrompt: AttachPromptCallback;
	/** Serialized follow-up runner (director path). */
	followUp?: AttachFollowUpCallback;
	/** Abort runner. Must never kill the worker. */
	abort?: AttachAbortCallback;
	/**
	 * Live session source provider, resolved LAZILY per lookup. The worker
	 * session materializes AFTER registration (the executor starts it), so a
	 * snapshot taken at register time would stay null forever; the provider
	 * makes {@link liveSession} always fresh. When absent, the value passed to
	 * {@link register} is returned (test injection).
	 */
	liveSessionOf?: (key: AttachWorkerKey) => AttachLiveSessionSource | null;
	/** Clock injection for deterministic tests. */
	now?: () => number;
	/** Disconnect grace for controller leases (ms). Tests shorten this. */
	leaseGraceMs?: number;
}

export type AttachEventListener = (event: AttachEvent) => void;

interface MutableEntry {
	key: AttachWorkerKey;
	state: AttachWorkerState;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number | null;
	/** 0 or 1 while a prompt/follow-up is in flight (serialized per key). */
	pendingFollowUps: number;
	summary: string | null;
	/** Registration-time snapshot of the live session source (fallback when no
	 *  lazy provider is configured; see {@link AttachRegistryOptions.liveSessionOf}). */
	liveSession: AttachLiveSessionSource | null;
}

interface LeaseState {
	leaseId: string;
	proof: string;
	generation: number;
	clientId: string;
	acquiredAt: number;
	graceMs: number;
}

const EMPTY_ATTACHMENTS: ReadonlySet<string> = new Set();

export type AttachViewAcquireResult =
	| { ok: true; lease: AttachLease }
	| {
			ok: false;
			code: "lease_busy" | "unknown_worker" | "stale_resume" | "internal";
			message: string;
			holder?: { generation: number; expiresInMs: number };
	  };

/**
 * Registry of attachable workers for one process. One instance per owner
 * scope, owned by the harness wiring; the attach server reads it.
 */
export class AttachRegistry {
	readonly #entries = new Map<string, MutableEntry>();
	readonly #attachments = new Map<string, Set<string>>();
	readonly #listeners = new Set<AttachEventListener>();
	readonly #runPrompt: AttachPromptCallback;
	readonly #followUp: AttachFollowUpCallback | undefined;
	readonly #abort: AttachAbortCallback | undefined;
	readonly #liveSessionOf: ((key: AttachWorkerKey) => AttachLiveSessionSource | null) | undefined;
	readonly #now: () => number;
	readonly #leaseGraceMs: number;
	/** Controller leases per worker key string. */
	readonly #leases = new Map<string, LeaseState>();
	/** Disconnect-grace timers per worker key string. */
	readonly #graceTimers = new Map<string, NodeJS.Timeout>();
	/**
	 * Bounded command-acknowledgement cache per worker: `cmdId -> outcome`.
	 * Lets a reconnect replay whether an accepted input ran without executing
	 * it twice. Bounded FIFO per worker (see {@link ATTACH_CMD_ACK_CACHE_SIZE}).
	 */
	readonly #cmdCache = new Map<string, Map<string, AttachPromptOutcome>>();
	/**
	 * In-flight pane-prompt command identity + SHARED outcome per worker key
	 * string. A reconnect that replays the same `cmdId` while the original run
	 * is still in flight joins this outcome instead of re-executing or getting
	 * `busy`. Populated by {@link claimPrompt}; released (after the outcome is
	 * cached) when the run settles.
	 */
	readonly #activeCmd = new Map<string, { cmdId: string; outcome: Promise<AttachPromptOutcome> }>();

	constructor(options: AttachRegistryOptions) {
		this.#runPrompt = options.runPrompt;
		this.#followUp = options.followUp;
		this.#abort = options.abort;
		this.#liveSessionOf = options.liveSessionOf;
		this.#now = options.now ?? Date.now;
		this.#leaseGraceMs = options.leaseGraceMs ?? ATTACH_LEASE_GRACE_MS;
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
	register(key: AttachWorkerKey, liveSession: AttachLiveSessionSource | null, summary?: string | null): void {
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
		this.#releaseLease(keyString, `worker removed: ${reason}`);
		this.#cmdCache.delete(keyString);
		this.#activeCmd.delete(keyString);
		this.#emit({ type: "removed", key, reason });
		return true;
	}

	/** True when a worker is currently registered. */
	has(key: AttachWorkerKey): boolean {
		return this.#entries.has(attachKeyString(key));
	}

	/**
	 * The live session presentation source for a worker, or null. Resolved
	 * LAZILY through the provider when one was configured (the worker session
	 * materializes after registration); otherwise the snapshot passed to
	 * {@link register} is returned (test injection).
	 */
	liveSession(key: AttachWorkerKey): AttachLiveSessionSource | null {
		if (this.#liveSessionOf !== undefined) {
			return this.#liveSessionOf(key) ?? null;
		}
		return this.#entries.get(attachKeyString(key))?.liveSession ?? null;
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

	/** Record activity (prompt accepted / result produced). */
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
		return { version: 2, generatedAt: now, sessions };
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
		const entry = this.#entries.get(keyString);
		if (!entry) return;
		let set = this.#attachments.get(keyString);
		if (!set) {
			set = new Set();
			this.#attachments.set(keyString, set);
		}
		if (set.has(clientId)) return; // duplicate attach: no membership change
		set.add(clientId);
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
	}

	/**
	 * Emit a live-progress event for a registered worker. `fields` MUST already
	 * be sanitized to wire bounds (the bridge sanitizes before calling); the
	 * event is ignored when the worker is not registered.
	 */
	emitProgress(key: AttachWorkerKey, fields: AttachProgressInput, at: number): void {
		if (!this.#entries.has(attachKeyString(key))) return;
		this.#emit({ type: "progress", key, at, ...fields });
	}

	/** Drop one client attachment; does NOT unregister the worker. */
	detach(key: AttachWorkerKey, clientId: string): void {
		const keyString = attachKeyString(key);
		const set = this.#attachments.get(keyString);
		if (!set?.has(clientId)) return; // absent detach: no membership change
		set.delete(clientId);
		if (set.size === 0) this.#attachments.delete(keyString);
		const entry = this.#entries.get(keyString);
		if (!entry) return;
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
	}

	// -----------------------------------------------------------------------
	// Controller leases (one pane client per worker)
	// -----------------------------------------------------------------------

	/**
	 * Atomically acquire the controller lease for a worker — reject-not-
	 * replace. With `resume`, re-grants the EXISTING lease only when the
	 * presented id + proof + generation match the current holder (the same
	 * client instance reconnecting within its disconnect grace). Emits
	 * `lease_granted` on every successful (re)acquisition.
	 */
	acquireView(
		key: AttachWorkerKey,
		clientId: string,
		resume?: { leaseId: string; proof: string; generation: number },
	): AttachViewAcquireResult {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) {
			return { ok: false, code: "unknown_worker", message: `no such attach worker: ${attachKeyString(key)}` };
		}
		const existing = this.#leases.get(keyString);
		if (existing) {
			if (
				resume &&
				resume.leaseId === existing.leaseId &&
				resume.proof === existing.proof &&
				resume.generation === existing.generation
			) {
				// Same client instance reclaiming its own lease: bump generation,
				// cancel the grace timer, and hand back the (new) lease.
				this.#cancelGrace(keyString);
				existing.generation += 1;
				existing.clientId = clientId;
				existing.acquiredAt = this.#now();
				const lease: AttachLease = {
					leaseId: existing.leaseId,
					proof: existing.proof,
					generation: existing.generation,
					graceMs: existing.graceMs,
				};
				this.#emit({ type: "lease_granted", key, generation: existing.generation });
				return { ok: true, lease };
			}
			return {
				ok: false,
				code: "lease_busy",
				message: `worker ${attachKeyString(key)} is controlled by another pane client`,
				holder: this.#leaseHolderInfo(keyString),
			};
		}
		if (resume) {
			// No lease to resume — the holder's grace expired (or never existed).
			return { ok: false, code: "stale_resume", message: "no lease to resume (grace expired?)" };
		}
		const now = this.#now();
		const lease: LeaseState = {
			leaseId: generateAttachLeaseId(),
			proof: generateAttachLeaseProof(),
			generation: 1,
			clientId,
			acquiredAt: now,
			graceMs: this.#leaseGraceMs,
		};
		this.#leases.set(keyString, lease);
		this.#emit({
			type: "lease_granted",
			key,
			generation: 1,
		});
		return {
			ok: true,
			lease: { leaseId: lease.leaseId, proof: lease.proof, generation: lease.generation, graceMs: lease.graceMs },
		};
	}

	/**
	 * Explicitly release the controller lease (detach / shutdown / removal).
	 * Requires the holder's client id AND proof; a foreign client cannot steal
	 * the lease. Emits `lease_revoked`.
	 */
	releaseView(key: AttachWorkerKey, clientId: string, proof: string, reason: string): boolean {
		const keyString = attachKeyString(key);
		const lease = this.#leases.get(keyString);
		if (!lease || lease.clientId !== clientId || lease.proof !== proof) return false;
		this.#releaseLease(keyString, reason);
		return true;
	}

	/**
	 * Start the disconnect grace for a holder whose connection closed. The
	 * lease survives for `graceMs` so the SAME client instance can resume;
	 * expiry releases it (emits `lease_expired`).
	 */
	beginGrace(key: AttachWorkerKey, clientId: string): boolean {
		const keyString = attachKeyString(key);
		const lease = this.#leases.get(keyString);
		if (!lease || lease.clientId !== clientId) return false;
		this.#cancelGrace(keyString);
		const timer = setTimeout(() => {
			this.#graceTimers.delete(keyString);
			this.#releaseLease(keyString, "disconnect grace expired");
		}, lease.graceMs);
		timer.unref?.();
		this.#graceTimers.set(keyString, timer);
		return true;
	}

	/** Lease holder info for rejection payloads. */
	leaseInfo(key: AttachWorkerKey): { generation: number; expiresInMs: number } | undefined {
		return this.#leaseHolderInfo(attachKeyString(key));
	}

	#leaseHolderInfo(keyString: string): { generation: number; expiresInMs: number } | undefined {
		const lease = this.#leases.get(keyString);
		if (!lease) return undefined;
		const graceTimer = this.#graceTimers.get(keyString);
		const expiresInMs =
			graceTimer !== undefined ? lease.graceMs : Math.max(0, lease.graceMs - (this.#now() - lease.acquiredAt));
		return { generation: lease.generation, expiresInMs };
	}

	#cancelGrace(keyString: string): void {
		const timer = this.#graceTimers.get(keyString);
		if (timer) {
			clearTimeout(timer);
			this.#graceTimers.delete(keyString);
		}
	}

	#releaseLease(keyString: string, reason: string): void {
		this.#cancelGrace(keyString);
		const lease = this.#leases.get(keyString);
		if (!lease) return;
		this.#leases.delete(keyString);
		const key = parseAttachKeyString(keyString);
		this.#emit({ type: "lease_revoked", key, reason });
	}

	// -----------------------------------------------------------------------
	// Command acknowledgements (idempotent reconnect recovery)
	// -----------------------------------------------------------------------

	/**
	 * Return the cached outcome for a command id, or undefined. A reconnecting
	 * client replays its in-flight command with the same id; the server serves
	 * the cached outcome instead of executing it twice.
	 */
	cachedCommand(key: AttachWorkerKey, cmdId: string): AttachPromptOutcome | undefined {
		return this.#cmdCache.get(attachKeyString(key))?.get(cmdId);
	}

	/** Remember a command outcome, bounding the per-worker cache FIFO. */
	rememberCommand(key: AttachWorkerKey, cmdId: string, outcome: AttachPromptOutcome): void {
		const keyString = attachKeyString(key);
		let cache = this.#cmdCache.get(keyString);
		if (!cache) {
			cache = new Map();
			this.#cmdCache.set(keyString, cache);
		}
		cache.set(cmdId, outcome);
		if (cache.size > ATTACH_CMD_ACK_CACHE_SIZE) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
	}

	// -----------------------------------------------------------------------
	// Prompt / follow-up (serialized per key)
	// -----------------------------------------------------------------------

	/**
	 * Claim (or join) the worker's serialized pane-prompt slot for a command.
	 *
	 * The slot is keyed by command identity: a reconnect that replays the SAME
	 * `cmdId` while the original run is still in flight JOINS the shared
	 * outcome (the run executes exactly once) instead of being rejected
	 * `busy`.
	 *
	 * Returns:
	 * - `busy`: a DIFFERENT command, or a director follow-up, holds the slot;
	 * - `joined` + outcome: the same `cmdId` is already active — await the
	 *   shared outcome and deliver the result to this connection too;
	 * - `started` + outcome: this call reserved the slot and launched the run.
	 *
	 * When the run settles, the outcome is cached under `cmdId` BEFORE the
	 * active slot is released, so a replay landing in the settle window reads
	 * the cache and never re-executes.
	 */
	claimPrompt(key: AttachWorkerKey, cmdId: string, text: string, timeoutMs?: number): AttachClaimPromptResult {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) {
			throw new AttachProtocolError("unknown_worker", `no such attach worker: ${attachKeyString(key)}`);
		}
		const active = this.#activeCmd.get(keyString);
		if (active !== undefined) {
			if (active.cmdId === cmdId) return { status: "joined", outcome: active.outcome };
			return { status: "busy" };
		}
		if (entry.pendingFollowUps > 0) {
			// A director follow-up (or a prompt that started before the active
			// map was populated) holds the serialized slot without command
			// identity: treat as busy.
			return { status: "busy" };
		}
		// The claim object IS the slot identity: an unregister + re-register
		// replaces the entry AND the active slot, so settling a stale claim
		// (checked by identity in #settleClaim) must neither delete the new
		// worker's slot nor contaminate its cache.
		const claim = { cmdId } as { cmdId: string; outcome: Promise<AttachPromptOutcome> };
		const outcome = this.runPrompt(key, text, timeoutMs).then(
			result => this.#settleClaim(key, keyString, entry, claim, cmdId, result),
			error => {
				// runPrompt never rejects, but keep the slot consistent anyway.
				const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
				return this.#settleClaim(key, keyString, entry, claim, cmdId, result);
			},
		);
		claim.outcome = outcome;
		this.#activeCmd.set(keyString, claim);
		return { status: "started", outcome };
	}

	/**
	 * Settle a claimed prompt run: cache the outcome and release the active
	 * slot ONLY when the worker still owns this exact claim. If the worker was
	 * unregistered and re-registered while the run was in flight, the entry
	 * and the active slot belong to the NEW worker — the stale claim must not
	 * delete the new slot or cache its outcome into the new worker's cache.
	 */
	#settleClaim(
		key: AttachWorkerKey,
		keyString: string,
		entry: MutableEntry,
		claim: { cmdId: string; outcome: Promise<AttachPromptOutcome> },
		cmdId: string,
		result: AttachPromptOutcome,
	): AttachPromptOutcome {
		if (this.#entries.get(keyString) === entry && this.#activeCmd.get(keyString) === claim) {
			// Cache the outcome BEFORE releasing the slot so a replay in the
			// settle window reads the cache, never a re-run.
			this.rememberCommand(key, cmdId, result);
			this.#activeCmd.delete(keyString);
		}
		return result;
	}

	/**
	 * Run one controller prompt for a worker. Rejects with `unknown_worker`
	 * when the worker is not registered and `busy` when another prompt for the
	 * same key is still in flight. The caller (attach server) is responsible
	 * for lease validation and for delivering prompt_accepted/prompt_result
	 * to the controller connection; this method only manages the serialized
	 * slot and the underlying turn-job run.
	 */
	async runPrompt(key: AttachWorkerKey, text: string, timeoutMs?: number): Promise<AttachPromptOutcome> {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) {
			throw new AttachProtocolError("unknown_worker", `no such attach worker: ${attachKeyString(key)}`);
		}
		if (entry.pendingFollowUps > 0) {
			throw new AttachProtocolError("busy", `prompt already in flight for ${attachKeyString(key)}`);
		}
		const now = this.#now();
		entry.pendingFollowUps = 1;
		entry.lastActivityAt = now;
		entry.updatedAt = now;
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
		let result: AttachPromptOutcome;
		try {
			result = await this.#runPrompt(key, text, { timeoutMs });
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		entry.pendingFollowUps = 0;
		entry.lastActivityAt = this.#now();
		entry.updatedAt = entry.lastActivityAt;
		this.#emit({ type: "updated", key, entry: this.#wireEntry(entry) });
		return result;
	}

	/**
	 * Run one follow-up for a worker (director path). Rejects with
	 * `unknown_worker` when the worker is not registered and `busy` when
	 * another follow-up for the same key is still in flight. Emits
	 * `follow_up_accepted` before running and `follow_up_result` after.
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
		let result: AttachPromptOutcome;
		try {
			result = this.#followUp
				? await this.#followUp(key, payload, { timeoutMs })
				: await this.#runPrompt(key, typeof payload === "string" ? payload : JSON.stringify(payload), {
						timeoutMs,
					});
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
	 * Abort the worker's in-flight turn (best-effort). Returns true when either
	 * the attach prompt slot was occupied or the runtime abort callback found
	 * a turn. Never kills the worker.
	 *
	 * The pending-follow-up counter is NOT touched here: the in-flight
	 * runPrompt()/followUp() owns that slot and clears it only when ITS
	 * callback settles, so an abort that resolves before the turn winds down
	 * can never admit a concurrent prompt. The callback runs even without an
	 * attach-origin prompt because the worker's initial spawn is director-owned
	 * and therefore does not increment pendingFollowUps.
	 */
	async abort(key: AttachWorkerKey, reason?: string): Promise<boolean> {
		const keyString = attachKeyString(key);
		const entry = this.#entries.get(keyString);
		if (!entry) return false;
		const hadPrompt = entry.pendingFollowUps > 0;
		let aborted = false;
		if (this.#abort) {
			try {
				aborted = await this.#abort(key, reason);
			} catch (error) {
				// Log the readable worker id (not the NUL-joined key string) so
				// the failure is actionable in logs; the abort stays best-effort
				// and the frame flow continues.
				logger.warn("attach: runtime abort callback failed", {
					workerId: key.workerId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.#emit({ type: "abort_accepted", key, ref: undefined });
		return hadPrompt || aborted;
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
