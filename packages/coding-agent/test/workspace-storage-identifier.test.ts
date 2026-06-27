import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { GitRepository } from "@oh-my-pi/pi-coding-agent/utils/git";
import {
	normalizeGitRemoteIdentifier,
	resolveWorkspaceStorageIdentity,
} from "@oh-my-pi/pi-coding-agent/utils/workspace-storage-identifier";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

interface GitFixture {
	agentDir: string;
	cloneCwd: string;
	repoCwd: string;
	worktreeCwd: string;
}

function gitRepository(commonDir: string): GitRepository {
	return {
		commonDir,
		gitDir: path.join(commonDir, ".git"),
		gitEntryPath: path.join(commonDir, ".git"),
		headPath: path.join(commonDir, ".git", "HEAD"),
		repoRoot: commonDir,
	};
}

async function makeTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return stdout;
}

async function createFixture(prefix: string): Promise<GitFixture> {
	const root = await makeTempDir(prefix);
	const repoCwd = root.join("repo");
	const worktreeCwd = root.join("repo-linked");
	const cloneCwd = root.join("repo-clone");
	const agentDir = root.join("agent");

	await runGit(root.path(), ["init", repoCwd]);
	await runGit(repoCwd, ["config", "user.email", "test@example.com"]);
	await runGit(repoCwd, ["config", "user.name", "Test User"]);
	await Bun.write(path.join(repoCwd, "README.md"), "fixture\n");
	await runGit(repoCwd, ["add", "README.md"]);
	await runGit(repoCwd, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
	await runGit(repoCwd, ["remote", "add", "origin", "git@github.com:owner/project.git"]);
	await runGit(repoCwd, ["worktree", "add", "-b", "linked", worktreeCwd]);
	await runGit(root.path(), ["clone", repoCwd, cloneCwd]);
	await runGit(cloneCwd, ["remote", "set-url", "origin", "https://gitlab.example/fork/project.git"]);

	return { agentDir, cloneCwd, repoCwd, worktreeCwd };
}

describe("workspace storage identity", () => {
	it("falls back to the supplied path segment outside a Git repository", async () => {
		const dir = await makeTempDir("@workspace-identity-nonrepo-");
		const identity = resolveWorkspaceStorageIdentity(dir.path(), "git-remote", "path-bucket");

		expect(identity).toEqual({
			requestedMode: "git-remote",
			mode: "path",
			key: path.resolve(dir.path()),
			segment: "path-bucket",
			fallback: true,
		});
	});

	it("falls back for shallow repositories in git-root mode", async () => {
		const root = await makeTempDir("@workspace-identity-shallow-");
		const repoCwd = root.join("repo");
		const shallowCwd = root.join("shallow");

		await runGit(root.path(), ["init", repoCwd]);
		await runGit(repoCwd, ["config", "user.email", "test@example.com"]);
		await runGit(repoCwd, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(repoCwd, "README.md"), "first\n");
		await runGit(repoCwd, ["add", "README.md"]);
		await runGit(repoCwd, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
		await Bun.write(path.join(repoCwd, "README.md"), "second\n");
		await runGit(repoCwd, ["add", "README.md"]);
		await runGit(repoCwd, ["-c", "commit.gpgsign=false", "commit", "-m", "second"]);
		await runGit(root.path(), [
			"-c",
			"protocol.file.allow=always",
			"clone",
			"--depth=1",
			`file://${repoCwd}`,
			shallowCwd,
		]);

		const identity = resolveWorkspaceStorageIdentity(shallowCwd, "git-root", "path-bucket");

		expect(identity.requestedMode).toBe("git-root");
		expect(identity.mode).toBe("path");
		expect(identity.key).toBe(path.resolve(shallowCwd));
		expect(identity.segment).toBe("path-bucket");
		expect(identity.fallback).toBe(true);
	});

	it("normalizes remote URL variants without credentials", () => {
		const git = gitRepository("/tmp");
		const scp = normalizeGitRemoteIdentifier(git, "git@github.com:Owner/repo.git");
		const ssh = normalizeGitRemoteIdentifier(git, "ssh://git@github.com/Owner/repo.git");
		const https = normalizeGitRemoteIdentifier(git, "https://token@github.com/Owner/repo");

		expect(scp).toBe("github.com/Owner/repo");
		expect(ssh).toBe(scp);
		expect(https).toBe(scp);
	});

	it("normalizes local .git remotes to the worktree path identity", async () => {
		const dir = await makeTempDir("@workspace-identity-local-remote-");
		const repoCwd = dir.join("project");
		const git = gitRepository("/tmp");
		const worktreeRemote = normalizeGitRemoteIdentifier(git, repoCwd);
		const dotGitRemote = normalizeGitRemoteIdentifier(git, `${repoCwd}/.git`);
		const dotGitSlashRemote = normalizeGitRemoteIdentifier(git, `${repoCwd}/.git/`);
		const suffixGitRemote = normalizeGitRemoteIdentifier(git, `${repoCwd}.git`);
		const suffixGitSlashRemote = normalizeGitRemoteIdentifier(git, `${repoCwd}.git/`);
		const fileSuffixGitSlashRemote = normalizeGitRemoteIdentifier(git, `file://${repoCwd}.git/`);
		const fileDotGitSlashRemote = normalizeGitRemoteIdentifier(git, `file://${repoCwd}/.git/`);

		expect(worktreeRemote).toBe(`file:${repoCwd}`);
		expect(dotGitRemote).toBe(worktreeRemote);
		expect(dotGitSlashRemote).toBe(worktreeRemote);
		expect(suffixGitRemote).toBe(worktreeRemote);
		expect(suffixGitSlashRemote).toBe(worktreeRemote);
		expect(fileSuffixGitSlashRemote).toBe(worktreeRemote);
		expect(fileDotGitSlashRemote).toBe(worktreeRemote);
	});

	it("shares session, local memory, and Mnemopi buckets across linked worktrees by remote", async () => {
		const fixture = await createFixture("@workspace-identity-worktree-");

		expect(SessionManager.getDefaultSessionDir(fixture.repoCwd, fixture.agentDir, undefined, "git-remote")).toBe(
			SessionManager.getDefaultSessionDir(fixture.worktreeCwd, fixture.agentDir, undefined, "git-remote"),
		);
		expect(getMemoryRoot(fixture.agentDir, fixture.repoCwd, "git-remote")).toBe(
			getMemoryRoot(fixture.agentDir, fixture.worktreeCwd, "git-remote"),
		);
		expect(computeMnemopiBankScope(undefined, fixture.repoCwd, "per-project", "git-remote").bank).toBe(
			computeMnemopiBankScope(undefined, fixture.worktreeCwd, "per-project", "git-remote").bank,
		);
	});

	it("keeps fork remotes separate but shares fork roots by first commit", async () => {
		const fixture = await createFixture("@workspace-identity-fork-");

		expect(SessionManager.getDefaultSessionDir(fixture.repoCwd, fixture.agentDir, undefined, "git-remote")).not.toBe(
			SessionManager.getDefaultSessionDir(fixture.cloneCwd, fixture.agentDir, undefined, "git-remote"),
		);
		expect(SessionManager.getDefaultSessionDir(fixture.repoCwd, fixture.agentDir, undefined, "git-root")).toBe(
			SessionManager.getDefaultSessionDir(fixture.cloneCwd, fixture.agentDir, undefined, "git-root"),
		);
	});
});
