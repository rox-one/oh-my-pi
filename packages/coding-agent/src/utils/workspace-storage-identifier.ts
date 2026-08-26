import * as path from "node:path";
import { $which, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import { fileURLToPath } from "bun";
import { type GitRepository, repo, root } from "./git";

export const WORKSPACE_IDENTIFIER_MODES = ["path", "git-remote", "git-root"] as const;
export type WorkspaceIdentifierMode = (typeof WORKSPACE_IDENTIFIER_MODES)[number];

export interface WorkspaceStorageIdentity {
	requestedMode: WorkspaceIdentifierMode;
	mode: WorkspaceIdentifierMode;
	key: string;
	segment: string;
	fallback: boolean;
}

const REMOTE_SLUG_MAX_LENGTH = 72;

const memoizedStoredIdentity = new Map<string, WorkspaceStorageIdentity>();

export function resolveWorkspaceStorageIdentity(
	cwd: string,
	requestedMode: WorkspaceIdentifierMode,
	pathFallbackSegment: string,
): WorkspaceStorageIdentity {
	const resolvedCwd = path.resolve(cwd || ".");
	if (requestedMode !== "path" && !isGitAvailable()) {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, true);
	}
	const memoKey = `${requestedMode}\0${resolvedCwd}\0${pathFallbackSegment}`;
	const memoized = memoizedStoredIdentity.get(memoKey);
	if (memoized) {
		return memoized;
	}
	const identity = resolveWorkspaceStorageIdentityInternal(resolvedCwd, requestedMode, pathFallbackSegment);
	memoizedStoredIdentity.set(memoKey, identity);
	return identity;
}

function resolveWorkspaceStorageIdentityInternal(
	resolvedCwd: string,
	requestedMode: WorkspaceIdentifierMode,
	pathFallbackSegment: string,
): WorkspaceStorageIdentity {
	if (requestedMode === "path") {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, false);
	}

	const repository = repo.resolveSync(resolvedCwd);
	if (!repository) {
		return pathIdentity(resolvedCwd, requestedMode, pathFallbackSegment, true);
	}

	if (requestedMode === "git-remote") {
		const remote = resolveGitRemoteIdentifier(repository);
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

	const rootCommit = resolveGitRootCommit(resolvedCwd);
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

export function normalizeGitRemoteIdentifier(git: GitRepository, remoteUrl: string): string | null {
	if (isWindowsDriveAbsolutePath(remoteUrl.trim())) {
		return localRemoteIdentifier(remoteUrl, git.commonDir);
	}

	const scpRemote = parseScpRemote(remoteUrl);
	if (scpRemote) {
		return remoteHostPathIdentifier(scpRemote.host, scpRemote.remotePath);
	}

	const parsed = parseRemoteUrl(remoteUrl);
	if (parsed) {
		if (parsed.protocol === "file:") {
			return localRemoteIdentifier(fileRemotePath(parsed), git.commonDir);
		}

		if (!parsed.hostname) return null;
		return remoteHostPathIdentifier(
			parsed.hostname.toLowerCase() + (parsed.port ? `:${parsed.port}` : ""),
			decodeUriPath(parsed.pathname),
		);
	}

	return localRemoteIdentifier(remoteUrl, git.commonDir);
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

function resolveGitRemoteIdentifier(git: GitRepository): string | null {
	const remotes = repo.getRemotesSync(git);
	const origin = remotes.find(remote => remote.name === "origin");
	if (origin) {
		const normalized = normalizeGitRemoteIdentifier(git, origin.fetchUrl);
		if (normalized) return normalized;
	}

	for (const remote of remotes) {
		const normalized = normalizeGitRemoteIdentifier(git, remote.fetchUrl);
		if (normalized) return normalized;
	}

	return null;
}

function resolveGitRootCommit(cwd: string): string | null {
	try {
		const shallow = repo.isShallowRepositorySync(cwd);
		if (shallow) return null;

		return root.shaSync(cwd);
	} catch {
		return null;
	}
}

function isGitAvailable(): boolean {
	return $which("git", { cache: WhichCachePolicy.Fresh, PATH: process.env.PATH }) !== null;
}

function isWindowsDriveAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeLocalRemotePath(rawPath: string, commonDir: string): string {
	if (isWindowsDriveAbsolutePath(rawPath)) {
		return path.win32.normalize(path.win32.resolve(rawPath));
	}

	return path.resolve(trimTrailingGit(commonDir), rawPath);
}

function fileRemotePath(parsed: URL): string {
	const decodedPathname = decodeUriPath(parsed.pathname);
	if (/^\/[A-Za-z]:[\\/]/.test(decodedPathname)) {
		return decodedPathname.slice(1);
	}

	return fileURLToPath(parsed);
}

function parseScpRemote(rawUrl: string): { host: string; remotePath: string } | null {
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawUrl) || isWindowsDriveAbsolutePath(rawUrl)) return null;

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

function localRemoteIdentifier(rawPath: string, commonDir: string): string | null {
	const trimmed = rawPath.trim();
	if (!trimmed) return null;

	const resolved = normalizeLocalRemotePath(trimmed, commonDir);
	const withoutTrailingSlash = trimTrailingPathSeparators(resolved);
	return `file:${trimTrailingPathSeparators(trimTrailingGit(withoutTrailingSlash))}`;
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

function trimTrailingPathSeparators(value: string): string {
	let output = value;
	while (output.length > 1 && !isWindowsDriveRoot(output) && /[\\/]$/.test(output)) {
		output = output.slice(0, -1);
	}
	return output;
}

function isWindowsDriveRoot(value: string): boolean {
	return /^[A-Za-z]:[\\/]$/.test(value);
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
