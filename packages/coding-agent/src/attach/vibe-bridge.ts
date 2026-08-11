/**
 * attach/vibe-bridge.ts — wires the attach substrate into the Vibe worker lifecycle.
 *
 * One {@link AttachVibeBridge} exists per owner scope and owns that scope's
 * {@link AttachRegistry} + {@link AttachServer}. `VibeSessionRegistry`
 * drives it through the lifecycle hooks:
 *
 *   spawn       → register (state starting → running once the turn starts)
 *   turn settle → updateState (idle / parked when the AgentLifecycle parks it)
 *   kill/teardown → unregister (the worker is no longer live here)
 *   suspend     → stop the bridge (workers detach to another process)
 *   rehydrate   → re-register (revived)
 *
 * Prompts are serialized per worker: the callback routes through
 * `VibeSessionRegistry.send` — the SAME turn-job queue as `vibe_send` — and
 * then awaits the registered turn job, so `prompt_result` carries the real
 * turn outcome and a second concurrent prompt for the same worker is
 * rejected with `busy`. Abort cancels the in-flight turn job (never kills
 * the worker: the adopted session survives to be parked or resumed).
 *
 * The worker's live session reaches the registry ONLY as the typed
 * {@link AttachLiveSessionSource} presentation surface (see live-session.ts);
 * no attach path ever touches the raw AgentSession.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AttachLiveSessionSource } from "./live-session";
import {
	type AttachProgressInput,
	type AttachWorkerKey,
	type AttachWorkerState,
	sanitizeAttachProgress,
} from "./protocol";
import { type AttachFollowUpResult, AttachRegistry, attachKeyString } from "./registry";
import { AttachServer } from "./server";

/** Wire payload for a prompt: the prompt text sent to the worker. */
export function attachPromptOf(payload: unknown): string {
	if (typeof payload === "string") return payload;
	try {
		const text = JSON.stringify(payload);
		return text === undefined ? "" : text;
	} catch {
		return String(payload);
	}
}

/**
 * Per-worker live-progress coalescing window. onProgress can fire several
 * times per tool execution; the bridge keeps only the freshest state per
 * worker and emits it at most once per window.
 */
export const ATTACH_PROGRESS_COALESCE_MS = 120;

export interface AttachVibeBridgeCallbacks {
	/** Serialized prompt runner (same turn-job queue as vibe_send). */
	runTurn: (key: AttachWorkerKey, prompt: string, options?: { timeoutMs?: number }) => Promise<AttachFollowUpResult>;
	/** Cancel the in-flight turn for a worker; never kills the worker. */
	abortTurn: (key: AttachWorkerKey, reason?: string) => Promise<boolean>;
	/**
	 * The worker's live session as the typed presentation source (never the
	 * raw AgentSession). Null when the worker's session has not materialized.
	 */
	liveSessionOf: (key: AttachWorkerKey) => AttachLiveSessionSource | null;
	/** Whether the worker is currently parked by the AgentLifecycleManager. */
	isParked: (key: AttachWorkerKey) => boolean;
}

export interface AttachVibeBridgeOptions extends AttachVibeBridgeCallbacks {
	/** Owner scope this bridge serves. */
	ownerScope: string;
	/** Artifacts/runtime directory; the 0700 attach dir is created inside. */
	baseDir: string;
	/** Clock injection for deterministic tests. */
	now?: () => number;
	/** Progress coalescing window override (ms). Tests shorten this. */
	progressCoalesceMs?: number;
}

/** Attach runtime dir basename inside the session artifacts directory. */
export const ATTACH_RUNTIME_DIR_NAME = "attach";

/**
 * Per-scope attach substrate: registry + server + lifecycle hooks. The server
 * binds lazily on {@link ensureStarted} (first worker spawn) and stops on
 * scope teardown; a stopped bridge can be restarted (parent rehydrate).
 */
export class AttachVibeBridge {
	readonly registry: AttachRegistry;
	readonly server: AttachServer;
	readonly ownerScope: string;
	readonly #runTurn: AttachVibeBridgeCallbacks["runTurn"];
	readonly #abortTurn: AttachVibeBridgeCallbacks["abortTurn"];
	readonly #liveSessionOf: AttachVibeBridgeCallbacks["liveSessionOf"];
	readonly #isParked: AttachVibeBridgeCallbacks["isParked"];
	readonly #progressCoalesceMs: number;
	/** Latest pending progress per worker (replaced until the timer fires). */
	readonly #pendingProgress = new Map<string, AttachProgressInput>();
	/** Coalescing timers per worker; one in flight at a time. */
	readonly #progressTimers = new Map<string, NodeJS.Timeout>();
	#started = false;
	#stopped = false;

	constructor(options: AttachVibeBridgeOptions) {
		this.ownerScope = options.ownerScope;
		this.#runTurn = options.runTurn;
		this.#abortTurn = options.abortTurn;
		this.#liveSessionOf = options.liveSessionOf;
		this.#isParked = options.isParked;
		this.#progressCoalesceMs = options.progressCoalesceMs ?? ATTACH_PROGRESS_COALESCE_MS;
		this.registry = new AttachRegistry({
			runPrompt: (key, text, promptOptions) => this.#runTurn(key, text, promptOptions),
			followUp: (key, payload, followUpOptions) => this.#followUp(key, payload, followUpOptions?.timeoutMs),
			abort: (key, reason) => this.#abortTurn(key, reason),
			// Resolved lazily: the worker session materializes AFTER register.
			liveSessionOf: key => this.#liveSessionOf(key),
			now: options.now,
		});
		const runtimeDir = path.join(options.baseDir, ATTACH_RUNTIME_DIR_NAME);
		this.server = new AttachServer({
			runtimeDir,
			ownerScope: options.ownerScope,
			registry: this.registry,
		});
	}

