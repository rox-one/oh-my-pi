import { AgentRegistry } from "../registry/agent-registry";
import type { ObservableSession } from "./session-observer-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
}

/**
 * Sum the cost of every subagent in the registry. Live observer progress wins
 * over persisted history so a live agent is never double-counted; nested
 * subagents carry their own refs and own-session progress cost, so there is no
 * parent/child double count either.
 */
export function sumSubagentCost(registry: AgentRegistry, observed: readonly ObservableSession[]): number {
	const observedById = new Map(observed.map(session => [session.id, session]));
	let total = 0;
	for (const ref of registry.list()) {
		if (ref.kind !== "sub") continue;
		const live = observedById.get(ref.id)?.progress?.cost;
		if (typeof live === "number" && Number.isFinite(live)) {
			total += live;
			continue;
		}
		const persisted = ref.history?.metrics?.cost;
		if (typeof persisted === "number" && Number.isFinite(persisted)) {
			total += persisted;
		}
	}
	return total;
}
