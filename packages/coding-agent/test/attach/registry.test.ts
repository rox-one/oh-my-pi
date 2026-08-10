import { describe, expect, it } from "bun:test";
import { type AttachEvent, AttachProtocolError, type AttachWorkerKey } from "../../src/attach/protocol";
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

function makeRegistry() {
	const clock = makeClock();
	const registry = new AttachRegistry({
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
		const events = collectEvents(registry, () => registry.register(KEY, { live: true }, "boot"));
		expect(registry.size).toBe(1);
		expect(registry.has(KEY)).toBe(true);
		expect(registry.liveSession(KEY)).toEqual({ live: true });
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

describe("attach registry serialized follow-up", () => {
	it("runs one follow-up and emits accepted then result with ref", async () => {
		const clock = makeClock();
		const seen: unknown[] = [];
		const registry = new AttachRegistry({
			now: clock.now,
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

	it("rejects a concurrent follow-up for the same key with busy", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const registry = new AttachRegistry({
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

	it("throws AttachProtocolError with code for protocol-level rejections", async () => {
		const { registry } = makeRegistry();
		try {
			await registry.followUp(KEY, "r", "p");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AttachProtocolError);
			expect((error as AttachProtocolError).code).toBe("unknown_worker");
		}
	});
});

describe("attach registry abort (never kills)", () => {
	it("returns false when no follow-up is in flight", async () => {
		const { registry } = makeRegistry();
		registry.register(KEY, null);
		await expect(registry.abort(KEY, "user")).resolves.toBe(false);
		expect(registry.has(KEY)).toBe(true); // abort never unregisters
	});

	it("cancels an in-flight follow-up via the abort callback and returns true", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const aborted: { key: AttachWorkerKey; reason?: string }[] = [];
		const registry = new AttachRegistry({
			followUp: async () => {
				await gate;
				return { ok: true };
			},
			abort: async (key, reason) => {
				aborted.push({ key, reason });
				return true;
			},
		});
		registry.register(KEY, null);
		const first = registry.followUp(KEY, "r", "p");
		await Promise.resolve();
		await expect(registry.abort(KEY, "user-cancel")).resolves.toBe(true);
		expect(aborted).toEqual([{ key: KEY, reason: "user-cancel" }]);
		expect(registry.has(KEY)).toBe(true); // never killed
		release();
		await first;
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
