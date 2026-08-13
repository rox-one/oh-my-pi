import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { finalizeSubagentLifecycle, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a vibe worker's spawn run carries the attach-scoped
 * `revivableAbort` flag (set only by `vibe/runtime.ts #buildSpawnOptions` for
 * the pane Ctrl-C abort path). When that flagged run is aborted by a caller
 * signal, the lifecycle must PARK the worker like a budget abort — the
 * session survives registered/idle — instead of tombstoning it. An ordinary
 * keepAlive task child (no flag) must STILL be tombstoned on a caller-signal
 * abort: the flag is the ONLY thing that makes a signal abort resumable.
 */
const WORKER_ID = "vibe-flag-worker";

function mockSession(): AgentSession & { disposeCalls(): number } {
	let disposeCount = 0;
	const session = {
		dispose: async () => {
			disposeCount += 1;
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
	return Object.assign(session, { disposeCalls: () => disposeCount });
}

function registerRef(session: AgentSession): void {
	AgentRegistry.global().register({
		id: WORKER_ID,
		displayName: WORKER_ID,
		kind: "sub",
		parentId: "parent",
		session,
		status: "running",
	});
}

function finalizeArgs(session: AgentSession, overrides: Partial<Parameters<typeof finalizeSubagentLifecycle>[0]>) {
	return {
		id: WORKER_ID,
		session,
		aborted: true,
		abortKind: "signal" as const,
		keepAlive: true,
		isolated: false,
		agentIdleTtlMs: 0,
		reviveSession: async () => session,
		...overrides,
	};
}

describe("finalizeSubagentLifecycle attach-scoped resumable abort", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("parks a signal abort marked revivable (vibe spawn pane Ctrl-C): worker survives idle", async () => {
		const session = mockSession();
		registerRef(session);
		await finalizeSubagentLifecycle(finalizeArgs(session, { revivableAbort: true, abortKind: "signal" }));
		const ref = AgentRegistry.global().get(WORKER_ID);
		expect(ref).toBeDefined();
		expect(ref?.status).toBe("idle");
		// The adopted session stays live; it must not be disposed or tombstoned.
		expect(session.disposeCalls()).toBe(0);
	});

	it("tombstones the same signal abort WITHOUT the flag (ordinary keepAlive task child)", async () => {
		const session = mockSession();
		registerRef(session);
		await finalizeSubagentLifecycle(finalizeArgs(session, { abortKind: "signal" }));
		const ref = AgentRegistry.global().get(WORKER_ID);
		// Genuine kill: the ref is kept as a terminal "aborted" row and the
		// session is disposed — a parent-cancelled task must not be parked.
		expect(ref?.status).toBe("aborted");
		expect(session.disposeCalls()).toBe(1);
	});

	it("parks only the explicit attach flag — a budget abort keeps working as before", async () => {
		const session = mockSession();
		registerRef(session);
		await finalizeSubagentLifecycle(finalizeArgs(session, { abortKind: "budget" }));
		const ref = AgentRegistry.global().get(WORKER_ID);
		expect(ref).toBeDefined();
		expect(ref?.status).toBe("idle");
		expect(session.disposeCalls()).toBe(0);
	});

	it("leaves a non-aborted keepAlive run idle (baseline unchanged)", async () => {
		const session = mockSession();
		registerRef(session);
		await finalizeSubagentLifecycle(finalizeArgs(session, { aborted: false }));
		const ref = AgentRegistry.global().get(WORKER_ID);
		expect(ref).toBeDefined();
		expect(ref?.status).toBe("idle");
		expect(session.disposeCalls()).toBe(0);
	});
});

describe("runSubprocess pre-start revivable abort", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-pre-start-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	const baseAgent: AgentDefinition = {
		name: "scout",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	function preStartOptions(id: string, signal: AbortSignal, revivableAbort?: () => boolean) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({}),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			signal,
			...(revivableAbort !== undefined && { revivableAbort }),
		};
	}

	it("skips Cancelled-before-start for a revivable spawn: the session materializes and is parked idle", async () => {
		const id = "PreStartVibe";
		// Minimal adopted session: the pre-aborted drive phase never prompts.
		const session = {
			subscribe: () => () => {},
			setIrcWakeTurnObserver: () => {},
			dispose: async () => {},
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			// The real createAgentSession registers the subagent ref; mirror it
			// so the lifecycle finalizer can park the materialized session.
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: "parent",
				session,
				sessionFile: null,
				status: "running",
			});
			return {
				session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const result = await runSubprocess(
			preStartOptions(id, AbortSignal.abort(new Error("The operation was aborted.")), () => true),
		);

		// The launch was NOT short-circuited: the session materialized and the
		// normal lifecycle parked it as an idle revivable worker.
		expect(result.error).not.toBe("Cancelled before start");
		expect(result.aborted).toBe(true);
		const ref = AgentRegistry.global().get(id);
		expect(ref).toBeDefined();
		expect(ref?.status).toBe("idle");
	});

	it("keeps Cancelled-before-start for an ordinary pre-aborted task spawn (no flag, no session)", async () => {
		const id = "PreStartTask";
		const result = await runSubprocess(preStartOptions(id, AbortSignal.abort(new Error("Cancelled by caller"))));
		expect(result.error).toBe("Cancelled before start");
		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)).toBeUndefined();
	});
});
