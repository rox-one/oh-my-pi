import { describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { type AttachLiveSessionSource, createAttachLiveSessionSource } from "../../src/attach/live-session";
import {
	ATTACH_CMD_ACK_CACHE_SIZE,
	type AttachEvent,
	AttachProtocolError,
	type AttachWorkerKey,
} from "../../src/attach/protocol";
import { AttachRegistry } from "../../src/attach/registry";

const KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-a" };
const OTHER_KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-b" };

/** Deterministic clock: 1000, 1010, 1020, ... */
function makeClock() {
	let tick = 0;
	return {
		now: () => 1000 + tick++ * 10,
	};
}

/** Minimal fake presentation source for a live worker session. */
function fakeSource(overrides: Partial<AttachLiveSessionSource> = {}): AttachLiveSessionSource {
	return {
		branchId: "b1",
		sessionFile: null,
		getCwd: () => "cwd",
		getBranchEntries: () => [],
		subscribe: () => () => {},
		...overrides,
	};
}

function makeRegistry() {
	const clock = makeClock();
	const registry = new AttachRegistry({
		runPrompt: async () => ({ ok: true, payload: "done" }),
		followUp: async () => ({ ok: true, payload: "done" }),
		now: clock.now,
	});
	return { registry, clock };
}

/** Collect events while the callback runs. */
function collectEvents(registry: AttachRegistry, run: () => void): AttachEvent[] {
	const events: AttachEvent[] = [];
	const unsubscribe = registry.subscribe(event => events.push(event));
	run();
	unsubscribe();
	return events;
}

describe("attach registry registration lifecycle", () => {
	it("registers a worker with starting state and emits registered", () => {
		const { registry } = makeRegistry();
		const source = fakeSource();
		const events = collectEvents(registry, () => registry.register(KEY, source, "boot"));
		expect(registry.size).toBe(1);
		expect(registry.has(KEY)).toBe(true);
		expect(registry.liveSession(KEY)).toBe(source);
		const entry = registry.snapshot().sessions[0];
		expect(entry.key).toEqual(KEY);
		expect(entry.state).toBe("starting");
		expect(entry.summary).toBe("boot");
		expect(entry.pendingFollowUps).toBe(0);
		expect(entry.attachedClients).toBe(0);
		expect(events.map(event => event.type)).toEqual(["registered"]);
	});

	it("rejects duplicate registration within one owner scope", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		expect(() => registry.register(KEY, null)).toThrowError(/already registered/);
	});

	it("unregisters with a reason and emits removed", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const events = collectEvents(registry, () => {
			expect(registry.unregister(KEY, "killed")).toBe(true);
		});
		expect(registry.size).toBe(0);
		expect(registry.has(KEY)).toBe(false);
		expect(events).toEqual([{ type: "removed", key: KEY, reason: "killed" }]);
	});

	it("reports false when unregistering an unknown worker", () => {
		const { registry } = makeRegistry();
		expect(registry.unregister(KEY, "gone")).toBe(false);
	});
});

describe("attach registry ownership scope isolation", () => {
	it("keeps the same workerId distinct across owner scopes", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null, "a");
		registry.register(OTHER_KEY, null, "b");
		expect(registry.size).toBe(2);
		const sessions = registry
			.snapshot()
			.sessions.map(entry => entry.summary)
			.sort();
		expect(sessions).toEqual(["a", "b"]);
		registry.unregister(KEY, "x");
		expect(registry.has(OTHER_KEY)).toBe(true);
	});
});