	get started(): boolean {
		return this.#started;
	}

	/**
	 * The attach endpoint paths (socket + token file), or null before the
	 * server started. Paths only — never capability contents. Lifecycle
	 * payloads carry these so pane launchers never derive them from the
	 * session file (fallback parents have none).
	 */
	endpoint(): { socketFile: string; tokenFile: string } | null {
		return this.#started ? { socketFile: this.server.socketFile, tokenFile: this.server.tokenFile } : null;
	}

	/** Bind the 0600 socket + token file. Idempotent; restarts after stop(). */
	async ensureStarted(): Promise<void> {
		if (this.#started) return;
		await this.server.start();
		this.#started = true;
		this.#stopped = false;
	}

	/** Close the server and drop every registered worker entry. */
	async stop(): Promise<void> {
		if (this.#stopped && !this.#started) return;
		this.#started = false;
		this.#stopped = true;
		this.#clearAllProgress();
		for (const session of this.registry.snapshot().sessions) {
			this.registry.unregister(session.key, "attach scope stopped");
		}
		await this.server.stop();
	}

	// -----------------------------------------------------------------------
	// Lifecycle hooks (called by VibeSessionRegistry)
	// -----------------------------------------------------------------------

	/** Register a freshly spawned or rehydrated (revived) worker. */
	register(key: AttachWorkerKey, summary?: string | null, revived = false): void {
		if (this.registry.has(key)) return;
		this.registry.register(key, this.#liveSessionOf(key), summary);
		if (revived) this.registry.updateState(key, "revived", summary);
	}

	/** Update the worker's state after a turn settles / starts / kills. */
	updateState(key: AttachWorkerKey, state: AttachWorkerState, summary?: string | null): void {
		const mapped = this.#mapState(key, state);
		this.registry.updateState(key, mapped, summary);
	}

	/** Reflect the latest activity gist into the entry summary + touch time. */
	activity(key: AttachWorkerKey, summary: string | null): void {
		this.registry.setSummary(key, summary);
		this.registry.touch(key);
	}

	/** Unregister a worker that left this process (kill, suspend, failure). */
	unregister(key: AttachWorkerKey, reason: string): void {
		this.#dropProgress(key);
		this.registry.unregister(key, reason);
	}

	// -----------------------------------------------------------------------
	// Live progress (coalesced per worker; runtime calls on every onProgress)
	// -----------------------------------------------------------------------

	/**
	 * Queue the latest live-progress state for a worker. Emissions are
	 * coalesced per worker within `progressCoalesceMs` (default 120ms) so the
	 * wire carries at most the freshest snapshot per window; the runtime calls
	 * {@link flushProgress} before a turn settles to guarantee the final state
	 * is delivered.
	 */
	progress(key: AttachWorkerKey, input: AttachProgressInput): void {
		const keyString = attachKeyString(key);
		this.#pendingProgress.set(keyString, input);
		if (this.#progressTimers.has(keyString)) return;
		const timer = setTimeout(() => {
			this.#progressTimers.delete(keyString);
			this.#emitPending(keyString, key);
		}, this.#progressCoalesceMs);
		this.#progressTimers.set(keyString, timer);
	}

	/** Emit any pending progress for a worker immediately (final flush). */
	flushProgress(key: AttachWorkerKey): void {
		const keyString = attachKeyString(key);
		const timer = this.#progressTimers.get(keyString);
		if (timer) {
			clearTimeout(timer);
			this.#progressTimers.delete(keyString);
		}
		this.#emitPending(keyString, key);
	}

	#emitPending(keyString: string, key: AttachWorkerKey): void {
		const pending = this.#pendingProgress.get(keyString);
		if (pending === undefined) return;
		this.#pendingProgress.delete(keyString);
		this.registry.emitProgress(key, sanitizeAttachProgress(pending), Date.now());
	}

	#dropProgress(key: AttachWorkerKey): void {
		const keyString = attachKeyString(key);
		const timer = this.#progressTimers.get(keyString);
		if (timer) {
			clearTimeout(timer);
			this.#progressTimers.delete(keyString);
		}
		this.#pendingProgress.delete(keyString);
	}

	#clearAllProgress(): void {
		for (const timer of this.#progressTimers.values()) clearTimeout(timer);
		this.#progressTimers.clear();
		this.#pendingProgress.clear();
	}

	// -----------------------------------------------------------------------
	// Serialized prompt/follow-up (same queue as vibe_send)
	// -----------------------------------------------------------------------

	async #followUp(key: AttachWorkerKey, payload: unknown, timeoutMs?: number): Promise<AttachFollowUpResult> {
		const prompt = attachPromptOf(payload);
		return this.#runTurn(key, prompt, { timeoutMs });
	}

	#mapState(key: AttachWorkerKey, state: AttachWorkerState): AttachWorkerState {
		if (state === "idle") return this.#isParked(key) ? "parked" : "idle";
		if (state === "finished") return "finished";
		return state;
	}
}

/** Default base dir when no session artifacts dir exists (tmp, 0700). */
export function attachFallbackBaseDir(ownerScope: string): string {
	const hash = [...ownerScope].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7);
	return path.join(os.tmpdir(), `omp-attach-${hash.toString(36)}`);
}
