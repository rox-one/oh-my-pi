/**
 * Files a pending tool call will write, read straight out of its resolved
 * arguments.
 *
 * Only `write` and `edit` are covered: their arguments name their targets
 * exactly, so a session file grant can match them without asking a model. Every
 * other tool (notably `bash`, whose targets live inside a shell command) leaves
 * this empty and relies on the similarity classifier to name what it writes.
 *
 * Own module, not part of `session-approvals.ts`: the store is imported by the
 * TUI event controller for the approval-title heuristic, and the edit-mode
 * parsers pulled in here drag the whole `../edit` graph behind them.
 */
import { Patch } from "@oh-my-pi/hashline";
import { isRecord } from "@oh-my-pi/pi-utils";
import { expandApplyPatchToEntries } from "../edit";
import { normalizeApprovalPath } from "./session-approvals";

/** Authored paths one `edit` call writes, in either of its two wire shapes. */
function editTargetPaths(args: Record<string, unknown>): string[] {
	const paths: string[] = [];
	// `replace` and `patch` modes: one `path`, optionally renamed by an entry.
	if (typeof args.path === "string") paths.push(args.path);
	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (isRecord(entry) && typeof entry.rename === "string") paths.push(entry.rename);
		}
	}
	const input = typeof args.input === "string" ? args.input : undefined;
	if (!input) return paths;
	// `hashline` mode: every section header is a separate target, and `MV` writes
	// its destination too. Parsing can throw on a malformed patch — an edit that
	// never applies grants nothing.
	try {
		const sections = Patch.parse(input).sections;
		for (const section of sections) {
			paths.push(section.path);
			if (section.fileOp?.kind === "move") paths.push(section.fileOp.dest);
		}
		if (sections.length > 0) return paths;
	} catch {
		// Not a hashline patch (or not a valid one) — try the apply-patch envelope.
	}
	try {
		for (const entry of expandApplyPatchToEntries({ input })) {
			paths.push(entry.path);
			if (entry.rename) paths.push(entry.rename);
		}
	} catch {
		// Neither wire shape parsed; the call names no file this gate can pin down.
	}
	return paths;
}

/**
 * Absolute normalized files `toolName` writes with `args`, resolved against
 * `cwd`. Empty for every tool whose targets are not readable from arguments,
 * and for values `normalizeApprovalPath` refuses (URLs, globs).
 */
export function toolWriteTargets(toolName: string, args: unknown, cwd: string): string[] {
	if (!isRecord(args)) return [];
	const authored =
		toolName === "write"
			? typeof args.path === "string"
				? [args.path]
				: []
			: toolName === "edit"
				? editTargetPaths(args)
				: [];
	const targets: string[] = [];
	for (const authoredPath of authored) {
		const normalized = normalizeApprovalPath(authoredPath, cwd);
		if (normalized && !targets.includes(normalized)) targets.push(normalized);
	}
	return targets;
}

/**
 * Working directory one tool call acts in: `bash` may redirect itself with its
 * own `cwd` argument, every other tool resolves paths against the session's.
 */
export function toolCallCwd(toolName: string, args: unknown, sessionCwd: string): string {
	if (toolName !== "bash" || !isRecord(args) || typeof args.cwd !== "string" || args.cwd.length === 0) {
		return sessionCwd;
	}
	return normalizeApprovalPath(args.cwd, sessionCwd) ?? sessionCwd;
}
