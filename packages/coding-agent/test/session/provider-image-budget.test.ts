import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-kimi-k2.7",
	name: "umans-kimi-k2.7",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

describe("provider context image budgets", () => {
	it("drops oldest transient images above the active provider cap", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("first text"), ...Array.from({ length: 8 }, (_, index) => image(`user-${index}`))],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "inspect_image",
					content: [text("tool text"), ...Array.from({ length: 8 }, (_, index) => image(`tool-${index}`))],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual([
			"user-6",
			"user-7",
			"tool-0",
			"tool-1",
			"tool-2",
			"tool-3",
			"tool-4",
			"tool-5",
			"tool-6",
			"tool-7",
		]);
		expect(clamped.messages[0]?.content).toContainEqual(text("first text"));
		expect(clamped.messages[1]?.content).toContainEqual(text("tool text"));
		expect(clamped).not.toBe(context);
		expect(context.messages[0]?.content).toContainEqual(image("user-0"));
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`img-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});
});