describe("attach registry state streaming", () => {
	it("emits state and updated events on updateState", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const events = collectEvents(registry, () => registry.updateState(KEY, "running", "turn 1"));
		expect(events.map(event => event.type)).toEqual(["state", "updated"]);
		const stateEvent = events[0] as Extract<AttachEvent, { type: "state" }>;
		expect(stateEvent.state).toBe("running");
		expect(stateEvent.at).toBeGreaterThanOrEqual(1000);
		const updated = events[1] as Extract<AttachEvent, { type: "updated" }>;
		expect(updated.entry.state).toBe("running");
		expect(updated.entry.summary).toBe("turn 1");
		expect(registry.snapshot().sessions[0].state).toBe("running");
	});

	it("ignores updateState for unknown workers", () => {
		const { registry } = makeRegistry();
		expect(() => registry.updateState(KEY, "idle")).not.toThrow();
	});

	it("setSummary updates without changing state", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.setSummary(KEY, "gist");
		expect(registry.snapshot().sessions[0].summary).toBe("gist");
		expect(registry.snapshot().sessions[0].state).toBe("starting");
	});

	it("touch updates lastActivityAt", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const before = registry.snapshot().sessions[0].lastActivityAt;
		registry.touch(KEY);
		const after = registry.snapshot().sessions[0].lastActivityAt;
		expect(before).toBeNull();
		expect(after).not.toBeNull();
	});
});

describe("attach registry subscriptions", () => {
	it("unsubscribe stops event delivery", () => {
		const { registry } = makeRegistry();
		const events: AttachEvent[] = [];
		const unsubscribe = registry.subscribe(event => events.push(event));
		registry.register(KEY, null);
		unsubscribe();
		registry.updateState(KEY, "idle");
		expect(events.map(event => event.type)).toEqual(["registered"]);
	});
});

describe("attach registry controller leases", () => {
	function leaseOf(
		result: ReturnType<AttachRegistry["acquireView"]>,
	): NonNullable<Extract<ReturnType<AttachRegistry["acquireView"]>, { ok: true }>["lease"]> {
		if (!result.ok) throw new Error(`expected lease, got ${result.code}`);
		return result.lease;
	}

	it("acquires a lease and rejects a second acquisition with lease_busy + holder", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const first = registry.acquireView(KEY, "client-1");
		expect(first.ok).toBe(true);
		const lease = leaseOf(first);
		expect(lease.leaseId.length).toBeGreaterThan(0);
		expect(lease.proof).toMatch(/^[0-9a-f]{64}$/);
		expect(lease.generation).toBe(1);
		expect(lease.graceMs).toBeGreaterThan(0);

		// Reject-not-replace: a second pane client without resume is refused.
		const second = registry.acquireView(KEY, "client-2");
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.code).toBe("lease_busy");
			expect(second.holder).toEqual({ generation: 1, expiresInMs: expect.any(Number) });
			expect(second.holder!.expiresInMs).toBeGreaterThan(0);
		}
		expect(registry.leaseInfo(KEY)).toEqual({ generation: 1, expiresInMs: expect.any(Number) });
	});

	it("resumes the same lease with correct id+proof+generation and bumps generation", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const first = registry.acquireView(KEY, "client-1");
		const lease = leaseOf(first);
		const resumed = registry.acquireView(KEY, "client-1", {
			leaseId: lease.leaseId,
			proof: lease.proof,
			generation: lease.generation,
		});
		expect(resumed.ok).toBe(true);
		if (resumed.ok) {
			expect(resumed.lease.leaseId).toBe(lease.leaseId);
			expect(resumed.lease.proof).toBe(lease.proof);
			expect(resumed.lease.generation).toBe(2);
			expect(resumed.lease.graceMs).toBe(lease.graceMs);
		}
	});

	it("rejects resume with a wrong proof and reports stale_resume when no lease exists", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const lease = leaseOf(registry.acquireView(KEY, "client-1"));
		const wrongProof = registry.acquireView(KEY, "client-1", {
			leaseId: lease.leaseId,
			proof: "c".repeat(64),
			generation: lease.generation,
		});
		expect(wrongProof.ok).toBe(false);
		if (!wrongProof.ok) expect(wrongProof.code).toBe("lease_busy");

		// With the lease gone (grace expired / detached), resuming is stale.
		expect(registry.releaseView(KEY, "client-1", lease.proof, "detach")).toBe(true);
		const stale = registry.acquireView(KEY, "client-2", {
			leaseId: "ghost",
			proof: "d".repeat(64),
			generation: 9,
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.code).toBe("stale_resume");
	});

	it("releaseView requires the holder's proof and frees the lease for the next client", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const lease = leaseOf(registry.acquireView(KEY, "client-1"));

		expect(registry.releaseView(KEY, "client-1", "e".repeat(64), "wrong proof")).toBe(false);
		expect(registry.leaseInfo(KEY)).toBeDefined(); // still held

		expect(registry.releaseView(KEY, "client-1", lease.proof, "detach")).toBe(true);
		expect(registry.leaseInfo(KEY)).toBeUndefined();
		const next = registry.acquireView(KEY, "client-2");
		expect(next.ok).toBe(true);
	});

	it("beginGrace keeps the lease until the grace window expires, then releases it", () => {
		vi.useFakeTimers();
		try {
			const clock = makeClock();
			const registry = new AttachRegistry({
				runPrompt: async () => ({ ok: true }),
				now: clock.now,
				leaseGraceMs: 50,
			});
			registry.register(KEY, null);
			const lease = leaseOf(registry.acquireView(KEY, "client-1"));

			expect(registry.beginGrace(KEY, "client-1")).toBe(true);
			// A foreign acquire is still rejected during the grace window.
			const busy = registry.acquireView(KEY, "client-2");
			expect(busy.ok).toBe(false);
			if (!busy.ok) {
				expect(busy.code).toBe("lease_busy");
				expect(busy.holder).toEqual({ generation: 1, expiresInMs: 50 });
			}

			const events: AttachEvent[] = [];
			const unsubscribe = registry.subscribe(event => events.push(event));
			vi.advanceTimersByTime(50);
			unsubscribe();

			expect(registry.leaseInfo(KEY)).toBeUndefined();
			expect(events.map(event => event.type)).toEqual(["lease_revoked"]);
			const revoked = events[0] as Extract<AttachEvent, { type: "lease_revoked" }>;
			expect(revoked.reason).toContain("grace expired");

			// The freed lease is available to a fresh pane client.
			const next = registry.acquireView(KEY, "client-2");
			expect(next.ok).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("beginGrace ignores foreign client ids", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.acquireView(KEY, "client-1");
		expect(registry.beginGrace(KEY, "client-2")).toBe(false);
	});

	it("unregister releases the lease and emits lease_revoked + removed", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.acquireView(KEY, "client-1");
		const events = collectEvents(registry, () => {
			expect(registry.unregister(KEY, "killed")).toBe(true);
		});
		expect(events.map(event => event.type)).toEqual(["lease_revoked", "removed"]);
		expect(registry.leaseInfo(KEY)).toBeUndefined();
		// The worker is gone entirely: acquiring now fails with unknown_worker.
		const acquired = registry.acquireView(KEY, "client-2");
		expect(acquired.ok).toBe(false);
		if (!acquired.ok) expect(acquired.code).toBe("unknown_worker");
	});
});

