import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { ExecutorOptions, FollowUpTurnOptions } from "../../src/task/executor";
import type { SingleResult } from "../../src/task/types";
import { VibeSessionRegistry } from "../../src/vibe/runtime";

const WORKER_ID = "w1";
const OWNER = "test-owner";

/**
 * Regression (attach v2 pane-abort recovery): after a pane Ctrl-C abort lands
 * in the pre-monitor/spawn window, the worker record survives idle WITHOUT an
 * AgentRegistry ref. The next `send()` to that worker must rematerialize a
 * fresh session through the FIRST-SPAWN path (`runSubprocess`, `{ first:
 * true }`) — never the follow-up path (`runSubagentFollowUpTurn`), which
 * would fail on the missing ref and strand the prompt.
 *
 * The registry test seam keys records by the runtime's scopeKey so the fake
 * parent session (getSessionId "test-parent-session", sessionFile null)
 * resolves the record exactly like a real `send()` does.
 */

/** Executor calls captured by the spies, in order. */
const spawned: ExecutorOptions[] = [];
const followedUp: FollowUpTurnOptions[] = [];

/** When armed, the next mocked spawn is held open until the test releases it. */
let spawnGate: Promise<void> = Promise.resolve();
let releaseSpawnGate: (() => void) | undefined;

function holdNextSpawn(): void {
	spawnGate = new Promise<void>(resolve => {
		releaseSpawnGate = resolve;
	});
}

/** Minimal settled spawn/follow-up result the settle path can render. */
function okResult(): SingleResult {
	return {
		index: 0,
		id: WORKER_ID,
		agent: "sonic",
		agentSource: "bundled",
		task: "spawn task",
		exitCode: 0,
		output: "spawned ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function installExecutorFakes(): void {
	VibeSessionRegistry.global().setExecutorForTests({
		runSubprocess: async (options: ExecutorOptions) => {
			spawned.push(options);
			await spawnGate;
			return okResult();
		},
		runSubagentFollowUpTurn: async (options: FollowUpTurnOptions) => {
			followedUp.push(options);
			return okResult();
		},
	});
}

/** Minimal parent session the runtime's scope + spawn plumbing reads. */
type FakeSession = Parameters<typeof VibeSessionRegistry.prototype.send>[0];

function fakeSession(): FakeSession {
	return {
		getSessionId: () => "test-parent-session",
		getAgentId: () => OWNER,
		getSessionFile: () => null,
		cwd: os.tmpdir(),
		settings: Settings.isolated({}),
		asyncJobManager: new AsyncJobManager({}),
	} as unknown as FakeSession;
}

describe("vibe send() first-spawn recovery for an idle record with a missing ref", () => {
	beforeEach(() => {
		installExecutorFakes();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		spawned.length = 0;
		followedUp.length = 0;
		spawnGate = Promise.resolve();
		releaseSpawnGate = undefined;
	});

	it("chooses the first-spawn path (runSubprocess) and never the follow-up", async () => {
		// Idle record, NO AgentRegistry ref (pane-abort spawn window).
		VibeSessionRegistry.global().registerRecordForTests({
			id: WORKER_ID,
			ownerId: OWNER,
			state: "idle",
		});

		const session = fakeSession();
		const outcome = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "first message",
		});

		expect(outcome).toMatchObject({ id: WORKER_ID, mode: "turn" });
		const jobId = outcome.jobId;
		expect(typeof jobId).toBe("string");

		// The turn job completes through the spawn path.
		const manager = session.asyncJobManager;
		expect(manager).toBeDefined();
		const job = jobId !== undefined && manager !== undefined ? manager.getJob(jobId) : undefined;
		expect(job).toBeDefined();
		await expect(job!.promise).resolves.toBeUndefined();

		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.id).toBe(WORKER_ID);
		expect(spawned[0]!.task).toBe("first message");
		expect(followedUp).toHaveLength(0);
	});

	it("keeps abort-window messages ahead of the next explicit send", async () => {
		VibeSessionRegistry.global().registerRecordForTests({
			id: WORKER_ID,
			ownerId: OWNER,
			state: "idle",
			queue: ["queued during abort"],
		});

		const session = fakeSession();
		const outcome = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "after abort",
		});
		const manager = session.asyncJobManager;
		const job = outcome.jobId !== undefined && manager !== undefined ? manager.getJob(outcome.jobId) : undefined;
		expect(job).toBeDefined();
		await expect(job!.promise).resolves.toBeUndefined();

		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.task).toBe("queued during abort\n\nafter abort");
		expect(followedUp).toHaveLength(0);
	});

	it("keeps queued messages parked until an explicit send after pane abort", async () => {
		VibeSessionRegistry.global().registerRecordForTests({
			id: WORKER_ID,
			ownerId: OWNER,
			state: "idle",
		});
		const session = fakeSession();

		holdNextSpawn();
		const first = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "first message",
		});
		const queued = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "queued during abort",
		});
		expect(queued.mode).toBe("queued");
		expect(VibeSessionRegistry.global().abortAttachTurnForTests(session, WORKER_ID)).toBe(true);
		releaseSpawnGate?.();

		const manager = session.asyncJobManager;
		const firstJob = first.jobId !== undefined && manager !== undefined ? manager.getJob(first.jobId) : undefined;
		expect(firstJob).toBeDefined();
		await expect(firstJob!.promise).resolves.toBeUndefined();
		expect(spawned).toHaveLength(1);
		expect(followedUp).toHaveLength(0);

		const resumed = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "after abort",
		});
		const resumedJob =
			resumed.jobId !== undefined && manager !== undefined ? manager.getJob(resumed.jobId) : undefined;
		expect(resumedJob).toBeDefined();
		await expect(resumedJob!.promise).resolves.toBeUndefined();

		expect(spawned).toHaveLength(2);
		expect(spawned[1]!.task).toBe("queued during abort\n\nafter abort");
		expect(followedUp).toHaveLength(0);
	});

	it("never re-spawns a dead/killed worker's queued messages", async () => {
		// Idle record, NO AgentRegistry ref — the pane-abort spawn window.
		VibeSessionRegistry.global().registerRecordForTests({
			id: WORKER_ID,
			ownerId: OWNER,
			state: "idle",
		});
		const session = fakeSession();

		// Turn 1 starts and is held open inside the mocked spawn.
		holdNextSpawn();
		const first = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "first message",
		});
		expect(first.mode).toBe("turn");

		// A follow-up message queues while turn 1 is still in flight.
		const queued = await VibeSessionRegistry.global().send(session, {
			session: WORKER_ID,
			message: "queued message",
		});
		expect(queued.mode).toBe("queued");

		// Kill lands while the turn is in flight: it clears the queue and
		// tombstones the record. The settle that follows must NOT drain the
		// queue into a fresh spawn.
		const killPromise = VibeSessionRegistry.global().kill(session, WORKER_ID);
		releaseSpawnGate?.();
		await killPromise;

		// Only turn 1 was ever dispatched; the queued message did not respawn.
		expect(spawned).toHaveLength(1);
		expect(followedUp).toHaveLength(0);

		// The record is terminal: a further send() rejects instead of reviving.
		await expect(
			VibeSessionRegistry.global().send(session, { session: WORKER_ID, message: "after kill" }),
		).rejects.toThrow(/is dead/);
	});
});
