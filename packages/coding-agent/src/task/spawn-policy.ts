import { canSpawnAtDepth } from "./types";

/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}
/** Whether one agent is enabled and permitted by the session spawn policy. */
export function isAgentAllowedBySpawnPolicy(
	agent: string,
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (disabledAgents?.includes(agent)) return false;
	const policy = resolveSpawnPolicy(spawns);
	return policy.enabled && (policy.allowedAgents === null || policy.allowedAgents.includes(agent));
}

/** Whether the session may spawn any subagent under both policy and depth limits. */
export function canSpawnSubagents(
	spawns: string | boolean | null | undefined,
	maxRecursionDepth: number,
	taskDepth: number,
): boolean {
	return canSpawnAtDepth(maxRecursionDepth, taskDepth) && resolveSpawnPolicy(spawns).enabled;
}

/**
 * Whether the `scout` agent is spawnable in a session: not disabled, permitted
 * by the session spawn policy, and within the recursion-depth limit.
 */
export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
	maxRecursionDepth: number,
	taskDepth: number,
): boolean {
	return (
		canSpawnSubagents(spawns, maxRecursionDepth, taskDepth) &&
		isAgentAllowedBySpawnPolicy("scout", disabledAgents, spawns)
	);
}
