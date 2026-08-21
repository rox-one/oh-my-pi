/**
 * Vibe mode worker-session runtime.
 *
 * Owns the persistent, addressable worker sessions ("CLIs") the vibe director
 * drives. Each worker is a real task-executor subagent with full tool access:
 * spawned once through {@link runSubprocess} (keep-alive), continued
 * turn-by-turn through {@link runSubagentFollowUpTurn}. Between turns the
 * worker lives in the AgentRegistry / AgentLifecycleManager as an adopted idle
 * agent (TTL park + JSONL revive), so its conversation context survives across
 * turns and even across parking.
 *
 * Every turn runs as an AsyncJobManager job, so a completed turn self-delivers
 * into the director's conversation exactly like an async `task` result, and
 * `vibe_wait` can block on the first settling turn with `hub`-wait semantics.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { type AttachLiveSessionSource, createAttachLiveSessionSource } from "../attach/live-session";
import type { AttachWorkerKey } from "../attach/protocol";
import type { AttachFollowUpResult } from "../attach/registry";
import { AttachVibeBridge, attachFallbackBaseDir } from "../attach/vibe-bridge";
import { resolveAgentModelSelection } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import vibeTurnResultTemplate from "../prompts/tools/vibe-turn-result.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../registry/agent-registry";
import { SessionManager, SessionPersistenceIndeterminateError } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../task/executor";
import { generateTaskName } from "../task/name-generator";
import { AgentOutputManager } from "../task/output-manager";
import { type AgentDefinition, type AgentProgress, oneLineLabel, type SingleResult } from "../task/types";
import type { ToolSession } from "../tools";
import { formatDuration } from "../tools/render-utils";
import { ToolError } from "../tools/tool-errors";
import { calculateTokensPerSecond } from "../utils/token-rate";

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";

/**
 * CLI flavor → bundled agent type. This IS the model-tier mapping: `sonic`
 * carries `model: "@smol"` (the configured fast/low-latency role) and `task`
 * carries `model: "@task"` (inherits the session's strong model).
 * Resolution goes through {@link resolveAgentModelSelection} exactly like a
 * `task` spawn, so `task.agentModelOverrides` and model-role settings apply.
 */
export const VIBE_CLI_AGENT: Record<VibeCli, string> = {
	fast: "sonic",
	good: "task",
};

/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/** One completed tool call in the per-turn activity trace. */
interface VibeTraceEntry {
	tool: string;
	args: string;
	endMs: number;
}

/** Cap on trace entries retained per turn (the run monitor keeps 5; we widen the window). */
const TURN_TRACE_CAP = 40;
/** Cap on a single rendered trace line. */
const TRACE_LINE_MAX = 120;
/** Default `vibe_wait` window when no timeout was given (ms). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Response text cap inside a delivered turn result; full output stays at agent://<id>. */
const RESPONSE_PREVIEW_MAX = 6000;
/** Grace period for Vibe cancellation/release cleanup before teardown detaches (ms). */
const VIBE_TEARDOWN_GRACE_MS = 5_000;

const VIBE_LIFECYCLE_CUSTOM_TYPE = "vibe-session-lifecycle";
const VIBE_LIFECYCLE_VERSION = 1;

export interface VibeOwnerScope {
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
}

export interface VibeParentSession {
	getAgentId?: () => string | null;
	getSessionId?: () => string | null;
	getSessionFile: () => string | null;
	sessionManager?: ToolSession["sessionManager"] &
		Partial<
			Pick<SessionManager, "appendModeChange" | "appendEntriesAtomically" | "recoverPersistenceFromCurrentState">
		>;
	asyncJobManager?: AsyncJobManager;
	settings: ToolSession["settings"];
	getActiveModelString?: () => string | undefined;
	getModelString?: () => string | undefined;
}

type VibeTombstoneReason = "explicit-kill" | "mode-exit" | "spawn-failed" | "unrecoverable";

interface VibeLifecycleBase {
	version: typeof VIBE_LIFECYCLE_VERSION;
	id: string;
	ownerId: string;
	parentSessionId: string;
}

interface VibeSpawnLifecycleEvent extends VibeLifecycleBase {
	action: "spawn";
	cli: VibeCli;
	agent: string;
	childSessionFile: string;
	createdAt: number;
	/**
	 * Attach endpoint paths (socket + token file — paths only, never token
	 * contents) so pane launchers do not derive them from the parent session
	 * file. Present when the attach server started for this worker.
	 */
	attachSocket?: string;
	attachTokenFile?: string;
}

interface VibeTurnLifecycleEvent extends VibeLifecycleBase {
	action: "turn-started" | "turn-settled";
	turn: number;
}

interface VibeTombstoneLifecycleEvent extends VibeLifecycleBase {
	action: "tombstone";
	reason: VibeTombstoneReason;
}

interface VibeTombstoneRevocationEvent extends VibeLifecycleBase {
	action: "tombstone-revoked";
	reason: "mode-exit";
}

type VibeLifecycleEvent =
	| VibeSpawnLifecycleEvent
	| VibeTurnLifecycleEvent
	| VibeTombstoneLifecycleEvent
	| VibeTombstoneRevocationEvent;

interface VibeRestoreCandidate {
	spawn: VibeSpawnLifecycleEvent;
	turnCount: number;
	lastActivityAt: number;
	inFlight: boolean;
	tombstoneReason?: VibeTombstoneReason;
}

interface ResolvedVibeWorker {
	agent: AgentDefinition;
	modelOverride?: string | string[];
	/** Pre-expansion role alias behind {@link modelOverride}, when the worker agent named one. */
	modelRole?: string;
}

interface VibeTurn {
	jobId: string;
	message: string;
	startedAt: number;
	/** Trace of tool calls completed during this turn, oldest first. */
	trace: VibeTraceEntry[];
	/** Total completed tool calls (trace may be narrower than this). */
	toolCount: number;
}

interface VibeRecord {
	id: string;
	cli: VibeCli;
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	childSessionFile?: string;
	agent: AgentDefinition;
	modelOverride?: string | string[];
	/** Pre-expansion role alias behind {@link modelOverride}, when the worker agent named one. */
	modelRole?: string;
	state: VibeSessionState;
	createdAt: number;
	lastActivityAt: number;
	/** One-line gist of the latest activity (intent, tool, or result preview). */
	lastActivity?: string;
	/** Resolved model display string once known. */
	resolvedModel?: string;
	turn?: VibeTurn;
	/** Live view of the in-flight turn (current tool, intent, streamed text tail). */
	live?: {
		currentTool?: string;
		currentToolArgs?: string;
		lastIntent?: string;
		/** Latest streamed assistant text lines, oldest first. */
		outputTail: string[];
	};
	/** Job id of the most recently settled turn (wait snapshots after settle). */
	lastJobId?: string;
	/** Messages queued while a turn was in flight; drained into the next turn. */
	queue: string[];
	turnCount: number;
	killed: boolean;
	/** True while a parent switch is detaching this process-local record without terminating it. */
	suspended: boolean;
	/** True only after a terminal lifecycle event has durably flushed. */
	terminalPersisted: boolean;
	/**
	 * Set by the attach pane's Ctrl-C abort (#abortAttachTurn) while the
	 * in-flight turn is being cancelled. The settle that follows is a USER
	 * INTERRUPT, not a kill: the worker session must survive registered/idle
	 * and accept the next follow-up. Consumed (and cleared) by #finishTurn.
	 */
	paneAbortPending?: boolean;
}

/**
 * Whether a vibe worker survives its turn settling.
 *
 * Kill, suspension, and a concurrent hard-kill that already tombstoned the
 * agent ref (`aborted`) stay terminal. A pane Ctrl-C abort
 * (`paneAbortPending`) is a user interrupt with a revivable worker: the
 * record must remain registered/idle even when the abort unwinding has not
 * yet synced the agent ref to `idle` (attach contract — the pane and the
 * worker both stay alive). A MISSING ref is also survivable: that is the
 * pre-monitor/spawn window, where the worker's session never completed —
 * the record stays idle WITHOUT a phantom session claim, and the next prompt
 * re-spawns a fresh session. Exported for the focused runtime regression
 * (test/vibe/runtime-abort-revive.test.ts).
 */
export function vibeWorkerSurvivesTurnSettle(args: {
	killed: boolean;
	suspended: boolean;
	paneAbortPending: boolean;
	registeredStatus: AgentStatus | undefined;
}): boolean {
	if (args.killed || args.suspended) return false;
	if (args.paneAbortPending) {
		// Missing ref (spawn window) and live refs survive; a terminal
		// `aborted` ref means a concurrent hard kill already won.
		return args.registeredStatus !== "aborted";
	}
	return args.registeredStatus === "idle" || args.registeredStatus === "parked";
}

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}

type VibeTeardownStatus = "pending" | "settled" | "failed";

interface TrackedVibeTeardown {
	promise: Promise<void>;
	status: () => VibeTeardownStatus;
}

