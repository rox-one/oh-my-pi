/**
 * MCP result details must describe the response, not copy it (issue #9646).
 *
 * The production result keeps payload bytes in `content`. This test exercises
 * the compact metadata builder used by its details envelope.
 */
import { describe, expect, it } from "bun:test";
import { summarizeMCPContent } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPContent, MCPImageContent } from "@oh-my-pi/pi-coding-agent/mcp/types";

describe("MCP result envelope", () => {
	it("describes each block instead of duplicating its payload", () => {
		const text = "ledger row 4181: reconciled";
		const image: MCPImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
		const content: MCPContent[] = [{ type: "text", text }, image];

		const details = { contentBlocks: summarizeMCPContent(content) };

		expect(details.contentBlocks).toEqual([
			{ type: "text", bytes: Buffer.byteLength(text, "utf8") },
			{ type: "image", bytes: image.data.length, mimeType: "image/png" },
		]);
		// No copy of either payload survives in the compact envelope.
		const serializedDetails = JSON.stringify(details);
		expect(serializedDetails).not.toContain(text);
		expect(serializedDetails).not.toContain(image.data);
	});

	it("keeps resource identity without copying its text", () => {
		const resourceText = "# Report\nbody";
		const content: MCPContent[] = [
			{
				type: "resource",
				resource: { uri: "file:///tmp/report.md", mimeType: "text/markdown", text: resourceText },
			},
		];

		const details = { contentBlocks: summarizeMCPContent(content) };

		expect(details.contentBlocks).toEqual([
			{
				type: "resource",
				bytes: Buffer.byteLength(resourceText, "utf8"),
				mimeType: "text/markdown",
				uri: "file:///tmp/report.md",
			},
		]);
		expect(JSON.stringify(details)).not.toContain(resourceText);
	});
});
