/**
 * Headless session-mode controller for RPC hosts.
 *
 * plan/vibe/goal activation lives in the TUI's `InteractiveModeContext`
 * (`handlePlanModeCommand` & friends), which RPC hosts cannot reach. This
 * module mirrors those session-level effects — mode state, toolset changes,
 * the plan-proposal handler, persisted `mode_change` entries, and mutual
 * exclusion — using only public `AgentSession` APIs, so `set_mode` behaves
 * like the TUI's `/plan` / `/vibe` / `/goal` commands.
 *
 * Session-switch support mirrors `InteractiveMode.#reconcileModeFromSession`:
 * `suspendSessionMode` drops live mode state before a switch (without writing
 * to the target file's mode chain) and `reconcileSessionMode` restores the
 * persisted mode from the target file's `mode_change` chain afterwards.
 *
 * Model-role switching on plan entry is deliberately omitted, matching ACP's
 * `session/set_mode`: the RPC client already addresses the model via
 * `set_model`, and a server-side switch would fight the client's selection.
 */
import { formatModelString } from "../../config/model-resolver";
import type { Goal } from "../../goals/state";
import type { AgentSession } from "../../session/agent-session";
import { type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";
import type { RpcSessionMode, RpcSetModeTarget } from "./rpc-types";

/**
 * Pre-enter toolset per session, so exiting a mode restores exactly what was
 * active before it (plan augments with `write`, vibe replaces with read-only,
 * goal adds the `goal` tool).
 */
const previousToolsByMode = new WeakMap<AgentSession, { plan?: string[]; vibe?: string[]; goal?: string[] }>();

function assertNoOtherMode(session: AgentSession, target: RpcSetModeTarget): void {
	if (target !== "plan" && session.getPlanModeState()?.enabled) {
		throw new Error("Exit plan mode first.");
	}
	if (target !== "vibe" && session.getVibeModeState()?.enabled) {
		throw new Error("Exit vibe mode first.");
	}
	const goal = session.getGoalModeState();
	if (target !== "goal" && (goal?.enabled || goal?.goal.status === "paused")) {
		throw new Error("Exit goal mode first.");
	}
}

/** Live session mode, mirroring the mode semantics of `buildSessionContext`. */
export function getSessionMode(session: AgentSession): RpcSessionMode {
	if (session.getPlanModeState()?.enabled) return "plan";
	if (session.getVibeModeState()?.enabled) return "vibe";
	const goal = session.getGoalModeState();
	if (goal?.enabled) return "goal";
	if (goal?.goal.status === "paused") return "goal_paused";
	return "none";
}

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------

export async function enterPlanMode(
	session: AgentSession,
	options?: { planFilePath?: string; persist?: boolean },
): Promise<void> {
	// Idempotent: re-entering plan mode must not re-capture the write-augmented
	// toolset into `previousToolsByMode` (a later exit would then leave `write`
	// active). Mirrors InteractiveMode.#enterPlanMode.
	if (session.getPlanModeState()?.enabled) return;
	assertNoOtherMode(session, "plan");
	if (!session.settings.get("plan.enabled")) {
		throw new Error("Plan mode is disabled. Enable it in settings (plan.enabled).");
	}
	const planFilePath = options?.planFilePath ?? (session.getPlanReferencePath() || "local://PLAN.md");
	const previousTools = session.getEnabledToolNames();
	// Plan approval is a `write` to `xd://propose`; keep `write` in the active
	// toolset so the agent can draft and submit the plan (mirrors
	// InteractiveMode.#enterPlanMode and print-mode).
	const planTools = session.hasBuiltInTool("write") ? [...new Set([...previousTools, "write"])] : previousTools;
	await session.setActiveToolsByName(planTools);
	previousToolsByMode.set(session, { ...previousToolsByMode.get(session), plan: previousTools });
	const previous = session.getPlanModeState();
	session.setPlanModeState({
		enabled: true,
		planFilePath: previous?.planFilePath ?? planFilePath,
		workflow: previous?.workflow ?? "parallel",
		reentry: previous !== undefined,
	});
	session.setPlanProposalHandler(async title => {
		const result = await session.preparePlanForReview(title);
		const details = result.details;
		if (details) {
			const state = session.getPlanModeState();
			if (state?.enabled) {
				session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
			}
			session.sessionManager.appendModeChange("plan", { planFilePath: details.planFilePath });
		}
		return result;
	});
	if (session.isStreaming) {
		await session.sendPlanModeContext({ deliverAs: "steer" });
	}
	if (options?.persist !== false) {
		session.sessionManager.appendModeChange("plan", { planFilePath });
	}
}

export async function exitPlanMode(session: AgentSession, options?: { persist?: boolean }): Promise<void> {
	if (!session.getPlanModeState()?.enabled) return;
	const previous = previousToolsByMode.get(session)?.plan;
	if (previous !== undefined) {
		await session.setActiveToolsByName(previous);
	}
	session.setPlanModeState(undefined);
	session.setPlanProposalHandler(null);
	if (options?.persist !== false) {
		session.sessionManager.appendModeChange("none");
	}
	const rest = previousToolsByMode.get(session);
	if (rest) {
		delete rest.plan;
	}
}

// ---------------------------------------------------------------------------
// Vibe mode
// ---------------------------------------------------------------------------

function vibeParentSession(session: AgentSession): VibeParentSession {
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => session.sessionManager.getSessionId(),
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		sessionManager: session.sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		// Resolve workers against this session's active model (same as the
		// spawn-path ToolSession), not the settings default.
		getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
	};
}

