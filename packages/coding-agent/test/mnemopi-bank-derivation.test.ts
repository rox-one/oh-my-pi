import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeMnemopiBankScope, extendRecallWithLegacyBanks } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

// Set up a fixture filesystem we can reuse across the two regression
// suites — same shape as `~/.omp/memories/mnemopi/` on a real install.
let rootDir: TempDir;
let dbDir: string;
let banksDir: string;
let mainDbPath: string;

beforeAll(async () => {
	rootDir = await TempDir.create("@mnemopi-bank-derivation-");
	dbDir = rootDir.join("mnemopi");
	banksDir = path.join(dbDir, "banks");
	await fs.mkdir(banksDir, { recursive: true });
	mainDbPath = path.join(dbDir, "mnemopi.db");
});

afterAll(async () => {
	await Bun.sleep(0);
	await rootDir.remove();
});

// Schema mirrors the subset of `packages/mnemopi/src/core/beam/schema.ts`
// that this code path needs to probe. We deliberately do not run the
// full schema setup — the cwd-probing query only touches working_memory.
function createBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
	const bankDir = path.join(banksDir, bank);
	const dbPath = path.join(bankDir, "mnemopi.db");
	mkdirSync(bankDir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		const insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
		for (const [index, meta] of metadataRows.entries()) {
			insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
		}
	} finally {
		db.close();
	}
}

