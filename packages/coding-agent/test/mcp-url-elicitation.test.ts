import { describe, expect, it, vi } from "bun:test";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";

const CONFIG: MCPServerConfig = { type: "stdio", command: "fake-mcp-server" };
const REQUEST = {
	mode: "url" as const,
	elicitationId: "elicitation-1",
	url: "https://gateway.example/authorize",
	message: "Authorize the gateway",
};

function fakeConnection(name: string): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		async request<T>(method: string): Promise<T> {
			if (method === "tools/list") return { tools: [] } as T;
			return {} as T;
		},
		async notify(): Promise<void> {},
		async close(): Promise<void> {
			transport.connected = false;
		},
	};
	return {
		name,
		config: CONFIG,
		transport,
		serverInfo: { name: "fake", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCP URL elicitation lifecycle", () => {
	it("deduplicates prompts by server and elicitation id", async () => {
		const manager = new MCPManager(process.cwd());
		const connection = fakeConnection("server");
		const prompt = Promise.withResolvers<{ action: "accept" }>();
		const prompts: Array<{ server: string; id: string }> = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (_name, _config, options) => {
			connection.transport.onNotification = options?.onNotification;
			return connection;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		manager.setUrlElicitationHandler(async (server, request) => {
			prompts.push({ server, id: request.elicitationId });
			return prompt.promise;
		});

		await manager.connectServers({ server: CONFIG }, {});
		const handler = connection.urlElicitationHandler;
		if (!handler) throw new Error("Expected URL elicitation handler");
		const first = handler("server", REQUEST);
		const second = handler("server", REQUEST);

		expect(first).toBe(second);
		expect(prompts).toEqual([{ server: "server", id: "elicitation-1" }]);
		prompt.resolve({ action: "accept" });
		await expect(first).resolves.toEqual({ action: "accept" });
	});

	it("consumes completion notifications that arrive before the waiter", async () => {
		const manager = new MCPManager(process.cwd());
		const connection = fakeConnection("server");
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (_name, _config, options) => {
			connection.transport.onNotification = options?.onNotification;
			return connection;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		await manager.connectServers({ server: CONFIG }, {});
		connection.transport.onNotification?.("notifications/elicitation/complete", { elicitationId: "early" });

		await expect(connection.waitForUrlElicitationCompletion?.("early")).resolves.toBeUndefined();
	});
});