export async function enterVibeMode(session: AgentSession, options?: { persist?: boolean }): Promise<void> {
	// Idempotent: re-entering must not re-capture the read-only toolset (see enterPlanMode).
	if (session.getVibeModeState()?.enabled) return;
	assertNoOtherMode(session, "vibe");
	const vibeRegistry = VibeSessionRegistry.global();
	const parent = vibeParentSession(session);
	vibeRegistry.activateScope(vibeRegistry.ownerScope(parent));
	const previousTools = session.getEnabledToolNames();
	const vibeBaseTools = ["read"];
	if (session.hasBuiltInTool("todo")) vibeBaseTools.push("todo");
	await session.activateVibeTools(vibeBaseTools);
	previousToolsByMode.set(session, { ...previousToolsByMode.get(session), vibe: previousTools });
	session.setVibeModeState({ enabled: true });
	if (session.isStreaming) {
		await session.sendVibeModeContext({ deliverAs: "steer" });
	}
	if (options?.persist !== false) {
		session.sessionManager.appendModeChange("vibe");
	}
}

export async function exitVibeMode(session: AgentSession, options?: { persist?: boolean }): Promise<void> {
	if (!session.getVibeModeState()?.enabled) return;
	const parent = vibeParentSession(session);
	const registry = VibeSessionRegistry.global();
	await registry.killAll(parent, registry.ownerScope(parent));
	await session.deactivateVibeTools(previousToolsByMode.get(session)?.vibe ?? ["read"]);
	session.setVibeModeState(undefined);
	if (options?.persist !== false) {
		// Persist the exit: unlike the TUI (which relies on the worker-tombstone
		// path), an explicit headless exit should leave a mode chain that says
		// "none" so a later switch/restart doesn't resurrect vibe mode.
		session.sessionManager.appendModeChange("none");
	}
	const rest = previousToolsByMode.get(session);
	if (rest) {
		delete rest.vibe;
	}
}

// ---------------------------------------------------------------------------
// Goal mode
// ---------------------------------------------------------------------------

export async function enterGoalMode(
	session: AgentSession,
	objective: string,
	_options?: { persist?: boolean },
): Promise<void> {
	// Idempotent: re-entering must not re-capture the goal-augmented toolset
	// (see enterPlanMode). Mirrors InteractiveMode.#enterGoalMode.
	if (session.getGoalModeState()?.enabled) return;
	assertNoOtherMode(session, "goal");
	if (!session.settings.get("goal.enabled")) {
		throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
	}
	const trimmed = objective.trim();
	if (!trimmed) {
		throw new Error("Goal mode requires an objective (pass `objective` to set_mode).");
	}
	const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
	// sdk.ts excludes "goal" from the initial active tool set unconditionally;
	// re-add it so the agent can call resume, complete, or drop on this goal.
	await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	const state = await session.goalRuntime.createGoal({ objective: trimmed });
	session.setGoalModeState(state);
	previousToolsByMode.set(session, { ...previousToolsByMode.get(session), goal: previousTools });
	// mode_change persistence is handled by the goal runtime's persist callback.
}