describe("computeMnemopiBankScope (#2412)", () => {
	// Regression: same cwd must hash to the same bank no matter what the
	// ambient git layout looks like. The previous derivation walked
	// `git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd)`, so a
	// disappearing/appearing ancestor `.git` repointed the same conversation
	// directory to a different bank and stranded its memories.
	it("returns the same per-project bank for one cwd regardless of git state", async () => {
		const baseDir = await TempDir.create("@mnemopi-stable-bank-");
		try {
			const project = baseDir.join("projects", "omp-workstation");
			await fs.mkdir(project, { recursive: true });
			const withoutGit = computeMnemopiBankScope(undefined, project, "per-project").bank;

			// Plant an ancestor `.git` marker — the old code path resolved
			// `project` to `baseDir/projects` via this file, producing a
			// `projects-<hash>` bank id distinct from the cwd-derived one.
			await fs.mkdir(baseDir.join("projects"), { recursive: true });
			await fs.writeFile(baseDir.join("projects", ".git"), "gitdir: /dev/null\n");
			const withAncestorGit = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(withAncestorGit).toBe(withoutGit);

			await removeWithRetries(baseDir.join("projects", ".git"));
			const afterGitRemoved = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(afterGitRemoved).toBe(withoutGit);
		} finally {
			await Bun.sleep(0);
			await baseDir.remove();
		}
	});

	it("derives different banks for different cwds (sanity)", () => {
		const a = computeMnemopiBankScope(undefined, "/projects/repo-a", "per-project").bank;
		const b = computeMnemopiBankScope(undefined, "/projects/repo-b", "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("per-project-tagged opens both the project bank and the shared default", () => {
		const scope = computeMnemopiBankScope(undefined, "/projects/repo", "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the cwd entirely", () => {
		const here = computeMnemopiBankScope(undefined, "/projects/here", "global");
		const there = computeMnemopiBankScope(undefined, "/elsewhere", "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});

	it("shares per-project banks across linked worktrees in git-remote mode", async () => {
		const fixture = await createGitFixture("@mnemopi-git-worktree-");
		try {
			const repo = computeMnemopiBankScope(undefined, fixture.repoCwd, "per-project", "git-remote");
			const worktree = computeMnemopiBankScope(undefined, fixture.worktreeCwd, "per-project", "git-remote");

			expect(worktree.bank).toBe(repo.bank);
		} finally {
			await fixture.root.remove();
		}
	});

	it("separates fork remotes but shares root commits when requested", async () => {
		const fixture = await createGitFixture("@mnemopi-git-fork-");
		try {
			const remoteRepo = computeMnemopiBankScope(undefined, fixture.repoCwd, "per-project", "git-remote");
			const remoteFork = computeMnemopiBankScope(undefined, fixture.cloneCwd, "per-project", "git-remote");
			const rootRepo = computeMnemopiBankScope(undefined, fixture.repoCwd, "per-project", "git-root");
			const rootFork = computeMnemopiBankScope(undefined, fixture.cloneCwd, "per-project", "git-root");

			expect(remoteFork.bank).not.toBe(remoteRepo.bank);
			expect(rootFork.bank).toBe(rootRepo.bank);
		} finally {
			await fixture.root.remove();
		}
	});
});

describe("extendRecallWithLegacyBanks (#2412)", () => {
	it("adds a sibling bank only when all working_memory rows tag the active cwd", () => {
		const activeCwd = path.join(rootDir.path(), "projects", "myrepo");
		createBankFixture("legacy-A", [{ session_id: "old", cwd: activeCwd }]);
		createBankFixture("unrelated-B", [{ session_id: "other", cwd: path.join(rootDir.path(), "other", "place") }]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, activeCwd);
		expect(extended).toContain("active-bank");
		expect(extended).toContain("legacy-A");
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips mixed-cwd legacy banks because recall cannot filter rows by cwd", () => {
		const childCwd = path.join(rootDir.path(), "projects", "safe-child");
		createBankFixture("mixed-cwd-legacy", [
			{ cwd: childCwd },
			{ cwd: path.join(rootDir.path(), "projects", "sibling-child") },
		]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, childCwd);
		expect(extended).not.toContain("mixed-cwd-legacy");
	});

	it("keeps configured-bank legacy rescue inside the configured namespace", () => {
		const cwd = path.join(rootDir.path(), "projects", "configured-namespace");
		createBankFixture("alpha-bank", [{ cwd }]);
		createBankFixture("alpha-bank-legacy", [{ cwd }]);
		createBankFixture("beta-bank", [{ cwd }]);
		createBankFixture("beta-bank-legacy", [{ cwd }]);

		const alpha = extendRecallWithLegacyBanks(["alpha-bank-active"], mainDbPath, cwd, "alpha bank");
		expect(alpha).toContain("alpha-bank");
		expect(alpha).toContain("alpha-bank-legacy");
		expect(alpha).not.toContain("beta-bank");
		expect(alpha).not.toContain("beta-bank-legacy");

		const beta = extendRecallWithLegacyBanks(["beta-bank-active"], mainDbPath, cwd, "beta bank");
		expect(beta).toContain("beta-bank");
		expect(beta).toContain("beta-bank-legacy");
		expect(beta).not.toContain("alpha-bank");
		expect(beta).not.toContain("alpha-bank-legacy");
	});
});

describe("extendRecallWithLegacyBanks edge cases", () => {
	it("ignores banks already in the recall set", () => {
		const cwd = path.join(rootDir.path(), "projects", "already-in-set");
		createBankFixture("already-in-set", [{ cwd }]);
		const extended = extendRecallWithLegacyBanks(["already-in-set"], mainDbPath, cwd);
		expect(extended).toEqual(["already-in-set"]);
	});

	it("returns the input unchanged when banks/ does not exist", () => {
		const missingRoot = rootDir.join("no-such-mnemopi", "mnemopi.db");
		const out = extendRecallWithLegacyBanks(["one"], missingRoot, "/home/user/anywhere");
		expect(out).toEqual(["one"]);
	});

	it("tolerates a corrupt bank database without throwing", async () => {
		const corruptDir = path.join(banksDir, "corrupt-C");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(path.join(corruptDir, "mnemopi.db"), "not a sqlite file");
		const out = extendRecallWithLegacyBanks(["active"], mainDbPath, path.join(rootDir.path(), "some", "cwd"));
		expect(out).toContain("active");
		expect(out).not.toContain("corrupt-C");
	});
});

interface GitFixture {
	cloneCwd: string;
	repoCwd: string;
	root: TempDir;
	worktreeCwd: string;
}

async function createGitFixture(prefix: string): Promise<GitFixture> {
	const root = await TempDir.create(prefix);
	const repoCwd = root.join("repo");
	const worktreeCwd = root.join("repo-linked");
	const cloneCwd = root.join("repo-clone");

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

	return { cloneCwd, repoCwd, root, worktreeCwd };
}

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
