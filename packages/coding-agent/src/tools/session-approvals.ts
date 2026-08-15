/**
 * In-memory per-session tool approval state.
 *
 * Backs the "Approve <tool> Commands for Session" and "Approve Similar <tool>
 * Commands for Session" approval-prompt options. State is keyed by the session
 * id the approval gate already derives from `sessionManager.getSessionId()`,
 * lives for the process lifetime (or until `clearSessionApprovals`), and is
 * never persisted to settings or session files.
 */

/** Maximum recorded similar-approval subjects per tool, newest first. */
const MAX_SIMILAR_SUBJECTS = 10;

export interface SessionApprovalState {
	/** Tools approved for the rest of the session, by tool name. */
	approvedTools: Set<string>;
	/** Recorded approval subjects per tool, newest first, capped. */
	similar: Map<string, string[]>;
}

const sessionApprovals = new Map<string, SessionApprovalState>();

function mutableState(sessionId: string): SessionApprovalState | undefined {
	if (!sessionId) return undefined;
	let state = sessionApprovals.get(sessionId);
	if (!state) {
		state = { approvedTools: new Set(), similar: new Map() };
		sessionApprovals.set(sessionId, state);
	}
	return state;
}

export function isToolApprovedForSession(sessionId: string, toolName: string): boolean {
	return sessionId ? (sessionApprovals.get(sessionId)?.approvedTools.has(toolName) ?? false) : false;
}

export function approveToolForSession(sessionId: string, toolName: string): void {
	const state = mutableState(sessionId);
	if (!state) return;
	state.approvedTools.add(toolName);
	// Whole-tool approval subsumes the tool's similar list; dropping it keeps
	// the classifier prompt source bounded and the state unambiguous.
	state.similar.delete(toolName);
}

export function addSimilarApproval(sessionId: string, toolName: string, subject: string): void {
	const state = mutableState(sessionId);
	if (!state || !subject) return;
	const existing = state.similar.get(toolName) ?? [];
	const next = [subject, ...existing.filter(entry => entry !== subject)];
	state.similar.set(toolName, next.slice(0, MAX_SIMILAR_SUBJECTS));
}

export function getSimilarApprovals(sessionId: string, toolName: string): readonly string[] {
	return sessionId ? (sessionApprovals.get(sessionId)?.similar.get(toolName) ?? []) : [];
}

export function clearSessionApprovals(sessionId: string): void {
	sessionApprovals.delete(sessionId);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(entry => entry[1] !== undefined)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/**
 * Extract the comparable approval subject for a tool call: the raw `command`
 * string when the tool takes one (bash & friends), otherwise a stable JSON
 * form with sorted keys so structurally identical args compare equal. Kept
 * raw — the similarity classifier applies its own truncation.
 */
export function approvalSubject(args: unknown): string {
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const command = (args as Record<string, unknown>).command;
		if (typeof command === "string" && command.length > 0) return command;
	}
	return stableStringify(args);
}
