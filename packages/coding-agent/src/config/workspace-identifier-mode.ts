import * as path from "node:path";
import { $which, getAgentDir, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import { TOML, YAML } from "bun";
import { WORKSPACE_IDENTIFIER_MODES, type WorkspaceIdentifierMode } from "../utils/workspace-storage-identifier";

export interface CompletionWorkspaceIdentifierModeOptions {
	cwd: string;
	agentDir?: string;
}

interface CandidateConfig {
	path: string;
	format: "json" | "toml" | "yaml";
}

export async function resolveWorkspaceIdentifierModeForCompletion(
	options: CompletionWorkspaceIdentifierModeOptions,
): Promise<WorkspaceIdentifierMode> {
	let mode: WorkspaceIdentifierMode = "path";
	for (const candidate of candidateConfigs(options)) {
		const candidateMode = await readWorkspaceIdentifierMode(candidate);
		if (candidateMode !== undefined) {
			mode = candidateMode;
		}
	}
	if (mode !== "path" && !isGitAvailable()) {
		return "path";
	}
	return mode;
}

function candidateConfigs(options: CompletionWorkspaceIdentifierModeOptions): CandidateConfig[] {
	const cwd = path.normalize(options.cwd);
	const agentDir = path.normalize(options.agentDir ?? getAgentDir());
	return [
		{ path: path.join(agentDir, "config.yml"), format: "yaml" },
		{ path: path.join(cwd, ".omp", "settings.json"), format: "json" },
		{ path: path.join(cwd, ".omp", "config.yml"), format: "yaml" },
		{ path: path.join(cwd, ".claude", "settings.json"), format: "json" },
		{ path: path.join(cwd, ".codex", "config.toml"), format: "toml" },
		{ path: path.join(cwd, ".gemini", "settings.json"), format: "json" },
		{ path: path.join(cwd, "opencode.json"), format: "json" },
		{ path: path.join(cwd, ".cursor", "settings.json"), format: "json" },
	];
}

async function readWorkspaceIdentifierMode(candidate: CandidateConfig): Promise<WorkspaceIdentifierMode | undefined> {
	try {
		const raw = await Bun.file(candidate.path).text();
		if (!raw.includes("workspace.identifier") && (!raw.includes("workspace") || !raw.includes("identifier")))
			return undefined;
		return extractWorkspaceIdentifierMode(parseConfig(raw, candidate.format));
	} catch {
		return undefined;
	}
}

function parseConfig(raw: string, format: CandidateConfig["format"]): unknown {
	if (format === "yaml") return YAML.parse(raw);
	if (format === "toml") return TOML.parse(raw);
	return JSON.parse(raw);
}

function extractWorkspaceIdentifierMode(config: unknown): WorkspaceIdentifierMode | undefined {
	if (!isConfigObject(config)) return undefined;
	const workspace = config.workspace;
	if (isConfigObject(workspace) && isWorkspaceIdentifierMode(workspace.identifier)) {
		return workspace.identifier;
	}
	const dotted = config["workspace.identifier"];
	return isWorkspaceIdentifierMode(dotted) ? dotted : undefined;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkspaceIdentifierMode(value: unknown): value is WorkspaceIdentifierMode {
	return typeof value === "string" && (WORKSPACE_IDENTIFIER_MODES as readonly string[]).includes(value);
}

function isGitAvailable(): boolean {
	return $which("git", { cache: WhichCachePolicy.Fresh, PATH: process.env.PATH }) !== null;
}
