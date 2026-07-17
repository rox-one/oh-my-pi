/**
 * Regression (issue #5892): a mid-session `xd://` mount delta is tool-state,
 * not a prompt. It must reach the model as passive context and NEVER force an
 * unsolicited assistant turn. Before the fix, `#notifyXdevMountDelta` steered
 * the hidden `xdev-mount-notice` onto the turn-forcing steering queue; a mount
 * that happened while the assistant was still replying was then picked up by
 * the agent loop's stop-boundary steering poll and started a second, unsolicited
 * provider request.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

function createBasicTool(name: string, label: string): AgentTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("xdev mount notice must not trigger a second turn (#5892)", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	let tempDir: TempDir;
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await tempDir?.remove();
	});

	it("does not start an unsolicited turn when an xd:// device mounts mid-reply", async () => {
		tempDir = TempDir.createSync("@pi-xdev-5892-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		// The first turn parks open (via an async generator that awaits `mountDone`)
		// so the mid-turn mount is sequenced while the assistant is genuinely
		// streaming — no wall-clock timing.
		const streamStarted = Promise.withResolvers<void>();
		const mountDone = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: (async function* () {
				streamStarted.resolve();
				await mountDone.promise;
				yield { content: ["first reply"], stopReason: "stop" };
				yield { content: ["second unsolicited reply"], stopReason: "stop" };
			})(),
		});
		const readTool = createBasicTool("read", "Read");
		const writeTool = createBasicTool("write", "Write");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[writeTool.name, writeTool],
		]);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [readTool, writeTool] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			builtInToolNames: ["read", "write"],
			ensureWriteRegistered: async () => true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
			xdevRegistry: new XdevRegistry([]),
		});
		sessions.push(session);

		// A normal user turn begins streaming.
		const running = session.prompt("hey");
		await streamStarted.promise;

		// Mid-reply: an MCP tool becomes available and mounts as an xd:// device.
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([search]);
		// The mount is folded into the next real turn as passive context, never
		// onto the turn-forcing steering queue.
		expect(
			session.agent.peekSteeringQueue().some(msg => msg.role === "custom" && msg.customType === "xdev-mount-notice"),
		).toBe(false);

		mountDone.resolve();
		await running;
		await session.waitForIdle();

		// Exactly one provider request — the hidden notice did not spawn a second.
		expect(mock.calls.length).toBe(1);
	});
});
