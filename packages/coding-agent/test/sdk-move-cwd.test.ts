import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});

	it("rebases nested job links and the configured registry with the moved artifact tree", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-resources-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions-a"));
		await sessionManager.ensureOnDisk();
		const oldArtifactsDir = sessionManager.getArtifactsDir();
		if (!oldArtifactsDir) throw new Error("Expected source artifact directory");
		const registry = new AgentRegistry();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			agentRegistry: registry,
			agentId: "Main",
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		const childManager = SessionManager.create(cwdA, oldArtifactsDir);
		await childManager.ensureOnDisk();
		const nestedSessionFile = childManager.getSessionFile();
		if (!nestedSessionFile) throw new Error("Expected nested session file");
		const nestedRef = registry.register({
			id: "NestedAgent",
			displayName: "nested agent",
			kind: "sub",
			parentId: "Main",
			session: { sessionManager: childManager } as never,
			sessionFile: nestedSessionFile,
			status: "parked",
		});

		try {
			const manager = AsyncJobManager.instance();
			if (!manager) throw new Error("Expected session-owned async job manager");
			const jobId = manager.register("task", "nested work", async () => "done", {
				ownerId: "NestedAgent",
				linkPath: nestedSessionFile,
			});
			await manager.waitForAll();

			await session.moveSession(cwdB, path.join(tempDir, "sessions-b"));
			const newArtifactsDir = sessionManager.getArtifactsDir();
			if (!newArtifactsDir) throw new Error("Expected moved artifact directory");
			const movedNestedSessionFile = path.join(newArtifactsDir, path.basename(nestedSessionFile));
			expect(manager.getJob(jobId)?.linkPath).toBe(movedNestedSessionFile);
			expect(nestedRef.sessionFile).toBe(movedNestedSessionFile);
			expect(childManager.getSessionFile()).toBe(movedNestedSessionFile);

			childManager.appendMessage({ role: "user", content: "after move", timestamp: 2 });
			await childManager.flush();
			expect(fs.existsSync(movedNestedSessionFile)).toBe(true);
			expect(fs.existsSync(nestedSessionFile)).toBe(false);
		} finally {
			await childManager.close();
			await session.dispose();
		}
	});
});
