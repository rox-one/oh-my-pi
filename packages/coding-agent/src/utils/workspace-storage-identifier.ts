import * as path from "node:path";
import { $which, WhichCachePolicy } from "@oh-my-pi/pi-utils";

export const WORKSPACE_IDENTIFIER_MODES = ["path", "git-remote", "git-root"] as const;
export type WorkspaceIdentifierMode = (typeof WORKSPACE_IDENTIFIER_MODES)[number];

export interface WorkspaceStorageIdentity {
	requestedMode: WorkspaceIdentifierMode;
	mode: WorkspaceIdentifierMode;
	key: string;
	segment: string;
	fallback: boolean;
}

interface GitCommandResult {
	exitCode: number;
	stdout: string;
}

const GIT_READ_ONLY_ARGS = [
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
] as const;
const ROOT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REMOTE_SLUG_MAX_LENGTH = 72;

export function resolveWorkspaceStorageIdentity(
	cwd: string,
	requestedMode: WorkspaceIdentifierMode,
	pathFallbackSegment: string,
): WorkspaceStorageIdentity {
	const resolvedCwd = path.resolve(cwd || ".");
	if (requestedMode === "path") {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, false);
	}

	const git = $which("git", { cache: WhichCachePolicy.Fresh, PATH: process.env.PATH });
	if (!git) {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, true);
	}

	if (requestedMode === "git-remote") {
		const remote = resolveGitRemoteIdentifier(git, resolvedCwd);
		if (!remote) {
			return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, true);
		}

		const key = `git-remote:${remote}`;
		return {
			requestedMode,
			mode: "git-remote",
			key,
			segment: `git-remote-${remoteSlug(remote)}-${hash12(key)}`,
			fallback: false,
		};
	}

	const rootCommit = resolveGitRootCommit(git, resolvedCwd);
	if (!rootCommit) {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, true);
	}

	const key = `git-root:${rootCommit}`;
	return {
		requestedMode,
		mode: "git-root",
		key,
		segment: `git-root-${rootCommit}`,
		fallback: false,
	};
}

export function normalizeGitRemoteIdentifier(rawUrl: string, cwd: string): string | null {
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;

	const scpRemote = parseScpRemote(trimmed);
	if (scpRemote) {
		return remoteHostPathIdentifier(scpRemote.host, scpRemote.remotePath);
	}

	const parsed = parseRemoteUrl(trimmed);
	if (parsed) {
		if (parsed.protocol === "file:") {
			return localRemoteIdentifier(decodeUriPath(parsed.pathname), cwd);
		}

		if (!parsed.hostname) return null;
		return remoteHostPathIdentifier(
			parsed.hostname.toLowerCase() + (parsed.port ? `:${parsed.port}` : ""),
			decodeUriPath(parsed.pathname),
		);
	}

	return localRemoteIdentifier(trimmed, cwd);
}

function pathIdentity(
	resolvedCwd: string,
	requestedMode: WorkspaceIdentifierMode,
	segment: string,
	fallback: boolean,
): WorkspaceStorageIdentity {
	return {
		requestedMode,
		mode: "path",
		key: resolvedCwd,
		segment,
		fallback,
	};
}

function resolveGitRemoteIdentifier(git: string, cwd: string): string | null {
	const origin = runGit(git, cwd, ["remote", "get-url", "origin"]);
	const originUrl = firstLine(origin);
	if (origin.exitCode === 0 && originUrl) {
		const normalized = normalizeGitRemoteIdentifier(originUrl, cwd);
		if (normalized) return normalized;
	}

	const remotes = runGit(git, cwd, ["remote"]);
	if (remotes.exitCode !== 0) return null;

	for (const remoteName of remotes.stdout
		.split(/\r?\n/)
		.map(remote => remote.trim())
		.filter(Boolean)) {
		const remote = runGit(git, cwd, ["remote", "get-url", remoteName]);
		const remoteUrl = firstLine(remote);
		if (remote.exitCode !== 0 || !remoteUrl) continue;

		const normalized = normalizeGitRemoteIdentifier(remoteUrl, cwd);
		if (normalized) return normalized;
	}

	return null;
}

function resolveGitRootCommit(git: string, cwd: string): string | null {
	const shallow = isShallowRepository(git, cwd);
	if (shallow !== false) return null;

	const result = runGit(git, cwd, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
	if (result.exitCode !== 0) return null;

	for (const line of result.stdout.split(/\r?\n/)) {
		const candidate = line.trim().toLowerCase();
		if (ROOT_COMMIT_PATTERN.test(candidate)) return candidate;
	}

	return null;
}

function isShallowRepository(git: string, cwd: string): boolean | null {
	const result = runGit(git, cwd, ["rev-parse", "--is-shallow-repository"]);
	if (result.exitCode !== 0) return null;

	const value = firstLine(result);
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

function runGit(git: string, cwd: string, args: readonly string[]): GitCommandResult {
	try {
		const result = Bun.spawnSync([git, ...GIT_READ_ONLY_ARGS, ...args], {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		return {
			exitCode: result.exitCode ?? 0,
			stdout: new TextDecoder().decode(result.stdout),
		};
	} catch {
		return { exitCode: 1, stdout: "" };
	}
}

function firstLine(result: GitCommandResult): string | null {
	const line = result.stdout
		.split(/\r?\n/)
		.map(value => value.trim())
		.find(Boolean);
	return line ?? null;
}

function parseScpRemote(rawUrl: string): { host: string; remotePath: string } | null {
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawUrl)) return null;

	const match = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(rawUrl);
	if (!match) return null;

	return {
		host: match[1].toLowerCase(),
		remotePath: match[2],
	};
}

function parseRemoteUrl(rawUrl: string): URL | null {
	try {
		return new URL(rawUrl);
	} catch {
		return null;
	}
}

function remoteHostPathIdentifier(host: string, rawPath: string): string | null {
	const normalizedPath = trimTrailingGit(trimSlashes(rawPath));
	if (!host || !normalizedPath) return null;

	return `${host}/${normalizedPath}`;
}

function localRemoteIdentifier(rawPath: string, cwd: string): string | null {
	const trimmed = rawPath.trim();
	if (!trimmed) return null;

	const resolved = path.resolve(cwd || ".", trimmed);
	const withoutTrailingSlash = trimTrailingSlashes(resolved);
	return `file:${trimTrailingSlashes(trimTrailingGit(withoutTrailingSlash))}`;
}

function decodeUriPath(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function trimSlashes(value: string): string {
	return trimTrailingSlashes(value).replace(/^\/+/, "");
}

function trimTrailingSlashes(value: string): string {
	let output = value;
	while (output.length > 1 && output.endsWith("/")) {
		output = output.slice(0, -1);
	}
	return output;
}

function trimTrailingGit(value: string): string {
	return value.replace(/\.git$/i, "");
}

function remoteSlug(remote: string): string {
	const slug = remote.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	const capped = (slug || "remote").slice(0, REMOTE_SLUG_MAX_LENGTH).replace(/-+$/g, "");
	return capped || "remote";
}

function hash12(key: string): string {
	return Bun.hash(key).toString(16).padStart(16, "0").slice(-12);
}