export async function exitGoalMode(session: AgentSession, _options?: { persist?: boolean }): Promise<void> {
	const goal = session.getGoalModeState();
	if (!goal?.enabled && goal?.goal.status !== "paused") return;
	const previous = previousToolsByMode.get(session)?.goal;
	if (previous !== undefined) {
		await session.setActiveToolsByName(previous);
	}
	await session.goalRuntime.dropGoal();
	session.setGoalModeState(undefined);
	const rest = previousToolsByMode.get(session);
	if (rest) {
		delete rest.goal;
	}
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Apply a mode change; returns the resulting live session mode. */
export async function setSessionMode(
	session: AgentSession,
	mode: RpcSetModeTarget,
	objective?: string,
): Promise<RpcSessionMode> {
	switch (mode) {
		case "none":
			await resetSessionMode(session);
			break;
		case "plan":
			await enterPlanMode(session);
			break;
		case "vibe":
			await enterVibeMode(session);
			break;
		case "goal":
			await enterGoalMode(session, objective ?? "");
			break;
	}
	return getSessionMode(session);
}

/** Exit whichever special mode is currently active (plan / vibe / goal). */
export async function resetSessionMode(session: AgentSession): Promise<void> {
	if (session.getPlanModeState()?.enabled) {
		await exitPlanMode(session);
	} else if (session.getVibeModeState()?.enabled) {
		await exitVibeMode(session);
	} else if (session.getGoalModeState()?.enabled || session.getGoalModeState()?.goal.status === "paused") {
		await exitGoalMode(session);
	}
}

// ---------------------------------------------------------------------------
// Session-switch hooks (mirror InteractiveMode.#clearTransientModeState /
// #reconcileModeFromSession)
// ---------------------------------------------------------------------------

/**
 * Drop live mode state before the session switches to another file, without
 * persisting anything (the target file's mode chain is untouched). Vibe
 * workers are suspended under their parent scope, not killed, so switching
 * back to the session can resume them.
 */
export async function suspendSessionMode(session: AgentSession): Promise<void> {
	if (session.getPlanModeState()?.enabled) {
		const previous = previousToolsByMode.get(session)?.plan;
		if (previous !== undefined) {
			await session.setActiveToolsByName(previous);
		}
		session.setPlanModeState(undefined);
		session.setPlanProposalHandler(null);
	}
	const goal = session.getGoalModeState();
	if (goal?.enabled || goal?.goal.status === "paused") {
		const previous = previousToolsByMode.get(session)?.goal;
		if (previous !== undefined) {
			await session.setActiveToolsByName(previous);
		}
		session.setGoalModeState(undefined);
	}
	if (session.getVibeModeState()?.enabled) {
		const parent = vibeParentSession(session);
		const registry = VibeSessionRegistry.global();
		await registry.suspendScope(registry.ownerScope(parent));
		await session.deactivateVibeTools(previousToolsByMode.get(session)?.vibe ?? ["read"]);
		session.setVibeModeState(undefined);
	}
	previousToolsByMode.delete(session);
}

/**
 * Restore the persisted mode after switching to a session file whose
 * `mode_change` chain names a special mode. Mirrors
 * `InteractiveMode.#reconcileModeFromSession` minus the TUI-only state.
 */
export async function reconcileSessionMode(session: AgentSession): Promise<void> {
	const context = session.sessionManager.buildSessionContext();
	const mode = context.mode;
	if (mode === "plan" || mode === "plan_paused") {
		if (!session.settings.get("plan.enabled")) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			session.sessionManager.appendModeChange("none");
			return;
		}
		if (mode === "plan") {
			const planFilePath = context.modeData?.planFilePath as string | undefined;
			await enterPlanMode(session, { planFilePath, persist: false });
		}
		// plan_paused is an interactive intermediate; headless restore stays in
		// build mode (the plan file and model remain as persisted).
		return;
	}
	if (mode === "vibe") {
		// Rehydrate suspended workers scoped to this parent before re-entering,
		// mirroring InteractiveMode.#reconcileModeFromSession.
		await VibeSessionRegistry.global().rehydrate(vibeParentSession(session));
		await enterVibeMode(session, { persist: false });
		return;
	}
	if (mode === "goal" || mode === "goal_paused") {
		if (!session.settings.get("goal.enabled")) {
			session.goalRuntime.clearAccounting();
			session.sessionManager.appendModeChange("none");
			return;
		}
		const goal = (context.modeData as { goal?: Goal } | undefined)?.goal;
		if (!goal) {
			session.sessionManager.appendModeChange("none");
			return;
		}
		session.setGoalModeState({ enabled: mode === "goal", mode: "active", goal });
		// Preserve an active goal across in-process switches (the TUI's switch
		// reconciler passes preserveActiveGoal: true too); without it an active
		// goal is converted to goal_paused and persisted as such.
		const restored = await session.goalRuntime.onThreadResumed({ preserveActiveGoal: true });
		if (restored?.goal) {
			const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
			await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			previousToolsByMode.set(session, { ...previousToolsByMode.get(session), goal: previousTools });
		}
		return;
	}
}
