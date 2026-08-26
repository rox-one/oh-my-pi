import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachLiveSessionSource } from "../../src/attach/live-session";
import type { AttachEvent, AttachWorkerKey, AttachWorkerState } from "../../src/attach/protocol";
import { ATTACH_RUNTIME_DIR_NAME, AttachVibeBridge } from "../../src/attach/vibe-bridge";

const KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-a" };

/** Fake presentation source matching the typed AttachLiveSessionSource surface. */
function fakeSource(workerId: string): AttachLiveSessionSource {
	return {
		branchId: "b1",
		sessionFile: null,
		getCwd: () => "cwd",
		getBranchEntries: () => [],
		subscribe: () => () => {},
	};
}

function makeBridge(overrides: { parked?: boolean; progressCoalesceMs?: number } = {}) {
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
		liveSessionOf: key => fakeSource(key.workerId),
		isParked: () => overrides.parked === true,
		progressCoalesceMs: overrides.progressCoalesceMs,
	});
	return { bridge, baseDir, calls };
}

describe("attach vibe bridge", () => {
	it("registers workers with the live session source and revives as revived state", () => {
		const { bridge } = makeBridge();
		bridge.register(KEY, "spawned");
		expect(bridge.registry.size).toBe(1);
		const source = bridge.registry.liveSession(KEY);
		expect(source?.branchId).toBe("b1");
		expect(source?.sessionFile).toBeNull();
		expect(source?.getCwd()).toBe("cwd");
		expect(source?.getBranchEntries()).toEqual([]);
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

	it("routes pane prompts through runTurn and surfaces failures as failed results", async () => {
		const { bridge, calls } = makeBridge();
		bridge.register(KEY);
		const outcome = await bridge.registry.runPrompt(KEY, "continue");
		expect(calls).toContain("runTurn");
		expect(outcome).toEqual({ ok: true, payload: "out" });

		const failing = new AttachVibeBridge({
			ownerScope: "scope-a",
			baseDir: path.join(os.tmpdir(), `omp-attach-bridge-${Math.random().toString(36).slice(2)}`),
			runTurn: async () => {
				throw new Error("worker died");
			},
			abortTurn: async () => true,
			liveSessionOf: () => fakeSource("w1"),
			isParked: () => false,
		});
		failing.register(KEY);
		await expect(failing.registry.runPrompt(KEY, "x")).resolves.toEqual({ ok: false, error: "worker died" });
	});

	it("stringifies non-string follow-up payloads before routing through runTurn", async () => {
		const seen: string[] = [];
		const baseDir = path.join(os.tmpdir(), `omp-attach-bridge-${Math.random().toString(36).slice(2)}`);
		const bridge = new AttachVibeBridge({
			ownerScope: "scope-a",
			baseDir,
			runTurn: async (_key, prompt) => {
				seen.push(prompt);
				return { ok: true };
			},
			abortTurn: async () => true,
			liveSessionOf: () => fakeSource("w1"),
			isParked: () => false,
		});
		bridge.register(KEY);
		await bridge.registry.followUp(KEY, "r", 42);
		await bridge.registry.followUp(KEY, "r2", { a: 1 });
		expect(seen).toEqual(["42", '{"a":1}']);
	});

	it("coalesces progress per worker and flushes the freshest state", async () => {
		const { bridge } = makeBridge({ progressCoalesceMs: 10_000 });
		bridge.register(KEY);
		const events: AttachEvent[] = [];
		const unsubscribe = bridge.registry.subscribe(event => events.push(event));

		bridge.progress(KEY, { currentTool: "bash", outputTail: [] });
		bridge.progress(KEY, { currentTool: "bash", currentToolArgs: "ls -la", outputTail: ["out"] });
		// The window has not elapsed: nothing emitted yet.
		expect(events.filter(event => event.type === "progress")).toHaveLength(0);

		bridge.flushProgress(KEY);
		unsubscribe();
		const progress = events.filter(event => event.type === "progress") as Extract<
			AttachEvent,
			{ type: "progress" }
		>[];
		expect(progress).toHaveLength(1);
		expect(progress[0]!.currentTool).toBe("bash");
		expect(progress[0]!.currentToolArgs).toBe("ls -la");
		expect(progress[0]!.outputTail).toEqual(["out"]);
	});

	it("emits progress once the coalescing window elapses", async () => {
		const { bridge } = makeBridge({ progressCoalesceMs: 30 });
		bridge.register(KEY);
		const events: AttachEvent[] = [];
		const unsubscribe = bridge.registry.subscribe(event => events.push(event));
		bridge.progress(KEY, { currentTool: "bash", outputTail: [] });
		await new Promise(resolve => setTimeout(resolve, 80));
		unsubscribe();
		expect(events.filter(event => event.type === "progress")).toHaveLength(1);
	});

	it("drops pending progress on unregister", async () => {
		const { bridge } = makeBridge({ progressCoalesceMs: 10_000 });
		bridge.register(KEY);
		const events: AttachEvent[] = [];
		const unsubscribe = bridge.registry.subscribe(event => events.push(event));
		bridge.progress(KEY, { currentTool: "bash", outputTail: [] });
		bridge.unregister(KEY, "killed");
		unsubscribe();
		expect(events.some(event => event.type === "progress")).toBe(false);
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

	it("exposes the endpoint paths only after the server started", async () => {
		const { bridge, baseDir } = makeBridge();
		expect(bridge.endpoint()).toBeNull(); // paths only, never capability contents

		await bridge.ensureStarted();
		const endpoint = bridge.endpoint();
		expect(endpoint).toEqual({
			socketFile: bridge.server.socketFile,
			tokenFile: bridge.server.tokenFile,
		});
		expect(endpoint!.socketFile).toContain(ATTACH_RUNTIME_DIR_NAME);

		await bridge.stop();
		expect(bridge.endpoint()).toBeNull();
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