/** Observe cleanup without propagating a detached late rejection. */
function trackVibeTeardown(promise: Promise<unknown>, onError: (error: unknown) => void): TrackedVibeTeardown {
	let status: VibeTeardownStatus = "pending";
	return {
		promise: promise.then(
			() => {
				status = "settled";
			},
			error => {
				status = "failed";
				onError(error);
			},
		),
		status: () => status,
	};
}

/** Wait for cleanup only until the caller's shared absolute deadline. */
async function waitForVibeTeardown(tasks: readonly TrackedVibeTeardown[], deadline: number): Promise<boolean> {
	if (tasks.length === 0 || tasks.every(task => task.status() !== "pending")) return true;
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return false;
	const timeout = Promise.withResolvers<void>();
	const timer = setTimeout(timeout.resolve, remainingMs);
	timer.unref?.();
	try {
		return await Promise.race([
			Promise.allSettled(tasks.map(task => task.promise)).then(() => true),
			timeout.promise.then(() => false),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Normalize a text fragment to one bounded roster/trace line. */
function firstLine(text: string, max = 100): string {
	return oneLineLabel(text, max);
}

function scopeKey(scope: VibeOwnerScope, id: string): string {
	return `${scope.parentSessionId}\0${scope.parentSessionFile ?? ""}\0${scope.ownerId}\0${id}`;
}

function matchesScope(record: VibeRecord, scope: VibeOwnerScope): boolean {
	return (
		record.ownerId === scope.ownerId &&
		record.parentSessionId === scope.parentSessionId &&
		record.parentSessionFile === scope.parentSessionFile
	);
}

/** Attach registry key for a vibe record within its owner scope. */
function attachKeyOfRecord(record: VibeRecord): AttachWorkerKey {
	return { workerId: record.id, ownerScope: record.parentSessionId };
}

/** Reconstruct the owner scope of a record (used for attach bridge keying). */
function scopeFromRecord(record: VibeRecord): VibeOwnerScope {
	return {
		ownerId: record.ownerId,
		parentSessionId: record.parentSessionId,
		parentSessionFile: record.parentSessionFile,
	};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function parseLifecycleEvent(value: unknown): VibeLifecycleEvent | undefined {
	const data = objectRecord(value);
	if (!data || data.version !== VIBE_LIFECYCLE_VERSION) return undefined;
	if (typeof data.id !== "string" || !data.id) return undefined;
	if (typeof data.ownerId !== "string" || !data.ownerId) return undefined;
	if (typeof data.parentSessionId !== "string" || !data.parentSessionId) return undefined;
	const base: VibeLifecycleBase = {
		version: VIBE_LIFECYCLE_VERSION,
		id: data.id,
		ownerId: data.ownerId,
		parentSessionId: data.parentSessionId,
	};
	if (data.action === "spawn") {
		const cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
		if (!cli || typeof data.agent !== "string" || typeof data.childSessionFile !== "string") return undefined;
		if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return undefined;
		return {
			...base,
			action: "spawn",
			cli,
			agent: data.agent,
			childSessionFile: data.childSessionFile,
			createdAt: data.createdAt,
		};
	}
	if (data.action === "turn-started" || data.action === "turn-settled") {
		if (typeof data.turn !== "number" || !Number.isInteger(data.turn) || data.turn < 1) return undefined;
		return { ...base, action: data.action, turn: data.turn };
	}
	if (data.action === "tombstone") {
		const reason = data.reason;
		if (
			reason !== "explicit-kill" &&
			reason !== "mode-exit" &&
			reason !== "spawn-failed" &&
			reason !== "unrecoverable"
		) {
			return undefined;
		}
		return { ...base, action: "tombstone", reason };
	}
	if (data.action === "tombstone-revoked" && data.reason === "mode-exit") {
		return { ...base, action: "tombstone-revoked", reason: "mode-exit" };
	}
	return undefined;
}

/** Child ids claimed by valid Vibe spawn records from untrusted persisted JSON. */
export function persistedVibeChildIds(entries: Iterable<unknown>): Set<string> {
	const ids = new Set<string>();
	for (const value of entries) {
		const entry = objectRecord(value);
		if (entry?.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
		const event = parseLifecycleEvent(entry.data);
		if (
			event?.action === "spawn" &&
			/^[A-Za-z0-9_-]+$/.test(event.id) &&
			event.childSessionFile === `${event.id}.jsonl`
		) {
			ids.add(event.id);
		}
	}
	return ids;
}

/** Merge the monitor's rolling `recentTools` window (newest first) into the per-turn trace (oldest first). */
function mergeTrace(turn: VibeTurn, progress: AgentProgress): void {
	turn.toolCount = progress.toolCount;
	for (let i = progress.recentTools.length - 1; i >= 0; i--) {
		const entry = progress.recentTools[i];
		if (turn.trace.some(seen => seen.endMs === entry.endMs && seen.tool === entry.tool && seen.args === entry.args)) {
			continue;
		}
		turn.trace.push({ tool: entry.tool, args: entry.args, endMs: entry.endMs });
		if (turn.trace.length > TURN_TRACE_CAP) turn.trace.shift();
	}
}

/** Thrown from a turn job body so the job manager marks the job failed while carrying the formatted result. */
export class VibeTurnError extends Error {}

/**
 * Process-global registry of vibe worker sessions, scoped by both owner agent
 * id and stable parent session id. Persisted lifecycle events rebuild idle
 * records after a process restart; live turn jobs remain process-local.
 */
export class VibeSessionRegistry {
	static #global: VibeSessionRegistry | undefined;

	static global(): VibeSessionRegistry {
		if (!VibeSessionRegistry.#global) {
			VibeSessionRegistry.#global = new VibeSessionRegistry();
		}
		return VibeSessionRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		VibeSessionRegistry.#global = undefined;
	}

	/**
	 * Insert a bare worker record without the spawn machinery. Test-only —
	 * lets focused runtime tests attach an optional synthetic in-flight job.
	 */
	registerRecordForTests(record: {
		id: string;
		cli?: VibeCli;
		ownerId: string;
		state?: VibeSessionState;
		jobId?: string;
		queue?: string[];
	}): void {
		const now = Date.now();
		// Key by the same scopeKey the runtime lookups use (send/#record), so a
		// record registered here is reachable through a matching fake parent
		// session (getSessionId "test-parent-session", sessionFile null).
		const scope: VibeOwnerScope = {
			ownerId: record.ownerId,
			parentSessionId: "test-parent-session",
			parentSessionFile: null,
		};
		this.#records.set(scopeKey(scope, record.id), {
			id: record.id,
			cli: record.cli ?? "fast",
			ownerId: record.ownerId,
			parentSessionId: "test-parent-session",
			parentSessionFile: null,
			agent: getBundledAgent("sonic")!,
			state: record.state ?? "running",
			createdAt: now,
			lastActivityAt: now,
			turn: record.jobId
				? { jobId: record.jobId, message: "test turn", startedAt: now, trace: [], toolCount: 0 }
				: undefined,
			queue: [...(record.queue ?? [])],
			turnCount: 0,
			killed: false,
			suspended: false,
			terminalPersisted: false,
		});
	}

	/** Mark and cancel an in-flight turn exactly like pane Ctrl-C. Test-only. */
	abortAttachTurnForTests(session: ToolSession, id: string): boolean {
		const record = this.#record(this.ownerScope(session), id);
		if (!record.turn) return false;
		record.paneAbortPending = true;
		return this.#manager(session).cancel(record.turn.jobId, { ownerId: record.ownerId });
	}

	readonly #records = new Map<string, VibeRecord>();
	readonly #terminationTails = new Map<string, Promise<void>>();
	readonly #terminatedScopes = new Set<string>();
	#teardownGraceMs = VIBE_TEARDOWN_GRACE_MS;
	/** Per-scope attach substrate (registry + 0600 socket server), keyed by scopeKey(scope, ""). */
	readonly #attachBridges = new Map<string, { bridge: AttachVibeBridge; session: ToolSession | null }>();

	/** Override the teardown grace period for deterministic lifecycle tests. */
	setTeardownGraceForTesting(timeoutMs: number): void {
		this.#teardownGraceMs = Math.max(1, timeoutMs);
	}

	ownerScope(session: VibeParentSession): VibeOwnerScope {
		const parentSessionId = session.getSessionId?.();
		if (!parentSessionId) {
			throw new ToolError("Vibe sessions require a stable parent session id.");
		}
		const parentSessionFile = session.getSessionFile();
		return {
			ownerId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentSessionId,
			parentSessionFile: parentSessionFile ? path.resolve(parentSessionFile) : null,
		};
	}

	/** Re-open spawn admission after an explicit Vibe-mode entry. */
	activateScope(scope: VibeOwnerScope): void {
		this.#terminatedScopes.delete(scopeKey(scope, ""));
	}

	/**
	 * Look up or lazily create the attach bridge (registry + socket server) for
	 * one scope. A fresh bridge backfills every already-live record in the
	 * scope (revived workers included) so the attach view is complete before
	 * the first spawn.
	 */
	#attachBridge(
		scope: VibeOwnerScope,
		session: ToolSession,
	): { bridge: AttachVibeBridge; session: ToolSession | null } {
		const key = scopeKey(scope, "");
		const existing = this.#attachBridges.get(key);
		if (existing) {
			existing.session = session;
			return existing;
		}
		const baseDir = scope.parentSessionFile
			? path.resolve(scope.parentSessionFile.slice(0, -6))
			: attachFallbackBaseDir(scope.parentSessionId);
		const bridge = new AttachVibeBridge({
			ownerScope: scope.parentSessionId,
			baseDir,
			runTurn: (workerKey, prompt, options) => this.#runAttachTurn(scope, workerKey, prompt, options?.timeoutMs),
			abortTurn: (workerKey, reason) => this.#abortAttachTurn(scope, workerKey, reason),
			liveSessionOf: workerKey => this.#attachLiveSessionOf(scope, workerKey),
			isParked: workerKey => this.#attachIsParked(scope, workerKey),
		});
		for (const record of this.#records.values()) {
			if (!matchesScope(record, scope) || record.state === "dead") continue;
			bridge.register(attachKeyOfRecord(record), record.lastActivity ?? null, true);
		}
		const entry = { bridge, session };
		this.#attachBridges.set(key, entry);
		return entry;
	}

	/** The attach bridge for a record's scope, when one exists. */
	#attachForRecord(record: VibeRecord): AttachVibeBridge | undefined {
		return this.#attachBridges.get(scopeKey(scopeFromRecord(record), ""))?.bridge;
	}

	/** Run one pane-origin follow-up through the same turn-job queue as vibe_send, awaiting the job. */
	async #runAttachTurn(
		scope: VibeOwnerScope,
		workerKey: AttachWorkerKey,
		prompt: string,
		timeoutMs?: number,
	): Promise<AttachFollowUpResult> {
		const entry = this.#attachBridges.get(scopeKey(scope, ""));
		const session = entry?.session;
		if (!session) return { ok: false, error: "no director session available for the attach scope" };
		let outcome: VibeSendOutcome;
		try {
			outcome = await this.send(session, { session: workerKey.workerId, message: prompt });
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (outcome.mode !== "turn" || !outcome.jobId) {
			return { ok: true, payload: { mode: outcome.mode } };
		}
		const manager = this.#manager(session);
		const job = manager.getJob(outcome.jobId);
		if (!job) return { ok: true, payload: { mode: outcome.mode, jobId: outcome.jobId } };
		let jobError: string | undefined;
		let timedOut = false;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				timedOut = true;
				timeoutResolve();
			}, timeoutMs);
			try {
				await Promise.race([
					job.promise.then(
						() => undefined,
						error => {
							jobError = error instanceof Error ? error.message : String(error);
						},
					),
					timeoutPromise,
				]);
			} finally {
				clearTimeout(timer);
			}
		} else {
			try {
				await job.promise;
			} catch (error) {
				jobError = error instanceof Error ? error.message : String(error);
			}
		}
		if (timedOut) return { ok: false, error: `follow-up timed out after ${timeoutMs}ms` };
		if (jobError) return { ok: false, error: jobError };
		return { ok: true, payload: { mode: outcome.mode, jobId: outcome.jobId } };
	}

	/** Cancel the worker's in-flight turn job only; the adopted worker survives. */
	async #abortAttachTurn(scope: VibeOwnerScope, workerKey: AttachWorkerKey, reason?: string): Promise<boolean> {
		const entry = this.#attachBridges.get(scopeKey(scope, ""));
		const record = this.#records.get(scopeKey(scope, workerKey.workerId));
		if (!entry || !record?.turn) return false;
		const session = entry.session;
		if (!session) return false;
		// Attach-scoped resumability: this abort is a pane Ctrl-C (user
		// interrupt), not a kill. Set BEFORE the job signal fires so the
		// turn's executor monitor observes it synchronously; #finishTurn also
		// reads and clears the marker at settle. For FIRST spawns the marker
		// is threaded into the executor options (see #buildSpawnOptions) so
		// the lifecycle finalizer keeps the adopted session resumable; the
		// follow-up path has no executor flag — its survival is decided here
		// in #finishTurn at settle.
		record.paneAbortPending = true;
		const cancelled = this.#manager(session).cancel(record.turn.jobId, { ownerId: record.ownerId });
		const activeSession = this.#registeredAgent(record)?.session;
		if (activeSession) {
			// Defense-in-depth: manager.cancel() only fires the job's abort
			// signal. The follow-up monitor registers its listener after two
			// awaits (lifecycle append + session revive), so a Ctrl-C landing
			// in that window is never observed and the session would run the
			// whole turn untouched. Abort the adopted session directly so the
			// in-flight turn always stops. A failed session abort must not
			// swallow the outcome silently: log it and still record the
			// interrupt below (the job signal already fired, so the turn
			// winds down through the normal settle path).
			try {
				await activeSession.abort();
			} catch (error) {
				logger.warn("vibe: pane abort failed to stop the adopted session", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (cancelled || activeSession) {
			record.lastActivity = firstLine(`aborted: ${reason ?? "follow-up cancelled"}`);
			record.lastActivityAt = Date.now();
		}
		return cancelled || activeSession !== undefined;
	}

	#attachLiveSessionOf(scope: VibeOwnerScope, workerKey: AttachWorkerKey): AttachLiveSessionSource | null {
		const record = this.#records.get(scopeKey(scope, workerKey.workerId));
		const session = record ? this.#registeredAgent(record)?.session : undefined;
		if (!session) return null;
		const childSessionFile = record?.childSessionFile ?? null;
		return createAttachLiveSessionSource(session, childSessionFile);
	}

	#attachIsParked(scope: VibeOwnerScope, workerKey: AttachWorkerKey): boolean {
		const record = this.#records.get(scopeKey(scope, workerKey.workerId));
		return record ? this.#registeredAgent(record)?.status === "parked" : false;
	}

	async #withTerminationLock<T>(scope: VibeOwnerScope, operation: () => Promise<T>): Promise<T> {
		const key = scopeKey(scope, "");
		const predecessor = this.#terminationTails.get(key) ?? Promise.resolve();
		const released = Promise.withResolvers<void>();
		const tail = predecessor.then(() => released.promise);
		this.#terminationTails.set(key, tail);
		await predecessor;
		try {
			return await operation();
		} finally {
			released.resolve();
			if (this.#terminationTails.get(key) === tail) this.#terminationTails.delete(key);
		}
	}

	#resolveWorker(session: VibeParentSession, cli: VibeCli): ResolvedVibeWorker {
		const agentName = VIBE_CLI_AGENT[cli];
		const agent = getBundledAgent(agentName);
		if (!agent) {
			throw new ToolError(`Bundled agent "${agentName}" for vibe cli "${cli}" is unavailable.`);
		}
		const agentModelOverrides = session.settings.get("task.agentModelOverrides");
		// Same contract as the task spawn path: the expansion discards the role
		// alias (`@task`, `@smol`), so patterns and role identity come from one
		// call — the child's inherited retry-fallback chain is keyed off the role.
		const { patterns, role } = resolveAgentModelSelection({
			settingsOverride: agentModelOverrides[agentName],
			agentModel: agent.model,
			settings: session.settings,
			activeModelPattern: session.getActiveModelString?.(),
			fallbackModelPattern: session.getModelString?.(),
		});
		return { agent, modelOverride: patterns, modelRole: role };
	}

	async #appendLifecycleEvent(
		session: VibeParentSession,
		event: VibeLifecycleEvent,
		expectedParentSessionFile: string | null,
	): Promise<boolean> {
		if (!expectedParentSessionFile || !session.sessionManager) return false;
		const matchesCurrentScope = (): boolean => {
			const currentSessionFile = session.getSessionFile();
			return (
				session.getSessionId?.() === event.parentSessionId &&
				(session.getAgentId?.() ?? MAIN_AGENT_ID) === event.ownerId &&
				currentSessionFile !== null &&
				path.resolve(currentSessionFile) === expectedParentSessionFile
			);
		};
		if (!matchesCurrentScope()) return false;
		await session.sessionManager.ensureOnDisk();
		if (!matchesCurrentScope()) return false;
		session.sessionManager.appendCustomEntry(VIBE_LIFECYCLE_CUSTOM_TYPE, event);
		await session.sessionManager.flush();
		return true;
	}

	#eventBase(record: VibeRecord): VibeLifecycleBase {
		return {
			version: VIBE_LIFECYCLE_VERSION,
			id: record.id,
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId,
		};
	}

	async #appendTombstone(
		session: VibeParentSession,
		record: VibeRecord,
		reason: VibeTombstoneReason,
	): Promise<boolean> {
		return this.#appendLifecycleEvent(
			session,
			{
				...this.#eventBase(record),
				action: "tombstone",
				reason,
			},
			record.parentSessionFile,
		);
	}

	#hasInMemoryTombstone(session: VibeParentSession, record: VibeRecord): boolean {
		let terminalReason: VibeTombstoneReason | undefined;
		for (const entry of session.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (
				!event ||
				event.id !== record.id ||
				event.ownerId !== record.ownerId ||
				event.parentSessionId !== record.parentSessionId
			) {
				continue;
			}
			if (event.action === "tombstone") terminalReason = event.reason;
			else if (event.action === "tombstone-revoked" && terminalReason === "mode-exit") terminalReason = undefined;
		}
		return terminalReason !== undefined;
	}

	async #persistModeExit(
		session: VibeParentSession,
		scope: VibeOwnerScope,
		records: readonly VibeRecord[],
	): Promise<void> {
		const pending = records.filter(record => !record.terminalPersisted);
		const sessionManager = session.sessionManager;
		if (!sessionManager) {
			if (pending.some(record => record.childSessionFile)) {
				throw new ToolError("Vibe mode exit cannot persist worker tombstones without the parent session manager.");
			}
			for (const record of pending) record.terminalPersisted = true;
			return;
		}
		const currentScope = this.ownerScope(session);
		if (
			currentScope.ownerId !== scope.ownerId ||
			currentScope.parentSessionId !== scope.parentSessionId ||
			currentScope.parentSessionFile !== scope.parentSessionFile
		) {
			throw new ToolError("Vibe parent session changed before mode exit could be persisted.");
		}
		const parentSessionFile = currentScope.parentSessionFile;
		const persistedPending = pending.filter(record => record.childSessionFile !== undefined);
		for (const record of persistedPending) {
			if (
				!parentSessionFile ||
				path.resolve(parentSessionFile.slice(0, -6), `${record.id}.jsonl`) !== record.childSessionFile
			) {
				throw new ToolError(`Vibe session "${record.id}" changed parent scope before termination.`);
			}
		}
		const appendEntriesAtomically = sessionManager.appendEntriesAtomically;
		if (!appendEntriesAtomically) {
			throw new ToolError("Vibe mode exit requires atomic parent-session persistence.");
		}
		await appendEntriesAtomically.call(sessionManager, () => {
			for (const record of persistedPending) {
				sessionManager.appendCustomEntry(VIBE_LIFECYCLE_CUSTOM_TYPE, {
					...this.#eventBase(record),
					action: "tombstone",
					reason: "mode-exit",
				});
			}
			sessionManager.appendModeChange?.("none");
		});
		for (const record of pending) record.terminalPersisted = true;
	}

	#manager(session: ToolSession): AsyncJobManager {
		const manager = session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Vibe sessions require async execution (no background job manager is available).");
		}
		return manager;
	}

	#record(scope: VibeOwnerScope, id: string): VibeRecord {
		const record = this.#records.get(scopeKey(scope, id.trim()));
		if (!record || !matchesScope(record, scope)) {
			const roster = this.#listIds(scope);
			throw new ToolError(
				`Unknown vibe session "${id}".${roster.length > 0 ? ` Active sessions: ${roster.join(", ")}` : " No sessions — spawn one with vibe_spawn."}`,
			);
		}
		return record;
	}

	#registeredAgent(record: VibeRecord): AgentRef | undefined {
		const ref = AgentRegistry.global().get(record.id);
		if (ref?.kind !== "sub" || ref.parentId !== record.ownerId) return undefined;
		if (record.childSessionFile && ref.sessionFile !== record.childSessionFile) return undefined;
		return ref;
	}

	#listIds(scope: VibeOwnerScope): string[] {
		const ids: string[] = [];
		for (const record of this.#records.values()) {
			if (matchesScope(record, scope) && record.state !== "dead") ids.push(record.id);
		}
		return ids;
	}

	listIds(session: ToolSession): string[] {
		return this.#listIds(this.ownerScope(session));
	}

	/** Ids of every live worker owned by `ownerId`, across all parent scopes (status-line tok/s aggregation). */
	listIdsByOwner(ownerId: string): string[] {
		const ids: string[] = [];
		for (const record of this.#records.values()) {
			if (record.ownerId === ownerId && record.state !== "dead") ids.push(record.id);
		}
		return ids;
	}

	/**
	 * Live screen snapshots for rich rendering (the "TV wall"): one entry per
	 * session in creation order, carrying the in-flight turn's trace, current
	 * tool, and streamed text tail. All strings are one-line sanitized here so
	 * renderers can print them verbatim.
	 */
	screens(session: ToolSession, ids?: string[]): VibeScreenSnapshot[] {
		const scope = this.ownerScope(session);
		const wanted = ids?.length ? new Set(ids.map(id => id.trim())) : undefined;
		const records: VibeRecord[] = [];
		for (const record of this.#records.values()) {
			if (!matchesScope(record, scope)) continue;
			if (wanted && !wanted.has(record.id)) continue;
			records.push(record);
		}
		// Stable TV-wall ordering: spawn order, not activity order.
		records.sort((a, b) => a.createdAt - b.createdAt);
		return records.map(record => ({
			id: record.id,
			cli: record.cli,
			state: record.state,
			model: record.resolvedModel,
			turns: record.turnCount,
			queued: record.queue.length,
			turnStartedAt: record.turn?.startedAt,
			turnMessage: record.turn ? firstLine(record.turn.message, 80) : undefined,
			currentTool: record.live?.currentTool,
			currentToolArgs: record.live?.currentToolArgs ? firstLine(record.live.currentToolArgs, 60) : undefined,
			lastIntent: record.live?.lastIntent ? firstLine(record.live.lastIntent, 80) : undefined,
			trace: record.turn
				? record.turn.trace
						.slice(-6)
						.map(entry => firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX))
				: [],
			outputTail: (record.live?.outputTail ?? []).map(line => firstLine(line, 100)),
			lastActivity: record.lastActivity,
			lastActivityAt: record.lastActivityAt,
		}));
	}

	#persistedIds(session: VibeParentSession, scope: VibeOwnerScope): Set<string> {
		const ids = new Set<string>();
		for (const entry of session.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (event?.ownerId === scope.ownerId && event.parentSessionId === scope.parentSessionId) ids.add(event.id);
		}
		for (const record of this.#records.values()) {
			if (matchesScope(record, scope)) ids.add(record.id);
		}
		return ids;
	}

	async #resolvePersistedChild(
		parentSessionFile: string,
		spawn: VibeSpawnLifecycleEvent,
		options?: { requireAgentMatch?: boolean },
	): Promise<string | undefined> {
		if (options?.requireAgentMatch !== false && spawn.agent !== VIBE_CLI_AGENT[spawn.cli]) return undefined;
		if (!/^[A-Za-z0-9_-]+$/.test(spawn.id) || spawn.childSessionFile !== `${spawn.id}.jsonl`) return undefined;
		const artifactsDir = path.resolve(parentSessionFile.slice(0, -6));
		const childSessionFile = path.resolve(artifactsDir, spawn.childSessionFile);
		const relative = path.relative(artifactsDir, childSessionFile);
		if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") {
			return undefined;
		}
		try {
			const persisted = await SessionManager.peekSessionInit(childSessionFile);
			return persisted?.init ? childSessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	#trackAgentRelease(id: string, ref: AgentRef, action: "detach" | "release"): TrackedVibeTeardown {
		return trackVibeTeardown(AgentLifecycleManager.global().release(id, ref), error => {
			logger.warn(`vibe: failed to ${action} worker session`, {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#finishAgentRelease(id: string, ref: AgentRef, task: TrackedVibeTeardown, action: "detach" | "release"): void {
		if (task.status() === "settled") return;
		if (task.status() === "pending") {
			logger.warn(`vibe: timed out waiting to ${action} worker session; detaching registry ref`, { id });
		}
		AgentRegistry.global().unregister(id, ref);
	}

	async #releaseRefWithinDeadline(
		id: string,
		ref: AgentRef,
		deadline: number,
		action: "detach" | "release",
	): Promise<void> {
		const task = this.#trackAgentRelease(id, ref, action);
		await waitForVibeTeardown([task], deadline);
		this.#finishAgentRelease(id, ref, task, action);
	}

	#trackJobSettlement(record: VibeRecord, job: AsyncJob): TrackedVibeTeardown {
		return trackVibeTeardown(job.promise, error => {
			logger.warn("vibe: cancelled worker turn cleanup failed", {
				id: record.id,
				jobId: job.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	async #markTerminalRef(
		id: string,
		ownerId: string,
		childSessionFile: string,
		expected?: AgentRef | null,
		teardownDeadline?: number,
	): Promise<void> {
		const registry = AgentRegistry.global();
		const existing = registry.get(id);
		if (expected !== undefined && existing !== undefined && existing !== expected) return;
		if (
			existing &&
			(existing.kind !== "sub" || existing.parentId !== ownerId || existing.sessionFile !== childSessionFile)
		) {
			return;
		}
		if (existing?.status === "aborted" && !existing.session) return;
		if (existing && !registry.setStatus(id, "aborted", existing)) return;
		if (existing && teardownDeadline !== undefined) {
			await this.#releaseRefWithinDeadline(id, existing, teardownDeadline, "release");
		} else if (existing && AgentLifecycleManager.global().has(id, existing)) {
			await AgentLifecycleManager.global().release(id, existing);
		} else if (existing?.session) {
			await existing.session.dispose();
		}
		const current = registry.get(id);
		if (current && current !== existing) return;
		if (current) registry.unregister(id, current);
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: ownerId,
			session: null,
			sessionFile: childSessionFile,
			status: "aborted",
		});
	}

	/** Reconcile resumable and terminal workers from the persisted parent journal. */
	async rehydrate(session: VibeParentSession): Promise<number> {
		const sessionFile = session.getSessionFile();
		const sessionManager = session.sessionManager;
		if (!sessionFile || !sessionManager) return 0;
		const scope = this.ownerScope(session);
		const allSpawns = new Map<string, VibeSpawnLifecycleEvent>();
		const terminalIntents = new Map<string, VibeTombstoneReason>();
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (!event || event.ownerId !== scope.ownerId || event.parentSessionId !== scope.parentSessionId) continue;
			if (event.action === "spawn") allSpawns.set(event.id, event);
			else if (event.action === "tombstone") terminalIntents.set(event.id, event.reason);
			else if (event.action === "tombstone-revoked" && terminalIntents.get(event.id) === "mode-exit") {
				terminalIntents.delete(event.id);
			}
		}

		const candidates = new Map<string, VibeRestoreCandidate>();
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (!event || event.ownerId !== scope.ownerId || event.parentSessionId !== scope.parentSessionId) continue;
			const eventTime = Date.parse(entry.timestamp);
			if (event.action === "spawn") {
				candidates.set(event.id, {
					spawn: event,
					turnCount: 0,
					lastActivityAt: Number.isFinite(eventTime) ? eventTime : event.createdAt,
					inFlight: false,
				});
				continue;
			}
			const candidate = candidates.get(event.id);
			if (!candidate) continue;
			candidate.lastActivityAt = Number.isFinite(eventTime) ? eventTime : candidate.lastActivityAt;
			if (event.action === "turn-started" && event.turn >= candidate.turnCount) {
				candidate.turnCount = event.turn;
				candidate.inFlight = true;
			} else if (event.action === "turn-settled" && event.turn >= candidate.turnCount) {
				candidate.turnCount = event.turn;
				candidate.inFlight = false;
			} else if (event.action === "tombstone") {
				candidate.tombstoneReason = event.reason;
			} else if (event.action === "tombstone-revoked" && candidate.tombstoneReason === "mode-exit") {
				candidate.tombstoneReason = undefined;
			}
		}

		for (const id of terminalIntents.keys()) {
			const spawn = allSpawns.get(id);
			if (!spawn) continue;
			const childSessionFile = await this.#resolvePersistedChild(sessionFile, spawn, { requireAgentMatch: false });
			if (!childSessionFile) continue;
			await this.#markTerminalRef(id, scope.ownerId, childSessionFile);
			this.#records.delete(scopeKey(scope, id));
		}

		let restored = 0;
		for (const candidate of candidates.values()) {
			const { spawn } = candidate;
			if (candidate.tombstoneReason || terminalIntents.has(spawn.id) || candidate.turnCount < 1) continue;
			const childSessionFile = await this.#resolvePersistedChild(sessionFile, spawn);
			if (!childSessionFile) continue;
			const key = scopeKey(scope, spawn.id);
			if (this.#records.has(key)) continue;
			const existing = AgentRegistry.global().get(spawn.id);
			const existingIsResumable =
				existing?.kind === "sub" &&
				existing.parentId === scope.ownerId &&
				existing.sessionFile === childSessionFile &&
				(existing.status === "idle" || existing.status === "parked");
			const blockedByCollision = Boolean(existing && !existingIsResumable);
			const { agent, modelOverride, modelRole } = this.#resolveWorker(session, spawn.cli);
			if (!existing) {
				AgentRegistry.global().register({
					id: spawn.id,
					displayName: spawn.id,
					kind: "sub",
					parentId: scope.ownerId,
					session: null,
					sessionFile: childSessionFile,
					status: "parked",
				});
			}
			this.#records.set(key, {
				id: spawn.id,
				cli: spawn.cli,
				ownerId: scope.ownerId,
				parentSessionId: scope.parentSessionId,
				parentSessionFile: scope.parentSessionFile,
				childSessionFile,
				agent,
				modelOverride,
				modelRole,
				state: "idle",
				createdAt: spawn.createdAt,
				lastActivityAt: candidate.lastActivityAt,
				lastActivity: blockedByCollision
					? "blocked by an agent id collision"
					: candidate.inFlight
						? `turn ${candidate.turnCount} interrupted by process restart`
						: undefined,
				queue: [],
				turnCount: candidate.turnCount,
				killed: false,
				suspended: false,
				terminalPersisted: false,
			});
			restored++;
		}
		return restored;
	}

	/** Spawn a persistent worker session and start its first turn in the background. */
	async spawn(session: ToolSession, args: { cli: VibeCli; name?: string; prompt: string }): Promise<VibeSpawnOutcome> {
		const scope = this.ownerScope(session);
		return this.#withTerminationLock(scope, () => this.#spawnLocked(session, scope, args));
	}

	async #spawnLocked(
		session: ToolSession,
		scope: VibeOwnerScope,
		args: { cli: VibeCli; name?: string; prompt: string },
	): Promise<VibeSpawnOutcome> {
		if (this.#terminatedScopes.has(scopeKey(scope, ""))) {
			throw new ToolError("Vibe mode has exited; enter Vibe mode again before spawning a worker.");
		}
		const manager = this.#manager(session);
		const { agent, modelOverride, modelRole } = this.#resolveWorker(session, args.cli);
		if (!session.agentOutputManager) {
			session.agentOutputManager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
		}
		const reservedIds = this.#persistedIds(session, scope);
		for (const ref of AgentRegistry.global().list()) reservedIds.add(ref.id);
		await session.agentOutputManager.reserve(reservedIds);
		const requestedName = args.name?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
		const id = await session.agentOutputManager.allocate(requestedName || generateTaskName());
		const parentSessionFile = scope.parentSessionFile;
		const childSessionName = `${id}.jsonl`;
		const childSessionFile = parentSessionFile
			? path.resolve(parentSessionFile.slice(0, -6), childSessionName)
			: undefined;
		const createdAt = Date.now();
		const record: VibeRecord = {
			id,
			cli: args.cli,
			ownerId: scope.ownerId,
			parentSessionId: scope.parentSessionId,
			parentSessionFile,
			childSessionFile,
			agent,
			modelOverride,
			modelRole,
			state: "starting",
			createdAt,
			lastActivityAt: createdAt,
			queue: [],
			turnCount: 0,
			killed: false,
			suspended: false,
			terminalPersisted: false,
		};
		const key = scopeKey(scope, id);
		const attach = this.#attachBridge(scope, session);
		this.#records.set(key, record);
		attach.bridge.register(attachKeyOfRecord(record), firstLine(args.prompt));
		try {
			await attach.bridge.ensureStarted();
		} catch (error) {
			logger.warn("vibe: attach server failed to start", {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const endpoint = attach.bridge.endpoint();
		let spawnPersisted = false;
		try {
			if (childSessionFile) {
				spawnPersisted = await this.#appendLifecycleEvent(
					session,
					{
						...this.#eventBase(record),
						action: "spawn",
						cli: args.cli,
						agent: agent.name,
						childSessionFile: childSessionName,
						createdAt,
						...(endpoint !== null && {
							attachSocket: endpoint.socketFile,
							attachTokenFile: endpoint.tokenFile,
						}),
					},
					record.parentSessionFile,
				);
				if (!spawnPersisted) throw new ToolError("Vibe parent session changed before the worker could start.");
			}
			const jobId = this.#registerTurnJob(session, manager, record, args.prompt, { first: true });
			return { id, jobId };
		} catch (error) {
			record.killed = true;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "spawn failed";
			if (childSessionFile) {
				// A rejected terminal write leaves this dead record in the map so mode exit can retry it.
				record.terminalPersisted = await this.#appendTombstone(session, record, "spawn-failed");
				if (!record.terminalPersisted) {
					throw new ToolError("Vibe parent session changed before spawn failure could be persisted.");
				}
			}
			this.#records.delete(key);
			this.#attachBridges.get(scopeKey(scope, ""))?.bridge.unregister(attachKeyOfRecord(record), "spawn-failed");
			throw error;
		}
	}

	/**
	 * Send a message to a worker. Mid-turn and streaming → steering; mid-turn
	 * otherwise → queued for the next turn; idle/parked → starts a new
	 * background turn immediately.
	 */
	async send(session: ToolSession, args: { session: string; message: string }): Promise<VibeSendOutcome> {
		const scope = this.ownerScope(session);
		const record = this.#record(scope, args.session);
		if (record.state === "dead") {
			throw new ToolError(`Vibe session "${record.id}" is dead. Spawn a new one with vibe_spawn.`);
		}
		const message = args.message.trim();
		if (!message) throw new ToolError("Message must not be empty.");
		const registered = this.#registeredAgent(record);
		if (AgentRegistry.global().get(record.id) && !registered) {
			throw new ToolError(`Vibe session "${record.id}" no longer resolves to this parent session.`);
		}

		if (record.turn) {
			const live = registered?.session;
			if (live?.isStreaming) {
				await live.steer(message);
				record.lastActivityAt = Date.now();
				return { id: record.id, mode: "steered" };
			}
			record.queue.push(message);
			record.lastActivityAt = Date.now();
			return { id: record.id, mode: "queued" };
		}

		let first = false;
		if (!registered || (registered.status !== "idle" && registered.status !== "parked")) {
			// Pane-abort recovery: the worker's session never completed (the
			// pane Ctrl-C landed in the pre-monitor/spawn window, so no agent
			// ref exists — only the record + attach entry survived). The
			// record is idle WITHOUT a phantom session claim; this prompt
			// re-spawns a fresh session instead of failing. An existing ref
			// that is terminal/ownership-mismatched still throws below.
			if (record.state === "idle" && !registered) {
				first = true;
			} else {
				throw new ToolError(`Vibe session "${record.id}" no longer resolves to this parent session.`);
			}
		}

		// A pane abort leaves any messages that arrived during its unwind
		// queued. Preserve their order ahead of this explicit follow-up.
		const queued = record.queue.splice(0, record.queue.length);
		const turnMessage = [...queued, message].join("\n\n");
		try {
			const manager = this.#manager(session);
			const jobId = this.#registerTurnJob(session, manager, record, turnMessage, { first });
			return { id: record.id, mode: "turn", jobId };
		} catch (error) {
			record.queue.unshift(...queued);
			throw error;
		}
	}

	/**
	 * Block until one watched session's in-flight turn settles, the timeout
	 * elapses, or `signal` aborts — `hub` wait semantics. Settled turns are
	 * acknowledged against the job manager so their results are not delivered
	 * a second time as async follow-ups.
	 */
	async wait(
		session: ToolSession,
		args: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
	): Promise<VibeWaitOutcome> {
		const scope = this.ownerScope(session);
		const manager = this.#manager(session);
		// Named sessions are watched regardless of state (a just-settled turn is
		// reported from its retained job); the no-args form watches every
		// session with a turn actually in flight.
		const watched = args.sessions?.length
			? args.sessions.map(id => this.#record(scope, id))
			: [...this.#records.values()].filter(record => matchesScope(record, scope) && record.turn !== undefined);

		// Snapshot each watched turn's job at entry: #finishTurn installs a
		// queued follow-up turn inside the settling job's callback (before that
		// job's promise resolves), so re-reading record.turn after the race
		// would inspect the *next* running job and silently drop the settled
		// result — whose async delivery watchJobs is suppressing on our behalf.
		const snapshots: Array<{ record: VibeRecord; jobId: string }> = [];
		for (const record of watched) {
			const jobId = record.turn?.jobId ?? record.lastJobId;
			if (jobId) snapshots.push({ record, jobId });
		}

		const collectSettled = (): VibeWaitOutcome["settled"] => {
			const settled: VibeWaitOutcome["settled"] = [];
			for (const { record, jobId } of snapshots) {
				const job = manager.getJob(jobId);
				if (!job || job.status === "running") continue;
				settled.push({
					id: record.id,
					jobId,
					status: job.status,
					resultText: job.resultText ?? job.errorText ?? "(no output)",
				});
			}
			return settled;
		};

		const runningJobs: AsyncJob[] = [];
		for (const { jobId } of snapshots) {
			const job = manager.getJob(jobId);
			if (job?.status === "running") runningJobs.push(job);
		}

		let waitEndedByTimeout = false;
		if (runningJobs.length > 0 && collectSettled().length === 0) {
			const timeoutMs = Math.max(1, Math.trunc(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
			const watchedJobIds = runningJobs.map(job => job.id);
			manager.watchJobs(watchedJobIds);
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<"timeout">();
			const timeoutHandle = setTimeout(() => timeoutResolve("timeout"), timeoutMs);
			const racePromises: Array<Promise<"settled" | "timeout" | "aborted">> = [
				...runningJobs.map(job => job.promise.then(() => "settled" as const)),
				timeoutPromise,
			];
			let abortCleanup: (() => void) | undefined;
			if (args.signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<"aborted">();
				const onAbort = () => abortResolve("aborted");
				if (args.signal.aborted) {
					onAbort();
				} else {
					args.signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => args.signal?.removeEventListener("abort", onAbort);
				}
				racePromises.push(abortPromise);
			}
			try {
				waitEndedByTimeout = (await Promise.race(racePromises)) === "timeout";
			} finally {
				manager.unwatchJobs(watchedJobIds);
				clearTimeout(timeoutHandle);
				abortCleanup?.();
			}
		}

		const settled = collectSettled();
		manager.acknowledgeDeliveries(settled.map(entry => entry.jobId));
		// Current in-flight state, independent of the snapshot: a session whose
		// watched turn settled may already be mid queued follow-up.
		const stillRunning = watched.filter(record => record.turn !== undefined).map(record => record.id);
		return { settled, stillRunning, timedOut: waitEndedByTimeout && settled.length === 0 };
	}

	/** Detach one parent's process-local workers without tombstoning their persisted conversations. */
	async suspendScope(scope: VibeOwnerScope, manager?: AsyncJobManager): Promise<number> {
		const records = [...this.#records.values()].filter(record => matchesScope(record, scope));
		const teardown = records.map(record => ({
			record,
			ref: this.#registeredAgent(record),
			job: record.turn && manager ? manager.getJob(record.turn.jobId) : undefined,
		}));
		for (const { record } of teardown) {
			record.suspended = true;
			record.queue.length = 0;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "suspended for parent-session switch";
			this.#records.delete(scopeKey(scope, record.id));
			this.#attachBridges.get(scopeKey(scope, ""))?.bridge.unregister(attachKeyOfRecord(record), "suspended");
			if (record.turn && manager) manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		const deadline = Date.now() + this.#teardownGraceMs;
		const cleanup = teardown.map(entry => ({
			...entry,
			releaseTask: entry.ref ? this.#trackAgentRelease(entry.record.id, entry.ref, "detach") : undefined,
			jobTask: entry.job ? this.#trackJobSettlement(entry.record, entry.job) : undefined,
		}));
		await waitForVibeTeardown(
			cleanup.flatMap(entry => [entry.releaseTask, entry.jobTask].filter(task => task !== undefined)),
			deadline,
		);
		for (const { record, ref, releaseTask, job, jobTask } of cleanup) {
			if (ref && releaseTask) this.#finishAgentRelease(record.id, ref, releaseTask, "detach");
			if (job && jobTask?.status() === "pending") {
				logger.warn("vibe: timed out waiting for cancelled worker turn; cleanup continues in the background", {
					id: record.id,
					jobId: job.id,
				});
				this.#continueSuspendedCleanup(scope, record, jobTask);
			}
			if (this.#records.has(scopeKey(scope, record.id))) continue;
			const lateRef = this.#registeredAgent(record);
			if (lateRef && lateRef !== ref) {
				await this.#releaseRefWithinDeadline(record.id, lateRef, deadline, "detach");
			}
		}
		const attach = this.#attachBridges.get(scopeKey(scope, ""));
		if (attach) {
			await attach.bridge.stop();
		}
		return records.length;
	}

	#continueSuspendedCleanup(scope: VibeOwnerScope, record: VibeRecord, jobTask: TrackedVibeTeardown): void {
		void jobTask.promise
			.then(async () => {
				if (this.#records.has(scopeKey(scope, record.id))) return;
				const lateRef = this.#registeredAgent(record);
				if (!lateRef) return;
				await this.#releaseRefWithinDeadline(record.id, lateRef, Date.now() + this.#teardownGraceMs, "detach");
			})
			.catch(error => {
				logger.warn("vibe: failed to finish suspended worker cleanup", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Terminate one worker; a tombstone failure still tears it down before reconciliation and error delivery. */
	async kill(session: ToolSession, id: string): Promise<VibeKillOutcome> {
		const scope = this.ownerScope(session);
		return this.#withTerminationLock(scope, () => {
			const record = this.#record(scope, id);
			return this.#killRecord(record, session.asyncJobManager, session, "explicit-kill");
		});
	}

	/** Kill every live session in one parent scope after durably recording the complete mode-exit intent. */
	async killAll(session: VibeParentSession, ownerScope?: VibeOwnerScope): Promise<number> {
		const scope = ownerScope ?? this.ownerScope(session);
		return this.#withTerminationLock(scope, async () => {
			try {
				const killed = await this.#killAllLocked(session, scope);
				this.#terminatedScopes.add(scopeKey(scope, ""));
				return killed;
			} catch (error) {
				if (error instanceof SessionPersistenceIndeterminateError) {
					this.#terminatedScopes.add(scopeKey(scope, ""));
				}
				throw error;
			} finally {
				const attach = this.#attachBridges.get(scopeKey(scope, ""));
				if (attach) {
					await attach.bridge.stop();
					this.#attachBridges.delete(scopeKey(scope, ""));
				}
			}
		});
	}

	async #killAllLocked(session: VibeParentSession, scope: VibeOwnerScope): Promise<number> {
		const records = [...this.#records.values()].filter(
			record => matchesScope(record, scope) && !(record.state === "dead" && record.terminalPersisted),
		);
		if (records.length === 0) {
			const entries = session.sessionManager?.getBranch() ?? [];
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry.type !== "mode_change") continue;
				if (entry.mode === "none") return 0;
				break;
			}
		}
		try {
			await this.#persistModeExit(session, scope, records);
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) {
				const teardownDeadline = Date.now() + this.#teardownGraceMs;
				await Promise.all(
					records.map(record =>
						this.#killRecord(record, session.asyncJobManager, session, "mode-exit", false, teardownDeadline),
					),
				);
			}
			throw error;
		}
		const teardownDeadline = Date.now() + this.#teardownGraceMs;
		await Promise.all(
			records.map(record =>
				this.#killRecord(record, session.asyncJobManager, session, "mode-exit", true, teardownDeadline),
			),
		);
		return records.length;
	}

	async #killRecord(
		record: VibeRecord,
		manager: AsyncJobManager | undefined,
		session: VibeParentSession,
		reason: VibeTombstoneReason,
		persistTerminal = true,
		teardownDeadline?: number,
	): Promise<VibeKillOutcome> {
		const registered = this.#registeredAgent(record);
		const settlingJobs = new Set<AsyncJob>();
		if (record.turn && manager) {
			const job = manager.getJob(record.turn.jobId);
			if (job) settlingJobs.add(job);
		}
		let persistenceError: unknown;
		if (persistTerminal && !record.terminalPersisted) {
			try {
				if (record.killed) {
					const recover = session.sessionManager?.recoverPersistenceFromCurrentState;
					if (!recover) throw new ToolError("Vibe tombstone recovery requires parent-session persistence.");
					await recover.call(session.sessionManager);
				}
				if (!this.#hasInMemoryTombstone(session, record) && record.childSessionFile) {
					if (!(await this.#appendTombstone(session, record, reason))) {
						throw new ToolError(`Vibe session "${record.id}" changed parent scope before termination.`);
					}
				}
				record.terminalPersisted = true;
			} catch (error) {
				persistenceError = error;
			}
		}
		record.killed = true;
		record.queue.length = 0;
		let cancelledTurn = false;
		if (record.turn && manager) {
			const job = manager.getJob(record.turn.jobId);
			if (job) settlingJobs.add(job);
			cancelledTurn = manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		record.state = "dead";
		record.lastActivityAt = Date.now();
		record.lastActivity = "killed";
		const deadline = teardownDeadline ?? Date.now() + this.#teardownGraceMs;
		const releaseTask = registered ? this.#trackAgentRelease(record.id, registered, "release") : undefined;
		const jobCleanup = [...settlingJobs].map(job => ({ job, task: this.#trackJobSettlement(record, job) }));
		await waitForVibeTeardown(
			[releaseTask, ...jobCleanup.map(entry => entry.task)].filter(task => task !== undefined),
			deadline,
		);
		if (registered && releaseTask) this.#finishAgentRelease(record.id, registered, releaseTask, "release");
		const pendingJobs = jobCleanup.filter(entry => entry.task.status() === "pending");
		for (const { job } of pendingJobs) {
			logger.warn("vibe: timed out waiting for cancelled worker turn; cleanup continues in the background", {
				id: record.id,
				jobId: job.id,
			});
		}
		const terminalRef = registered ?? this.#registeredAgent(record) ?? null;
		await this.#markTerminalRecord(record, terminalRef, deadline);
		this.#attachForRecord(record)?.unregister(attachKeyOfRecord(record), `vibe ${reason}`);
		if (pendingJobs.length > 0) {
			this.#continueKilledCleanup(
				record,
				pendingJobs.map(entry => entry.task),
				registered,
			);
		}
		if (persistenceError) {
			let finalPersistenceError = persistenceError;
			const recover = session.sessionManager?.recoverPersistenceFromCurrentState;
			if (recover) {
				try {
					await recover.call(session.sessionManager);
					if (!this.#hasInMemoryTombstone(session, record) && record.childSessionFile) {
						if (!(await this.#appendTombstone(session, record, reason))) {
							throw new ToolError(`Vibe session "${record.id}" changed parent scope before termination.`);
						}
					}
					record.terminalPersisted = true;
				} catch (recoveryError) {
					if (recoveryError instanceof SessionPersistenceIndeterminateError) {
						finalPersistenceError = recoveryError;
					}
					logger.warn("vibe: failed to reconcile explicit tombstone persistence", {
						id: record.id,
						error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
					});
				}
			}
			throw finalPersistenceError;
		}
		return { id: record.id, cancelledTurn };
	}

	async #markTerminalRecord(
		record: VibeRecord,
		expected: AgentRef | null | undefined,
		teardownDeadline: number,
	): Promise<void> {
		if (!record.childSessionFile) return;
		try {
			const persisted = await SessionManager.peekSessionInit(record.childSessionFile);
			if (persisted?.init) {
				await this.#markTerminalRef(record.id, record.ownerId, record.childSessionFile, expected, teardownDeadline);
			}
		} catch (error) {
			logger.warn("vibe: failed to retain terminal worker transcript", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#continueKilledCleanup(
		record: VibeRecord,
		jobTasks: readonly TrackedVibeTeardown[],
		expected: AgentRef | undefined,
	): void {
		void Promise.allSettled(jobTasks.map(task => task.promise))
			.then(() => this.#markTerminalRecord(record, expected, Date.now() + this.#teardownGraceMs))
			.catch(error => {
				logger.warn("vibe: failed to finish killed worker cleanup", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Build the ExecutorOptions for a first spawn, mirroring the `task`/eval-bridge plumbing. */
	async #buildSpawnOptions(
		session: ToolSession,
		record: VibeRecord,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<ExecutorOptions> {
		const sessionFile = session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `omp-vibe-${Snowflake.next()}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		if (!sessionArtifactsDir) registerArtifactsDir(artifactsDir);
		const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? (() => null),
			getSessionId: session.getSessionId ?? (() => null),
		};
		const endpoint = this.#attachForRecord(record)?.endpoint();
		return {
			cwd: session.cwd,
			agent: record.agent,
			task: message,
			assignment: message,
			description: `vibe ${record.cli} session`,
			index: 0,
			id: record.id,
			taskDepth: session.taskDepth ?? 0,
			detached: true,
			...(endpoint !== undefined &&
				endpoint !== null && {
					attachSocket: endpoint.socketFile,
					attachTokenFile: endpoint.tokenFile,
				}),
			modelOverride: record.modelOverride,
			modelRole: record.modelRole,
			parentActiveModelPattern: session.getActiveModelString?.(),
			thinkingLevel: record.agent.thinkingLevel,
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			enableLsp: (session.enableLsp ?? true) && session.settings.get("task.enableLsp"),
			signal,
			eventBus: session.eventBus,
			onProgress,
			authStorage: session.authStorage,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			mcpManager: session.mcpManager ?? MCPManager.instance(),
			contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
			skills: [...(session.skills ?? [])],
			workspaceTree: session.workspaceTree,
			promptTemplates: session.promptTemplates,
			rules: session.rules,
			preloadedExtensionPaths: session.extensionPaths,
			preloadedTrustedExtensionPaths: session.trustedExtensionPaths,
			preloadedCustomToolPaths: session.customToolPaths,
			localProtocolOptions,
			parentArtifactManager: session.getArtifactManager?.() ?? undefined,
			parentHindsightSessionState: session.getHindsightSessionState?.(),
			parentMnemopiSessionState: session.getMnemopiSessionState?.(),
			parentTelemetry: session.getTelemetry?.(),
			parentEvalSessionId: session.getEvalSessionId?.() ?? undefined,
			parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
			keepAlive: true,
			// Attach-scoped resumability: a pane Ctrl-C abort during spawn is a
			// user interrupt, not a kill — the lifecycle finalizer must keep the
			// adopted session resumable instead of tombstoning it.
			revivableAbort: () => record.paneAbortPending === true,
		};
	}

	/** Register one background job that runs a single worker turn and self-delivers its result. */
	#registerTurnJob(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		message: string,
		options: { first: boolean },
	): string {
		const turnIndex = record.turnCount + 1;
		const turn: VibeTurn = {
			jobId: "",
			message,
			startedAt: Date.now(),
			trace: [],
			toolCount: 0,
		};
		const onProgress = (progress: AgentProgress): void => {
			mergeTrace(turn, progress);
			record.resolvedModel = progress.resolvedModel ?? record.resolvedModel;
			// recentOutput is newest-first; keep the latest lines oldest-first for display.
			const live = {
				currentTool: progress.currentTool,
				currentToolArgs: progress.currentToolArgs,
				lastIntent: progress.lastIntent,
				outputTail: progress.recentOutput.slice(0, 3).reverse(),
			};
			record.live = live;
			const gist =
				progress.lastIntent ??
				(progress.currentTool ? `${progress.currentTool} ${progress.currentToolArgs ?? ""}` : undefined);
			if (gist) record.lastActivity = firstLine(gist);
			record.lastActivityAt = Date.now();
			// Live progress reaches the attach wire (coalesced per worker by the
			// bridge); the final state is flushed before the turn settles below.
			this.#attachForRecord(record)?.progress(attachKeyOfRecord(record), live);
		};

		const jobId = manager.register(
			"task",
			`vibe ${record.cli} ${record.id}: ${firstLine(message, 60)}`,
			async ({ jobId: ownJobId, signal }) => {
				record.state = "running";
				this.#attachForRecord(record)?.updateState(attachKeyOfRecord(record), "running");
				record.turnCount = turnIndex;
				record.lastActivityAt = Date.now();
				try {
					const turnStartedPersisted = await this.#appendLifecycleEvent(
						session,
						{
							...this.#eventBase(record),
							action: "turn-started",
							turn: turnIndex,
						},
						record.parentSessionFile,
					);
					if (record.childSessionFile && !turnStartedPersisted) {
						throw new ToolError(`Vibe session "${record.id}" changed parent scope before its turn started.`);
					}
					const result = options.first
						? await runSubprocess(await this.#buildSpawnOptions(session, record, message, signal, onProgress))
						: await runSubagentFollowUpTurn({
								id: record.id,
								agent: record.agent,
								message,
								description: `vibe ${record.cli} session`,
								signal,
								onProgress,
								eventBus: session.eventBus,
								artifactsDir: session.getSessionFile()?.slice(0, -6),
							});
					// Final progress flush: the turn is about to settle, so any
					// coalesced live state must reach the wire now.
					this.#attachForRecord(record)?.flushProgress(attachKeyOfRecord(record));
					return await this.#settleTurn(session, manager, record, turn, ownJobId, turnIndex, result);
				} catch (error) {
					if (error instanceof VibeTurnError) throw error;
					this.#attachForRecord(record)?.flushProgress(attachKeyOfRecord(record));
					await this.#finishTurn(session, manager, record, ownJobId);
					const reason = error instanceof Error ? error.message : String(error);
					record.lastActivity = firstLine(`turn failed: ${reason}`);
					throw new VibeTurnError(
						`[vibe:${record.id} cli=${record.cli} turn=${turnIndex}] turn failed: ${reason}`,
					);
				}
			},
			{ id: `${record.id}-t${turnIndex}`, agentId: record.id, ownerId: record.ownerId },
		);
		turn.jobId = jobId;
		record.turn = turn;
		return jobId;
	}

	/** Post-turn bookkeeping shared by success and failure paths: clear the in-flight turn, flush the queue. */
	async #finishTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		settledJobId: string,
	): Promise<void> {
		record.lastJobId = settledJobId;
		record.turn = undefined;
		record.live = undefined;
		record.lastActivityAt = Date.now();
		if (record.killed || record.suspended) {
			// A concurrent kill/suspend won over a pane abort: consume the
			// marker so it cannot mislabel a later settle, and stay terminal.
			record.paneAbortPending = false;
			record.state = "dead";
			return;
		}
		// Only an idle/parked ref with this parent's exact child file is resumable.
		const registered = this.#registeredAgent(record);
		const paneAborted = record.paneAbortPending === true;
		if (paneAborted) {
			// A pane Ctrl-C aborted the in-flight turn: the worker session must
			// survive (attach contract — the pane and the worker both stay
			// alive and the next follow-up is accepted). The abort unwinding
			// can race the agent_end → idle status sync, so the ref may still
			// be "running" here; reconcile it to a live status instead of
			// treating the interrupt as an unrecoverable failure.
			record.paneAbortPending = false;
			if (
				vibeWorkerSurvivesTurnSettle({
					killed: false,
					suspended: false,
					paneAbortPending: true,
					registeredStatus: registered?.status,
				})
			) {
				if (registered && registered.status !== "idle" && registered.status !== "parked") {
					AgentRegistry.global().setStatus(record.id, "idle", registered);
				}
				record.state = "idle";
			} else {
				record.state = "dead";
			}
		} else {
			record.state = vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: false,
				registeredStatus: registered?.status,
			})
				? "idle"
				: "dead";
		}
		if (record.state === "dead") {
			record.terminalPersisted = await this.#appendTombstone(session, record, "unrecoverable");
			this.#attachForRecord(record)?.unregister(attachKeyOfRecord(record), "unrecoverable turn failure");
			return;
		}
		this.#attachForRecord(record)?.updateState(attachKeyOfRecord(record), "idle", record.lastActivity ?? null);
		const settledPersisted = await this.#appendLifecycleEvent(
			session,
			{
				...this.#eventBase(record),
				action: "turn-settled",
				turn: record.turnCount,
			},
			record.parentSessionFile,
		);
		if (record.childSessionFile && !settledPersisted) {
			record.state = "dead";
			return;
		}
		// Pane Ctrl-C interrupts only the current turn. Keep messages queued
		// while abort unwinding finishes; the next explicit send starts them
		// against the settled worker instead of racing a follow-up here.
		if (paneAborted) return;
		if (record.queue.length === 0) return;
		const nextMessage = record.queue.splice(0, record.queue.length).join("\n\n");
		try {
			// A concurrent kill/suspend racing the settle must never respawn
			// work for a dying record: preserve the messages (mirroring the
			// failure path below) instead of spawning an empty turn.
			if (record.killed || record.suspended) {
				if (nextMessage) record.queue.unshift(nextMessage);
				return;
			}
			// Pane-abort recovery: when the worker's session never completed
			// (or is gone), a queued message must SPAWN a fresh session
			// (first turn) instead of failing a follow-up on a missing ref.
			const nextRegistered = this.#registeredAgent(record);
			const resumable =
				nextRegistered !== undefined && (nextRegistered.status === "idle" || nextRegistered.status === "parked");
			this.#registerTurnJob(session, manager, record, nextMessage, { first: !resumable });
		} catch (error) {
			// Leave the messages recoverable: a later vibe_send flushes again.
			record.queue.unshift(nextMessage);
			logger.warn("vibe: failed to start queued follow-up turn", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Format a settled turn into the self-delivering result text (activity trace + response). */
	async #settleTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		turn: VibeTurn,
		settledJobId: string,
		turnIndex: number,
		result: SingleResult,
	): Promise<string> {
		await this.#finishTurn(session, manager, record, settledJobId);
		const failed = result.exitCode !== 0 || result.aborted === true;
		const status = result.aborted ? "aborted" : failed ? "failed" : "completed";
		record.lastActivity = firstLine(
			failed
				? `turn ${turnIndex} ${status}: ${result.abortReason ?? result.error ?? ""}`
				: (result.lastIntent ?? result.output),
		);

		const traceLines = turn.trace.map(entry =>
			firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX),
		);
		const traceOverflow = Math.max(0, turn.toolCount - turn.trace.length);
		let response = result.output.trim() || "(no output)";
		let responseTruncated = false;
		if (response.length > RESPONSE_PREVIEW_MAX) {
			const slice = response.slice(0, RESPONSE_PREVIEW_MAX);
			const lastNewline = slice.lastIndexOf("\n");
			response = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
			responseTruncated = true;
		}
		let text: string;
		try {
			text = prompt
				.render(vibeTurnResultTemplate, {
					id: record.id,
					cli: record.cli,
					turn: turnIndex,
					status,
					duration: formatDuration(result.durationMs),
					requests: result.requests,
					toolCount: turn.toolCount,
					model: result.resolvedModel ?? record.resolvedModel ?? "",
					trace: traceLines,
					traceOverflow: traceOverflow > 0 ? traceOverflow : undefined,
					response,
					responseTruncated,
					error: failed ? (result.abortReason ?? result.error ?? result.stderr ?? "") : "",
					alive: record.state !== "dead",
				})
				.trim();
		} catch (error) {
			// A formatting bug must never turn a finished worker turn into a false
			// failure — the work is done; degrade to a plain-text assembly.
			logger.warn("vibe: turn-result template render failed; using plain fallback", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
			text = [
				`[vibe:${record.id} cli=${record.cli} turn=${turnIndex} status=${status}]`,
				`Activity (${turn.toolCount} tool calls, ${result.requests} requests):`,
				...traceLines.map(line => `- ${line}`),
				"",
				"Response:",
				response,
			].join("\n");
		}
		if (failed) throw new VibeTurnError(text);
		return text;
	}
}

/**
 * Aggregate tok/s across every live vibe worker session owned by `ownerId`.
 * Returns null when no workers are streaming (so callers can fall back to
 * their own rate unchanged). The director is often idle while workers stream,
 * so without this aggregation the status-line tok/s badge would show a stale
 * value while parallel work is actively generating tokens.
 *
 * Reads each worker's last assistant message via {@link calculateTokensPerSecond}
 * — the same leaf calculator the main status line uses — so worker rates are
 * computed identically to the main session's rate.
 */
export function aggregateVibeWorkerTokensPerSecond(ownerId: string): number | null {
	const ids = VibeSessionRegistry.global().listIdsByOwner(ownerId);
	if (ids.length === 0) return null;
	let total = 0;
	let any = false;
	const registry = AgentRegistry.global();
	for (const id of ids) {
		const workerSession = registry.get(id)?.session;
		if (!workerSession?.isStreaming) continue;
		const rate = calculateTokensPerSecond(workerSession.state.messages, true);
		if (rate !== null) {
			total += rate;
			any = true;
		}
	}
	return any ? total : null;
}
