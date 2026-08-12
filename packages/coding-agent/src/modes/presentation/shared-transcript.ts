/**
 * modes/presentation/shared-transcript.ts — process-agnostic transcript
 * presentation for omp sessions.
 *
 * This is the ONE shared presentation surface between the normal interactive
 * mode and the worker-attach pane client. It owns:
 *
 * - **Reduction**: turning raw session entries (from a SessionManager branch
 *   or a persisted JSONL) into renderable transcript entries while tracking
 *   the active model (first assistant message / `model_change` entries).
 * - **Component production**: building the transcript's message/thinking/tool
 *   components through {@link ChatTranscriptBuilder} (rebuild vs. append,
 *   expansion, usage rows, tool grouping).
 * - **Shared line formatting**: error-line sanitization used by every
 *   fullscreen transcript chrome.
 *
 * It deliberately does NOT own: terminal ownership, `InteractiveMode`/TUI
 * lifecycle, live streaming updates (`EventController` stays interactive-mode
 * bound), session switching, or disposal of process-level resources. Layout
 * stays with each host: the normal mode keeps its native-scrollback
 * containers; the attach pane renders the presenter's container inside its
 * own fullscreen `ScrollView`.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { ChatTranscriptBuilder } from "../components/chat-transcript-builder";

/** Sanitize wire-delivered error text for a single TUI row: tabs → spaces,
 *  newlines collapsed, absolute paths shortened, truncated to `maxWidth`.
 *  Multi-line stacks and absolute host paths would break a frame's 1-row
 *  accounting and leak host filesystem layout. */
export function sanitizeErrorLine(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, p => shortenPath(p));
	return truncateToWidth(singleLine, Math.max(10, maxWidth));
}

/**
 * Filter raw session entries down to the transcript's message entries. All
 * non-message entries (model_change, compaction, lifecycle, …) are dropped —
 * they only influence rendering metadata (model) and are handled by the
 * presenter's ingest pass.
 */
export function extractSessionMessages(entries: readonly FileEntry[]): SessionMessageEntry[] {
	const messages: SessionMessageEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry as SessionMessageEntry);
	}
	return messages;
}

/** Dependencies shared by every transcript presenter host. */
export interface SessionTranscriptPresenterDeps {
	/** TUI used by tool components for interactive rendering (bare min). */
	ui: TUI;
	/** Working directory for path shortening in rendered components. */
	cwd: string;
	/** Tool registry lookup; optional (tool blocks render without live tools). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	/** Custom message renderers (extension-provided). */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Hide thinking blocks when true. */
	hideThinkingBlock?: () => boolean;
	/** Render thinking as prose only when true. */
	proseOnlyThinking?: () => boolean;
	/** Repaint request callback (host-owned). */
	requestRender: () => void;
}

/**
 * Process-agnostic transcript presenter: owns the {@link ChatTranscriptBuilder}
 * and the entry reduction (message extraction + model tracking) so every host
 * (normal interactive mode's file-backed viewer, the attach pane client) runs
 * the exact same component production.
 */
export class SessionTranscriptPresenter {
	readonly #builder: ChatTranscriptBuilder;
	#model: string | undefined;

	constructor(deps: SessionTranscriptPresenterDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.#builder.isEmpty;
	}

	/** The renderable transcript container (host lays it out). */
	get container(): ChatTranscriptBuilder["container"] {
		return this.#builder.container;
	}

	/** Model of the latest assistant message / model_change entry. */
	get model(): string | undefined {
		return this.#model;
	}

	/** Set the model label directly (e.g. from a wire metadata frame). */
	setModel(model: string | undefined): void {
		this.#model = model;
	}

	/** Discard all components and rebuild the whole transcript from entries. */
	rebuild(entries: readonly SessionMessageEntry[]): void {
		this.#ingest(entries);
		this.#builder.rebuild(entries);
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(entries: readonly SessionMessageEntry[]): void {
		this.#ingest(entries);
		this.#builder.append(entries);
	}

	/** Discard every rendered row and clear build state. */
	reset(): void {
		this.#builder.reset();
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		this.#builder.setExpanded(expanded);
	}

	/** Tear down components (sealing pending spinners). */
	dispose(): void {
		this.#builder.dispose();
	}

	/**
	 * Track the model from raw entries: `model_change` entries always set it;
	 * the first assistant message seeds it (matches the file-backed viewer's
	 * behavior so live and persisted transcripts render identically).
	 */
	#ingest(entries: readonly SessionMessageEntry[]): void {
		for (const entry of entries) {
			if (!this.#model && entry.message.role === "assistant") {
				this.#model = entry.message.model;
			}
		}
	}

	/**
	 * Convenience for hosts that hold raw session entries (SessionManager
	 * branches / parsed JSONL): extract messages and rebuild in one call.
	 */
	rebuildFromRaw(entries: readonly FileEntry[]): void {
		this.#model = undefined;
		this.#ingestRaw(entries);
		this.#builder.rebuild(extractSessionMessages(entries));
	}

	/** Append newly parsed raw entries without rebuilding rendered rows. */
	appendFromRaw(entries: readonly FileEntry[]): void {
		this.#ingestRaw(entries);
		this.#builder.append(extractSessionMessages(entries));
	}

	#ingestRaw(entries: readonly FileEntry[]): void {
		for (const entry of entries) {
			if (entry.type === "model_change") {
				this.#model = entry.model;
			} else if (entry.type === "message" && entry.message.role === "assistant" && !this.#model) {
				this.#model = entry.message.model;
			}
		}
	}
}
