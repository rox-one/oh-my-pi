/**
 * attach/cli.ts — `omp attach` command: attach an interactive pane to a live
 * vibe worker through the local attach substrate.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, type CliConfig, Command } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { initTheme } from "../modes/theme/theme";
import { AttachPane } from "./pane";
import { ATTACH_SOCKET_FILE, ATTACH_TOKEN_FILE } from "./server";
import { ATTACH_RUNTIME_DIR_NAME } from "./vibe-bridge";

/** Resolved attach runtime paths derived from a parent session file. */
export interface AttachPaths {
	readonly socketFile: string;
	readonly tokenFile: string;
}

/**
 * Derive the attach runtime paths from the parent session file: the session
 * directory is the session file with its trailing `.jsonl` removed, and the
 * attach runtime dir (socket + token) lives in its `attach` subdirectory.
 */
export function resolveAttachPaths(
	sessionFile: string,
	overrides: { readonly socket?: string; readonly tokenFile?: string } = {},
): AttachPaths {
	const sessionDir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
	const runtimeDir = path.join(sessionDir, ATTACH_RUNTIME_DIR_NAME);
	return {
		socketFile: overrides.socket ?? path.join(runtimeDir, ATTACH_SOCKET_FILE),
		tokenFile: overrides.tokenFile ?? path.join(runtimeDir, ATTACH_TOKEN_FILE),
	};
}

/**
 * Read and trim the attach capability token. Returns `null` when the file is
 * missing, unreadable, or empty.
 */
export async function readAttachToken(tokenFile: string): Promise<string | null> {
	try {
		const token = (await fs.readFile(tokenFile, "utf8")).trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

export default class Attach extends Command {
	static description = commandHelp.description;

	static args = {
		workerId: Args.string({
			description: "Worker id to attach to (as printed by the vibe spawn)",
			required: true,
		}),
	};

	static flags = {
		"session-file": Args.string({
			description:
				"Parent session JSONL file the worker belongs to (optional when --socket and --token-file are given)",
			required: false,
		}),
		socket: Args.string({ description: "Override the attach socket path" }),
		"token-file": Args.string({ description: "Override the attach capability token file" }),
	};

	readonly #stderr: NodeJS.WritableStream;

	constructor(argv: string[], config: CliConfig, deps: { readonly stderr?: NodeJS.WritableStream } = {}) {
		super(argv, config);
		this.#stderr = deps.stderr ?? process.stderr;
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Attach);
		if (!flags["session-file"] && (flags.socket === undefined || flags["token-file"] === undefined)) {
			this.#stderr.write("attach: either --session-file or both --socket and --token-file are required\n");
			process.exitCode = 1;
			return;
		}
		const paths = resolveAttachPaths(flags["session-file"] ?? "", {
			socket: flags.socket,
			tokenFile: flags["token-file"],
		});
		const token = await readAttachToken(paths.tokenFile);
		if (token === null) {
			this.#stderr.write(
				`attach: cannot read capability token from ${paths.tokenFile} (missing, unreadable, or empty)\n`,
			);
			process.exitCode = 1;
			return;
		}
		await initTheme();
		// The shared transcript presenter's components read settings
		// (tool-activity visibility, token-usage rows, etc.); the attach CLI
		// does not run the full SDK startup, so initialize the singleton here.
		await Settings.init();
		const pane = new AttachPane(paths.socketFile, token, args.workerId ?? "", {
			onExit: code => {
				process.exitCode = code;
			},
		});
		await pane.start();
		// Stay alive for the pane's whole life. `finished()` resolves only
		// after the TUI restored the terminal; then force the exit so no
		// lingering handle (raw-mode stdin reader, framework watchers) can
		// keep the process alive with a zombie pane.
		await pane.finished();
		process.exit(process.exitCode);
	}
}