describe("attach registry command acknowledgement cache", () => {
	it("caches command outcomes per worker and returns them", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		expect(registry.cachedCommand(KEY, "cmd-1")).toBeUndefined();
		registry.rememberCommand(KEY, "cmd-1", { ok: true, payload: "ran" });
		expect(registry.cachedCommand(KEY, "cmd-1")).toEqual({ ok: true, payload: "ran" });
	});

	it("keeps worker caches isolated", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.register(OTHER_KEY, null);
		registry.rememberCommand(KEY, "cmd-1", { ok: true });
		expect(registry.cachedCommand(KEY, "cmd-1")).toBeDefined();
		expect(registry.cachedCommand(OTHER_KEY, "cmd-1")).toBeUndefined();
	});

	it(`evicts the oldest entry beyond ${ATTACH_CMD_ACK_CACHE_SIZE} commands`, () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		for (let i = 1; i <= ATTACH_CMD_ACK_CACHE_SIZE + 1; i += 1) {
			registry.rememberCommand(KEY, `cmd-${i}`, { ok: true, payload: i });
		}
		expect(registry.cachedCommand(KEY, "cmd-1")).toBeUndefined(); // oldest evicted
		expect(registry.cachedCommand(KEY, "cmd-2")).toEqual({ ok: true, payload: 2 });
		expect(registry.cachedCommand(KEY, `cmd-${ATTACH_CMD_ACK_CACHE_SIZE + 1}`)).toEqual({
			ok: true,
			payload: ATTACH_CMD_ACK_CACHE_SIZE + 1,
		});
	});

	it("drops the cache on unregister", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.rememberCommand(KEY, "cmd-1", { ok: true });
		registry.unregister(KEY, "gone");
		expect(registry.cachedCommand(KEY, "cmd-1")).toBeUndefined();
	});
});

