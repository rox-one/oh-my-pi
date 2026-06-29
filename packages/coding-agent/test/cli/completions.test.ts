import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSpec, type CompletionSpec, generateCompletion } from "@oh-my-pi/pi-coding-agent/cli/completion-gen";
import { resolveWorkspaceIdentifierModeForCompletion } from "@oh-my-pi/pi-coding-agent/config/workspace-identifier-mode";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { CliConfig, CommandCtor } from "@oh-my-pi/pi-utils/cli";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const cleanupRoots: string[] = [];

async function makeTempWorkspace(name: string): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	cleanupRoots.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}

async function writeText(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
}

afterEach(async () => {
	const roots = cleanupRoots.splice(0);
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

function completionSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	env.NO_COLOR = "1";
	env.PI_NO_TITLE = "1";
	Object.assign(env, extra);
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	return env;
}

// A compact synthetic spec exercising every value-source kind and an aliased
// subcommand. The generators are pure functions of this shape, so pinning their
// output here defends the exact bytes each shell parses without booting the CLI.
const spec: CompletionSpec = {
	bin: "omp",
	root: {
		flags: [
			{ name: "model", description: "Model to use", value: { kind: "models", multiple: false }, repeatable: false },
			{ name: "models", description: "Model list", value: { kind: "models", multiple: true }, repeatable: false },
			{
				name: "thinking",
				description: "Effort",
				value: { kind: "enum", values: ["low", "high"] },
				repeatable: false,
			},
			{ name: "tools", description: "Tools", value: { kind: "list", values: ["read", "bash"] }, repeatable: false },
			{ name: "resume", char: "r", description: "Resume", value: { kind: "sessions" }, repeatable: false },
			{ name: "print", char: "p", description: "Print", value: { kind: "flag" }, repeatable: false },
			{ name: "extension", char: "e", description: "Ext", value: { kind: "file" }, repeatable: true },
			{ name: "session-dir", description: "Dir", value: { kind: "dir" }, repeatable: false },
		],
		args: [],
	},
	commands: [
		{
			name: "commit",
			aliases: [],
			description: "Commit",
			flags: [{ name: "push", description: "Push", value: { kind: "flag" }, repeatable: false }],
			args: [],
		},
		{
			name: "worktree",
			aliases: ["wt"],
			description: "Worktrees",
			flags: [],
			args: [{ name: "action", description: "Action", value: { kind: "enum", values: ["list", "clear"] } }],
		},
	],
};

describe("generateCompletion — bash", () => {
	const out = generateCompletion("bash", spec);

	it("registers the dispatcher and resolves alias arms to the canonical handler", () => {
		expect(out).toContain("complete -F _omp omp");
		expect(out).toContain("_omp_cmd_commit");
		// worktree + its alias dispatch to the same function
		expect(out).toContain("worktree|wt)");
	});

	it("completes enum, dynamic, and comma-list flag values by previous flag", () => {
		expect(out).toContain('--thinking)\n\t\t\tCOMPREPLY=( $(compgen -W "low high"');
		expect(out).toContain('--model)\n\t\t\tCOMPREPLY=( $(compgen -W "$(command omp __complete models -- "$cur"');
		expect(out).toContain("--resume|-r)");
		expect(out).toContain("command omp __complete sessions");
		// static comma list routes through the comma-aware helper
		expect(out).toContain('--tools)\n\t\t\t_omp_comma "read bash"');
		// multiple-value models flag also uses the comma helper
		expect(out).toContain("--models)\n\t\t\t_omp_comma");
	});

	it("offers subcommand names and root flags at the top level", () => {
		expect(out).toMatch(/compgen -W "commit worktree wt [^"]*--model/);
	});

	it("completes a subcommand's positional enum and its own flags", () => {
		expect(out).toContain("_omp_cmd_worktree()");
		expect(out).toContain('compgen -W "list clear"');
		expect(out).toContain("_omp_cmd_commit()");
		expect(out).toContain('compgen -W "--push"');
	});
});

