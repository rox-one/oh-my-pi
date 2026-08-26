import { describe, expect, it } from "bun:test";
import { parseSSE, redactUrlForLog } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";
import { MCPRequestError, toJsonRpcError } from "@oh-my-pi/pi-coding-agent/mcp/types";

describe("redactUrlForLog", () => {
	it("redacts credential-bearing query params but keeps the rest", () => {
		const redacted = redactUrlForLog("https://mcp.exa.ai/mcp?exaApiKey=sk-secret-123&foo=bar");
		expect(redacted).not.toContain("sk-secret-123");
		expect(redacted).toContain("foo=bar");
		expect(redacted).toContain("https://mcp.exa.ai/mcp");
	});

	it("drops the query string entirely for unparseable URLs", () => {
		expect(redactUrlForLog("not a url?apiKey=zzz")).toBe("not a url");
	});
});

describe("parseSSE", () => {
	it("skips non-JSON data lines (keep-alives) and returns the first JSON payload", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("returns null when nothing parses", () => {
		expect(parseSSE("data: ping\nnot json either")).toBeNull();
	});
});

describe("toJsonRpcError", () => {
	it("does not serialize arbitrary thrown object data", () => {
		const error = toJsonRpcError({ code: -32042, message: "elicitation required", data: { secret: "do-not-send" } });

		expect(error).toEqual({ code: -32042, message: "elicitation required" });
		expect(error).not.toHaveProperty("data");
	});

	it("preserves data only for MCPRequestError", () => {
		const data = { elicitations: [{ mode: "url", elicitationId: "id-1" }] };

		expect(toJsonRpcError(new MCPRequestError({ code: -32042, message: "elicitation required", data }))).toEqual({
			code: -32042,
			message: "MCP error -32042: elicitation required",
			data,
		});
	});
});