describe("attach registry serialized prompts", () => {
	it("runs a prompt through the callback and emits updated on start and settle", async () => {
		const clock = makeClock();
		const seen: unknown[] = [];
		const registry = new AttachRegistry({
			now: clock.now,
			runPrompt: async (key, text, options) => {
				seen.push({ key, text, options });
				return { ok: true, payload: "out" };
			},
		});
		registry.register(KEY, null);
		const events: AttachEvent[] = [];
		const unsubscribe = registry.subscribe(event => events.push(event));
		const result = await registry.runPrompt(KEY, "hello", 5000);
		unsubscribe();
		expect(result).toEqual({ ok: true, payload: "out" });
		expect(seen).toEqual([{ key: KEY, text: "hello", options: { timeoutMs: 5000 } }]);
		// pendingFollowUps flips 0 → 1 → 0, emitting updated on both edges.
		expect(events.map(event => event.type)).toEqual(["updated", "updated"]);
		const entry = registry.snapshot().sessions[0];
		expect(entry.pendingFollowUps).toBe(0);
		expect(entry.lastActivityAt).not.toBeNull();
	});

	it("rejects a concurrent prompt for the same key with busy", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const registry = new AttachRegistry({
			runPrompt: async () => {
				await gate;
				return { ok: true };
			},
		});
		registry.register(KEY, null);
		const first = registry.runPrompt(KEY, "p1");
		await Promise.resolve(); // let the first prompt claim the slot
		await expect(registry.runPrompt(KEY, "p2")).rejects.toMatchObject({ code: "busy" });
		release();
		await first;
		// After settlement the slot is free again.
		await expect(registry.runPrompt(KEY, "p3")).resolves.toEqual({ ok: true });
	});

	it("rejects a prompt for an unknown worker with unknown_worker", async () => {
		const { registry } = makeRegistry();
		try {
			await registry.runPrompt(KEY, "p");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AttachProtocolError);
			expect((error as AttachProtocolError).code).toBe("unknown_worker");
		}
	});

	it("surfaces callback failures as failed results instead of throwing", async () => {
		const registry = new AttachRegistry({
			runPrompt: async () => {
				throw new Error("boom");
			},
		});
		registry.register(KEY, null);
		await expect(registry.runPrompt(KEY, "p")).resolves.toEqual({ ok: false, error: "boom" });
	});

	it("a stale claim settling after unregister/re-register cannot delete the new slot or contaminate the cache", async () => {
		const gates: Record<string, () => void> = {};
		const registry = new AttachRegistry({
			runPrompt: async (_key, text) => {
				await new Promise<void>(resolve => {
					gates[text] = resolve;
				});
				return { ok: true, payload: text };
			},
		});
		registry.register(KEY, null);

		// A claims cmd-A and runs DEFERRED.
		const claimA = registry.claimPrompt(KEY, "cmd-A", "a");
		if (claimA.status !== "started") throw new Error("expected A to start");

		// The worker is removed and re-registered while A's run is still in
		// flight: entry and active slot now belong to the NEW worker.
		registry.unregister(KEY, "restart");
		registry.register(KEY, null);
		const claimB = registry.claimPrompt(KEY, "cmd-B", "b");
		if (claimB.status !== "started") throw new Error("expected B to start");

		// A settles: the stale claim must leave B's slot and B's cache alone.
		gates["a"]();
		await expect(claimA.outcome).resolves.toEqual({ ok: true, payload: "a" });
		expect(registry.claimPrompt(KEY, "cmd-C", "c").status).toBe("busy");
		expect(registry.cachedCommand(KEY, "cmd-A")).toBeUndefined();

		// B settles normally afterwards and its own outcome IS cached.
		gates["b"]();
		await expect(claimB.outcome).resolves.toEqual({ ok: true, payload: "b" });
		expect(registry.cachedCommand(KEY, "cmd-B")).toEqual({ ok: true, payload: "b" });
	});
});