describe("generateCompletion — zsh", () => {
	const out = generateCompletion("zsh", spec);

	it("emits the compdef header and dual-mode (autoload + eval) tail", () => {
		expect(out.startsWith("#compdef omp")).toBe(true);
		expect(out).toContain('if [ "$funcstack[1]" = "_omp" ]; then');
		expect(out).toContain("compdef _omp omp");
	});

	it("maps value sources to the right _arguments actions", () => {
		expect(out).toContain("'--model[Model to use]:model:_omp_call models'");
		expect(out).toContain("'--models[Model list]:models:_omp_models_list'");
		expect(out).toContain("'--thinking[Effort]:value:(low high)'");
		expect(out).toContain("'--tools[Tools]:value:_omp_tools'");
		expect(out).toContain("'(-r --resume)'{-r,--resume}'[Resume]:session:_omp_call sessions'");
		expect(out).toContain("'--session-dir[Dir]:dir:_files -/'");
		// repeatable short+long flag uses the `*{...}` form
		expect(out).toContain("'*'{-e,--extension}'[Ext]:file:_files'");
		// the static tool list helper is baked
		expect(out).toContain("_omp_tools() { _values -s , 'tools' read bash }");
	});

	it("dispatches aliased subcommands and completes positional enums", () => {
		expect(out).toContain("worktree|wt) _omp_cmd_worktree ;;");
		expect(out).toContain("':action:(list clear)'");
	});
});

describe("generateCompletion — fish", () => {
	const out = generateCompletion("fish", spec);

	it("declares the no-subcommand predicate over every command token", () => {
		expect(out).toContain("function __fish_omp_no_subcommand");
		expect(out).toContain("if contains -- $i commit worktree wt");
	});

	it("renders subcommand names, including aliases, with descriptions", () => {
		expect(out).toContain("-a 'commit' -d 'Commit'");
		expect(out).toContain("-a 'wt' -d 'Worktrees'");
	});

	it("maps value sources to fish completion args", () => {
		expect(out).toContain("-l model -d 'Model to use' -x -a '(command omp __complete models -- (commandline -ct))'");
		expect(out).toContain("-l thinking -d 'Effort' -x -a 'low high'");
		expect(out).toContain("-l tools -d 'Tools' -x -a 'read bash'");
		expect(out).toContain("-s r -l resume -d 'Resume' -x -a '(command omp __complete sessions");
		// a bare boolean flag takes no value
		expect(out).toContain("-s p -l print -d 'Print'");
		expect(out).not.toContain("-l print -d 'Print' -x");
	});

	it("gates a positional enum on its subcommand", () => {
		expect(out).toContain("-n '__fish_seen_subcommand_from worktree wt' -a 'list clear'");
	});
});

describe("buildSpec", () => {
	function fakeCmd(props: Partial<CommandCtor>): CommandCtor {
		return props as unknown as CommandCtor;
	}

	it("lifts the root command's flags and excludes root + hidden from subcommands", () => {
		const config: CliConfig = {
			bin: "omp",
			version: "0",
			commands: new Map<string, CommandCtor>([
				["launch", fakeCmd({ hidden: true, flags: { model: { kind: "string" } }, args: {} })],
				["__complete", fakeCmd({ hidden: true, flags: {}, args: {} })],
				["config", fakeCmd({ description: "Cfg", flags: { json: { kind: "boolean" } }, args: {} })],
			]),
		};
		const result = buildSpec(config, "launch", new Map([["config", ["c"]]]));

		expect(result.root.flags.map(f => f.name)).toContain("model");
		// hidden (__complete) and the root entry (launch) are both dropped
		expect(result.commands.map(c => c.name)).toEqual(["config"]);
		expect(result.commands[0]?.aliases).toEqual(["c"]);
	});

	it("classifies flag value sources from descriptor metadata", () => {
		const config: CliConfig = {
			bin: "omp",
			version: "0",
			commands: new Map<string, CommandCtor>([
				[
					"launch",
					fakeCmd({
						hidden: true,
						flags: {
							model: { kind: "string" },
							thinking: { kind: "string", options: ["low", "high"] },
							"no-tools": { kind: "boolean" },
							"session-dir": { kind: "string" },
						},
						args: {},
					}),
				],
			]),
		};
		const root = buildSpec(config, "launch", new Map()).root;
		const byName = new Map(root.flags.map(f => [f.name, f.value.kind]));
		expect(byName.get("model")).toBe("models");
		expect(byName.get("thinking")).toBe("enum");
		expect(byName.get("no-tools")).toBe("flag");
		expect(byName.get("session-dir")).toBe("dir");
	});
});

