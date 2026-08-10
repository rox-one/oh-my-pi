import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachWorkerKey, AttachWorkerState } from "../../src/attach/protocol";
import { AttachVibeBridge } from "../../src/attach/vibe-bridge";

const KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-a" };

function makeBridge(overrides: { parked?: boolean } = {}) {
	const baseDir = path.join(os.tmpdir(), `omp-attach-bridge-${Math.random().toString(36).slice(2)}`);
	const calls: string[] = [];
	const bridge = new AttachVibeBridge({
		ownerScope: "scope-a",
		baseDir,
		runTurn: async () => {
			calls.push("runTurn");
			return { ok: true, payload: "out" };
		},
		abortTurn: async () => {
			calls.push("abortTurn");
			return true;
		},
		liveSessionOf: key => ({ live: key.workerId }),
		isParked: () => overrides.parked === true,
	});
	return { bridge, baseDir, calls };
}

describe("attach vibe bridge", () => {
	it("registers workers with the live harness session and revives as revived state", () => {
		const { bridge } = makeBridge();
		bridge.register(KEY, "spawned");
		expect(bridge.registry.size).toBe(1);
		expect(bridge.registry.liveSession(KEY)).toEqual({ live: "w1" });
		expect(bridge.registry.snapshot().sessions[0].state).toBe("starting");
		bridge.register(KEY, "spawned"); // idempotent: already present
		expect(bridge.registry.size).toBe(1);
		bridge.unregister(KEY, "killed");
		bridge.register(KEY, "again", true);
		expect(bridge.registry.snapshot().sessions[0].state).toBe("revived");
	});

	it("maps idle to parked when the lifecycle manager parked the worker", () => {
		const { bridge } = makeBridge({ parked: true });
		bridge.register(KEY);
		bridge.updateState(KEY, "idle", "parked by lifecycle");
		expect(bridge.registry.snapshot().sessions[0].state).toBe("parked");
	});

	it("keeps idle when the worker is not parked", () => {
		const { bridge } = makeBridge();
		bridge.register(KEY);
		bridge.updateState(KEY, "idle", "settled");
		expect(bridge.registry.snapshot().sessions[0].state).toBe("idle");
	});

	it("routes follow-ups through runTurn with the prompt payload", async () => {
		const { bridge, calls } = makeBridge();
		bridge.register(KEY);
		await bridge.registry.followUp(KEY, "ref-1", "continue the task");
		expect(calls).toContain("runTurn");
		const result = bridge.registry.snapshot().sessions[0];
		expect(result.pendingFollowUps).toBe(0);
	});

	it("surfaces non-string follow-up payloads as failed results (not rejections)", async () => {
		const { bridge } = makeBridge();
		bridge.register(KEY);
		const results: Array<{ ok: boolean; error?: string }> = [];
		const unsubscribe = bridge.registry.subscribe(event => {
			if (event.type === "follow_up_result") results.push({ ok: event.ok, error: event.error });
		});
		await bridge.registry.followUp(KEY, "r", 42);
		unsubscribe();
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(false);
		expect(results[0].error).toMatch(/non-empty string prompt/);
	});

	it("binds a 0600 socket lazily on ensureStarted and restarts after stop", async () => {
		const { bridge, baseDir } = makeBridge();
		expect(bridge.started).toBe(false);
		await bridge.ensureStarted();
		expect(bridge.started).toBe(true);
		const socketStat = await fs.stat(bridge.server.socketFile);
		expect(socketStat.mode & 0o777).toBe(0o600);
		await bridge.stop();
		expect(bridge.started).toBe(false);
		await expect(fs.stat(bridge.server.socketFile)).rejects.toThrow();
		await bridge.ensureStarted(); // restarts after stop (parent rehydrate)
		expect(bridge.started).toBe(true);
		await bridge.stop();
		await fs.rm(baseDir, { recursive: true, force: true });
	});

	it("unregisters every worker on stop", async () => {
		const { bridge, baseDir } = makeBridge();
		bridge.register(KEY);
		await bridge.ensureStarted();
		expect(bridge.registry.size).toBe(1);
		await bridge.stop();
		expect(bridge.registry.size).toBe(0);
		await fs.rm(baseDir, { recursive: true, force: true });
	});

	it("activity() updates the summary without changing state", () => {
		const { bridge } = makeBridge();
		bridge.register(KEY, "boot");
		bridge.activity(KEY, "working on turn 3");
		const entry = bridge.registry.snapshot().sessions[0];
		expect(entry.summary).toBe("working on turn 3");
		expect(entry.state).toBe("starting");
	});

	it("maps arbitrary states through unchanged", () => {
		const { bridge } = makeBridge();
		bridge.register(KEY);
		for (const state of ["running", "finished", "error"] as AttachWorkerState[]) {
			bridge.updateState(KEY, state, state);
			expect(bridge.registry.snapshot().sessions[0].state).toBe(state);
		}
	});
});
