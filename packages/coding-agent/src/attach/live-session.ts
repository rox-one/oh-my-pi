/**
 * attach/live-session.ts — the minimum presentation-source surface the attach
 * substrate needs from a live worker session.
 *
 * The registry and server never touch the full `AgentSession`: they read a
 * typed {@link AttachLiveSessionSource} that exposes exactly the transcript
 * feed (entries + change notifications) and identity metadata. The Vibe
 * runtime adapts its registered worker sessions to this interface via
 * {@link createAttachLiveSessionSource}; tests can fake it directly.
 *
 * All control paths (prompt/steer/follow-up, abort, detach) stay in the
 * registry/Vibe bridge callbacks — this interface deliberately exposes NO
 * prompt/abort/dispose/switch methods, so an attach path cannot reach session
 * internals.
 */

import type { AgentSession } from "../session/agent-session";
import type { FileEntry } from "../session/session-entries";

export interface AttachLiveSessionSource {
	/**
	 * Stable identity of the current transcript branch. Changes when the
	 * session switches/rotates its branch — viewers must reset and re-snapshot.
	 */
	readonly branchId: string;
	/** The worker's session JSONL path when one exists (fallback parents: null). */
	readonly sessionFile: string | null;
	/** Working directory of the worker session (path shortening in rendering). */
	getCwd(): string;
	/** Current raw session entries (messages + metadata) from the live context. */
	getBranchEntries(): readonly FileEntry[];
	/**
	 * Subscribe to "the transcript may have grown / the model changed".
	 * Returns the unsubscribe function. Fired after entries are appended to
	 * the branch, never during a partial write.
	 */
	subscribe(listener: () => void): () => void;
}

/**
 * Adapt a live worker `AgentSession` to the attach presentation-source
 * interface. The listener fires on `message_end` / `turn_end` / `model_changed`
 * — the moments a new message (or the model label) durably lands in the
 * session context — so viewers re-sync exactly when the branch grows.
 */
export function createAttachLiveSessionSource(
	session: AgentSession,
	sessionFile: string | null,
): AttachLiveSessionSource {
	return {
		get branchId(): string {
			// The session's leaf id is the LAST inserted entry id and changes
			// on EVERY append — useless as a branch identity. The branch's
			// ROOT entry id is stable across appends and changes only when the
			// branch is actually switched/compacted/rotated.
			const branch = session.sessionManager.getBranch();
			if (branch.length > 0) return branch[0]!.id;
			return session.sessionManager.getLeafId() ?? session.sessionManager.getSessionId() ?? "";
		},
		sessionFile,
		getCwd: () => session.sessionManager.getCwd(),
		getBranchEntries: () => session.sessionManager.getBranch(),
		subscribe: listener =>
			session.subscribe(event => {
				if (event.type === "message_end" || event.type === "turn_end" || event.type === "model_changed") {
					listener();
				}
			}),
	};
}
