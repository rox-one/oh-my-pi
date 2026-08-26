import { describe, expect, test } from "bun:test";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type } from "arktype";

/**
 * Regression coverage for #5918: the built-in `task` tool declares
 * `outputSchema` as `z.unknown()`, which the wire pipeline emits as `{}` and
 * then widens to boolean `true` (#1179). Moonshot's MFJS validator — reached
 * both natively and through OpenRouter's Kimi routing — rejects boolean
 * subschemas with HTTP 400. The Responses transport must run MFJS
 * normalization so `outputSchema` serializes as `{}` again.
 */

// OpenRouter dispatches to the Responses handler at runtime with exactly this
// cast (see `stream.ts` `case "openrouter"`), so the test mirrors it.
function kimiViaOpenRouterModel(): Model<"openai-responses"> {
	return buildModel({
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 128000,
	} as ModelSpec<"openrouter">) as unknown as Model<"openai-responses">;
}

function openaiModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	} as ModelSpec<"openai-responses">);
}

const taskTool: Tool = {
	name: "task",
	description: "Spawn subagent tasks.",
	parameters: type({
		tasks: type({
			task: "string",
			"outputSchema?": "unknown",
		}).array(),
	}),
};

function outputSchemaNode(tools: unknown): unknown {
	const [tool] = tools as Array<{
		parameters: { properties: { tasks: { items: { properties: { outputSchema?: unknown } } } } };
	}>;
	return tool.parameters.properties.tasks.items.properties.outputSchema;
}

describe("Moonshot MFJS on the Responses transport (#5918)", () => {
	test("resolves toolSchemaFlavor for Kimi routed via OpenRouter", () => {
		expect(kimiViaOpenRouterModel().compat.toolSchemaFlavor).toBe("moonshot-mfjs");
	});

	test("emits `{}` for a `z.unknown()` outputSchema instead of boolean `true`", () => {
		const node = outputSchemaNode(convertTools([taskTool], false, kimiViaOpenRouterModel()));
		expect(node).toEqual({});
	});

	test("leaves the widened boolean subschema untouched on non-Moonshot hosts", () => {
		expect(openaiModel().compat.toolSchemaFlavor).toBeUndefined();
		// Without MFJS gating the schema keeps the #1179 widening (`{}` -> `true`),
		// proving the coercion is flag-gated to Moonshot flavor.
		const node = outputSchemaNode(convertTools([taskTool], false, openaiModel()));
		expect(node).toBe(true);
	});
});
