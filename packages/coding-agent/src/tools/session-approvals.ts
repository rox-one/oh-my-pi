/**
 * In-memory per-session tool approval state.
 *
 * Backs the "Approve <tool> Commands for Session" and "Approve Similar <tool>
 * Commands for Session" approval-prompt options. State is keyed by the session
 * id the approval gate already derives from `sessionManager.getSessionId()`, is
 * never persisted to settings or session files, and dies with the logical
 * session: `AgentSession` releases the entry at every conversation boundary
 * (`/new`, `/reset`, fork, rewind/branch, session switch) and on dispose via
 * `clearSessionApprovals`, so nothing survives the session that granted it —
 * not even a revival that re-opens the same session id in the same process.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

/** The only part of a tool `approvalSubject` needs: its approval-prompt detail lines. */
export type ApprovalSubjectTool = Pick<AgentTool, "formatApprovalDetails">;

/** Maximum recorded similar-approval subjects per tool, newest first. */
const MAX_SIMILAR_SUBJECTS = 10;

/**
 * Retention bound per recorded subject — a subject can be a whole `write`
 * payload or patch. The classifier never cuts a subject to fit its own, much
 * smaller budget (`MAX_SUBJECT_CHARS` in `approval-similarity.ts`): it skips
 * the oversized ones, so everything past that budget is retention and display
 * only.
 */
const MAX_RETAINED_SUBJECT_CHARS = 4096;

/** One recorded "approve similar" grant. */
export interface SimilarApproval {
	/** Bounded display text the user approved — for display and classification only. */
	subject: string;
	/** {@link approvalIdentity} of the call's full resolved args; the only exact-repeat key. */
	identity: string;
}

export interface SessionApprovalState {
	/** Tools approved for the rest of the session, by tool name. */
	approvedTools: Set<string>;
	/** Recorded approvals per tool, newest first, capped. */
	similar: Map<string, SimilarApproval[]>;
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

/** Record one "approve similar" grant. `identity` must come from {@link approvalIdentity}. */
export function addSimilarApproval(sessionId: string, toolName: string, subject: string, identity: string): void {
	const state = mutableState(sessionId);
	if (!state || !subject) return;
	const bounded =
		subject.length > MAX_RETAINED_SUBJECT_CHARS ? `${subject.slice(0, MAX_RETAINED_SUBJECT_CHARS - 1)}…` : subject;
	const entry: SimilarApproval = { subject: bounded, identity };
	const existing = state.similar.get(toolName) ?? [];
	// Dedup on identity, not on the bounded subject: a re-approval of the same
	// call refreshes it to newest-first, while two calls that differ only past
	// the display truncation stay two entries.
	const next = [entry, ...existing.filter(recorded => recorded.identity !== identity)];
	state.similar.set(toolName, next.slice(0, MAX_SIMILAR_SUBJECTS));
}

export function getSimilarApprovals(sessionId: string, toolName: string): readonly SimilarApproval[] {
	return sessionId ? (sessionApprovals.get(sessionId)?.similar.get(toolName) ?? []) : [];
}

export function clearSessionApprovals(sessionId: string): void {
	sessionApprovals.delete(sessionId);
}

/**
 * Serialized values longer than this are bulk payloads (file content, patches,
 * scripts) and sort after the compact fields.
 */
const BULK_VALUE_CHARS = 96;

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	// Compact fields first, bulk payloads last, each group by key name. The
	// ordering is for `approvalSubject`'s JSON fallback: its head is what the
	// user reads in the approval prompt and all of it the retention bound keeps,
	// so a `path`/`url`-style discriminator must not sit behind a whole file's
	// content merely because its key sorts later in the alphabet. The
	// same-named helper in `../mcp/tool-cache.ts` sorts keys plainly instead —
	// different consumer, deliberately not the same function.
	const fields = Object.entries(value as Record<string, unknown>)
		.filter(entry => entry[1] !== undefined)
		.map(([key, entry]) => ({ key, json: stableStringify(entry) }))
		.sort((a, b) => {
			const bulk = Number(a.json.length > BULK_VALUE_CHARS) - Number(b.json.length > BULK_VALUE_CHARS);
			if (bulk !== 0) return bulk;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
	return `{${fields.map(field => `${JSON.stringify(field.key)}:${field.json}`).join(",")}}`;
}

/**
 * Exact-repeat key of a tool call: a digest of its FULL resolved arguments,
 * taken before any display truncation.
 *
 * Approval subjects are lossy twice over — every tool cuts its bulk payloads to
 * 2000 chars for the prompt (`truncateForPrompt`) and this store bounds the
 * result again — so two calls that differ only past the cut carry byte-identical
 * subject text. Matching a repeat on that text would auto-approve the second
 * one with no model and no prompt; matching on this digest cannot.
 *
 * Cryptographic on purpose. A digest hit is the strongest short-circuit in the
 * feature — `isSimilarToApprovedCommand` answers true on it before the model,
 * before the budget gates, and with no prompt — and both digested argument sets
 * are written by a model that may be acting on injected content. So a
 * constructed colliding pair (the benign call the user approves, plus a
 * malicious twin) is a way to run a tool unprompted, which rules out
 * `Bun.hash`: wyhash with a fixed public seed claims no collision resistance,
 * and its 64-bit output falls to a birthday search. SHA-256 costs a few
 * milliseconds even on a multi-megabyte `write` payload, once per gated call,
 * on a path that already waits up to 3 s on a model.
 */
export function approvalIdentity(args: unknown): string {
	return new Bun.CryptoHasher("sha256").update(stableStringify(args)).digest("base64url");
}

function approvalDetails(tool: ApprovalSubjectTool, args: unknown): string | undefined {
	let details: string | string[] | undefined;
	try {
		details = tool.formatApprovalDetails?.(args);
	} catch (error) {
		// Extension-supplied formatters are third-party code; a throw here must
		// not turn an approval prompt into a failed tool call.
		logger.debug("session-approvals: formatApprovalDetails failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	const text = Array.isArray(details) ? details.filter(line => line.length > 0).join("\n") : details;
	return text && text.length > 0 ? text : undefined;
}

/**
 * Extract the comparable approval subject for a tool call.
 *
 * Preference order: the tool's own approval-prompt detail lines — the exact
 * text the user approved, and the only form that keeps the discriminating
 * field (`Path:`, `Command:`, `Action:`) at the head where the classifier's
 * truncation can't drop it — then a raw `command` string for command-shaped
 * args without a formatter, then stable JSON with bulk fields last. Kept raw:
 * the similarity classifier applies its own truncation.
 */
export function approvalSubject(tool: ApprovalSubjectTool, args: unknown): string {
	const details = approvalDetails(tool, args);
	if (details) return details;
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const command = (args as Record<string, unknown>).command;
		if (typeof command === "string" && command.length > 0) return command;
	}
	return stableStringify(args);
}