describe("attach registry serialized follow-up", () => {
	it("runs one follow-up and emits accepted then result with ref", async () => {
		const clock = makeClock();
		const seen: unknown[] = [];
		const registry = new AttachRegistry({
			now: clock.now,
			runPrompt: async () => ({ ok: true, payload: "via-prompt" }),
			followUp: async (key, payload) => {
				seen.push({ key, payload });
				return { ok: true, payload: "out" };
			},
		});
		registry.register(KEY, null);
		const events: AttachEvent[] = [];
		const unsubscribe = registry.subscribe(event => events.push(event));
		await registry.followUp(KEY, "ref-1", "prompt");
		unsubscribe();
		expect(seen).toEqual([{ key: KEY, payload: "prompt" }]);
		expect(events.map(event => event.type)).toEqual(["follow_up_accepted", "updated", "follow_up_result", "updated"]);
		const accepted = events[0] as Extract<AttachEvent, { type: "follow_up_accepted" }>;
		expect(accepted.ref).toBe("ref-1");
		const result = events[2] as Extract<AttachEvent, { type: "follow_up_result" }>;
		expect(result.ref).toBe("ref-1");
		expect(result.ok).toBe(true);
		expect(result.payload).toBe("out");
	});

	it("falls back to the prompt runner when no followUp callback is provided", async () => {
		const seen: string[] = [];
		const registry = new AttachRegistry({
			runPrompt: async (_key, text) => {
				seen.push(text);
				return { ok: true, payload: text };
			},
		});
		registry.register(KEY, null);
		await registry.followUp(KEY, "ref-1", "continue");
		expect(seen).toEqual(["continue"]);
	});

	it("rejects a concurrent follow-up for the same key with busy", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const registry = new AttachRegistry({
			runPrompt: async () => ({ ok: true }),
			followUp: async () => {
				await gate;
				return { ok: true };
			},
		});
		registry.register(KEY, null);
		const first = registry.followUp(KEY, "r1", "p1");
		await Promise.resolve(); // let the first follow-up claim the slot
		await expect(registry.followUp(KEY, "r2", "p2")).rejects.toMatchObject({ code: "busy" });
		release();
		await first;
		// After settlement the slot is free again.
		await expect(registry.followUp(KEY, "r3", "p3")).resolves.toBeUndefined();
	});

	it("rejects follow-up for an unknown worker with unknown_worker", async () => {
		const { registry } = makeRegistry();
		await expect(registry.followUp(KEY, "r", "p")).rejects.toMatchObject({ code: "unknown_worker" });
	});

	it("surfaces callback failures as failed results instead of throwing", async () => {
		const registry = new AttachRegistry({
			runPrompt: async () => ({ ok: true }),
			followUp: async () => {
				throw new Error("boom");
			},
		});
		registry.register(KEY, null);
		const events: AttachEvent[] = [];
		const unsubscribe = registry.subscribe(event => events.push(event));
		await expect(registry.followUp(KEY, "r", "p")).resolves.toBeUndefined();
		unsubscribe();
		const result = events.find(event => event.type === "follow_up_result") as
			| Extract<AttachEvent, { type: "follow_up_result" }>
			| undefined;
		expect(result?.ok).toBe(false);
		expect(result?.error).toBe("boom");
	});
});

