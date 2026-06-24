import type { Settings } from "../config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend, MemoryBackendOperationContext } from "./types";

interface LocalMemoryOperationSession {
	settings: Settings;
}

interface LocalMemoryOperationContext {
	agentDir: string;
	cwd: string;
	session?: LocalMemoryOperationSession;
}

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		const mode = session?.settings.get("workspace.identifier") ?? "path";
		await clearMemoryData(agentDir, cwd, mode);
	},
	async enqueue(agentDir, cwd, session) {
		const mode = session?.settings.get("workspace.identifier") ?? "path";
		enqueueMemoryConsolidation(agentDir, cwd, undefined, mode);
	},
	async save(context: LocalMemoryOperationContext, input) {
		const mode = context.session?.settings.get("workspace.identifier") ?? "path";
		return saveLearnedLesson(context.agentDir, context.cwd, input, mode);
	},
	async status(_context: MemoryBackendOperationContext) {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
		};
	},
} satisfies MemoryBackend;