describe("resolveWorkspaceIdentifierModeForCompletion", () => {
	it("defaults to path when config files do not mention the setting", async () => {
		const { cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-default");
		await writeText(path.join(agentDir, "config.yml"), "model: smol\n");
		await writeText(path.join(cwd, ".omp", "settings.json"), JSON.stringify({ model: "slow" }));

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("path");
	});

	it("uses a non-default mode from global YAML", async () => {
		const { cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-global");
		await writeText(path.join(agentDir, "config.yml"), "workspace:\n  identifier: git-remote\n");

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("git-remote");
	});

	it("lets project config override global config", async () => {
		const { cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-project");
		await writeText(path.join(agentDir, "config.yml"), "workspace:\n  identifier: git-root\n");
		await writeText(path.join(cwd, ".omp", "config.yml"), "workspace:\n  identifier: git-remote\n");

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("git-remote");
	});

	it("ignores malformed files and invalid values", async () => {
		const { cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-invalid");
		await writeText(path.join(agentDir, "config.yml"), "workspace:\n  identifier: [\n");
		await writeText(path.join(cwd, ".omp", "settings.json"), JSON.stringify({ workspace: { identifier: "branch" } }));

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("path");
	});

	it("accepts dotted workspace.identifier keys", async () => {
		const { cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-dotted");
		await writeText(path.join(cwd, "opencode.json"), JSON.stringify({ "workspace.identifier": "git-root" }));

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("git-root");
	});

	it("falls back to path when configured for git-root but git is missing from the current PATH", async () => {
		const { root, cwd, agentDir } = await makeTempWorkspace("omp-completion-mode-no-git");
		const emptyBin = path.join(root, "empty-bin");
		await fs.mkdir(emptyBin);
		await writeText(path.join(agentDir, "config.yml"), "workspace:\n  identifier: git-root\n");

		await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("git-root");

		const originalPath = process.env.PATH;
		process.env.PATH = emptyBin;
		try {
			await expect(resolveWorkspaceIdentifierModeForCompletion({ cwd, agentDir })).resolves.toBe("path");
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});
});

describe("omp completions (integration / drift)", () => {
	it("emits a zsh script reflecting the live command + flag surface", async () => {
		const proc = Bun.spawn([process.execPath, cliEntry, "completions", "zsh"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: completionSpawnEnv(),
		});
		const [stdout, , exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(0);

		// Real top-level flags from launch's static `flags` table. Flags with a
		// short char render as `{-r,--resume}`, so only assert the bracket form for
		// the long-only ones and check the char-paired form separately.
		for (const flag of ["--model", "--thinking", "--mode", "--approval-mode", "--tools", "--no-tools"]) {
			expect(stdout).toContain(`${flag}[`);
		}
		expect(stdout).toContain("{-r,--resume}");
		// Real enum option sets flow through unchanged.
		expect(stdout).toContain(":value:(off minimal low medium high xhigh max auto)");
		expect(stdout).toContain(":value:(always-ask write yolo)");
		// Real subcommands present; dynamic callbacks wired.
		expect(stdout).toContain("_omp_cmd_commit");
		expect(stdout).toContain("'completions:");
		// zsh routes single-value dynamic flags through the _omp_call action, which
		// itself shells out to `omp __complete $kind`.
		expect(stdout).toContain("_omp_call models");
		expect(stdout).toContain("_omp_call sessions");
		expect(stdout).toContain("command omp __complete $kind");
		// Hidden/default commands must NOT surface as completable subcommands.
		expect(stdout).not.toContain("_omp_cmd_launch");
		expect(stdout).not.toContain("_omp_cmd___complete");
	}, 15_000);

	it("lists sessions from the configured non-path workspace mode only", async () => {
		const { agentDir } = await makeTempWorkspace("omp-completion-sessions-mode");
		await writeText(path.join(agentDir, "config.yml"), "workspace:\n  identifier: git-root\n");

		const gitRootSessionId = "mode-completion-gitroot";
		const pathSessionId = "mode-completion-path";
		const gitRootSessionDir = SessionManager.getDefaultSessionDir(repoRoot, agentDir, undefined, "git-root");
		const pathSessionDir = SessionManager.getDefaultSessionDir(repoRoot, agentDir, undefined, "path");
		expect(gitRootSessionDir).not.toBe(pathSessionDir);

		await writeText(
			path.join(gitRootSessionDir, `2026-01-01T00-00-00-000Z_${gitRootSessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 1,
				id: gitRootSessionId,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: repoRoot,
				title: "Git Root Completion Session",
			})}\n`,
		);
		await writeText(
			path.join(pathSessionDir, `2026-01-01T00-00-01-000Z_${pathSessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 1,
				id: pathSessionId,
				timestamp: "2026-01-01T00:00:01.000Z",
				cwd: repoRoot,
				title: "Path Completion Session",
			})}\n`,
		);

		const proc = Bun.spawn([process.execPath, cliEntry, "__complete", "sessions", "--", "mode-completion"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: completionSpawnEnv({ PI_CODING_AGENT_DIR: agentDir }),
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain(`${gitRootSessionId}\tGit Root Completion Session`);
		expect(stdout).not.toContain(pathSessionId);
	}, 15_000);
});