describe("attach registry abort (never kills)", () => {
	it("returns false when no prompt is in flight", async () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		await expect(registry.abort(KEY, "user")).resolves.toBe(false);
		expect(registry.has(KEY)).toBe(true); // abort never unregisters
	});

	it("invokes the runtime abort callback during a director-owned initial spawn", async () => {
		const aborted: { key: AttachWorkerKey; reason?: string }[] = [];
		const registry = new AttachRegistry({
			runPrompt: async () => ({ ok: true }),
			abort: async (key, reason) => {
				aborted.push({ key, reason });
				return true;
			},
		});
		registry.register(KEY, null);

		await expect(registry.abort(KEY, "user-cancel")).resolves.toBe(true);
		expect(aborted).toEqual([{ key: KEY, reason: "user-cancel" }]);
		expect(registry.snapshot().sessions[0].pendingFollowUps).toBe(0);
		expect(registry.has(KEY)).toBe(true);
	});

	it("logs a rejected runtime abort callback without rejecting the protocol abort", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const registry = new AttachRegistry({
				runPrompt: async () => ({ ok: true }),
				abort: async () => {
					throw new Error("abort failed");
				},
			});
			registry.register(KEY, null);

			await expect(registry.abort(KEY, "user-cancel")).resolves.toBe(false);
			expect(warn).toHaveBeenCalledWith("attach: runtime abort callback failed", {
				workerId: "w1",
				error: "abort failed",
			});
			expect(registry.has(KEY)).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("cancels an in-flight prompt via the abort callback and returns true", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const aborted: { key: AttachWorkerKey; reason?: string }[] = [];
		const registry = new AttachRegistry({
			runPrompt: async () => {
				await gate;
				return { ok: true };
			},
			abort: async (key, reason) => {
				aborted.push({ key, reason });
				return true;
			},
		});
		registry.register(KEY, null);
		const first = registry.runPrompt(KEY, "p");
		await Promise.resolve();
		await expect(registry.abort(KEY, "user-cancel")).resolves.toBe(true);
		expect(aborted).toEqual([{ key: KEY, reason: "user-cancel" }]);
		expect(registry.has(KEY)).toBe(true); // never killed
		release();
		await first;
	});

	it("emits abort_accepted even when no callback is wired", async () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const events = collectEvents(registry, () => {
			void registry.abort(KEY, "user");
		});
		// The emit is synchronous when no abort callback awaits.
		expect(events.map(event => event.type)).toEqual(["abort_accepted"]);
	});
});

describe("attach registry attached-client accounting", () => {
	it("counts attached clients in the wire entry and detach never unregisters", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.attach(KEY, "client-1");
		registry.attach(KEY, "client-2");
		expect(registry.snapshot().sessions[0].attachedClients).toBe(2);
		registry.detach(KEY, "client-1");
		expect(registry.snapshot().sessions[0].attachedClients).toBe(1);
		registry.detach(KEY, "client-2");
		expect(registry.snapshot().sessions[0].attachedClients).toBe(0);
		expect(registry.has(KEY)).toBe(true);
	});

	it("emits updated wire entries only when attachedClients membership changes", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		const events = collectEvents(registry, () => {
			registry.attach(KEY, "client-1");
			registry.attach(KEY, "client-1"); // duplicate: no emit
			registry.attach(KEY, "client-2");
			registry.detach(KEY, "ghost"); // absent: no emit
			registry.detach(KEY, "client-1");
			registry.detach(KEY, "client-2");
		});
		const updated = events.filter(event => event.type === "updated");
		expect(updated).toHaveLength(4);
		expect(
			updated.map(event => {
				if (event.type !== "updated") throw new Error("expected updated");
				return event.entry.attachedClients;
			}),
		).toEqual([1, 2, 1, 0]);
		expect(updated.every(event => event.type === "updated" && event.key.workerId === KEY.workerId)).toBe(true);
	});

	it("ignores attach/detach for unknown workers", () => {
		const { registry } = makeRegistry();
		expect(() => registry.attach(KEY, "c")).not.toThrow();
		expect(() => registry.detach(KEY, "c")).not.toThrow();
	});

	it("clears attachments on unregister", () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		registry.attach(KEY, "c");
		registry.unregister(KEY, "kill");
		expect(registry.size).toBe(0);
	});
});

describe("attach live session source adapter", () => {
	it("createAttachLiveSessionSource is typed against the presentation surface", () => {
		// The adapter factory exists and produces the minimum source shape;
		// the live wiring is exercised by the vibe bridge tests. This guards
		// the exported signature (branchId/sessionFile/getCwd/getBranchEntries/
		// subscribe) so a src change surfaces here first.
		expect(typeof createAttachLiveSessionSource).toBe("function");
		expect(typeof fakeSource().subscribe).toBe("function");
		expect(fakeSource().getCwd()).toBe("cwd");
	});
});
