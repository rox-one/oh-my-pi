import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for #2257: prior assistant turns from an `anthropic-messages`
 * source must keep their thinking chain when the next request also targets
 * `anthropic-messages`, even across model/provider boundaries. The previous
 * logic only honored this for the latest assistant turn, demoting every
 * earlier `thinking` block to plain `text` and dropping every
 * `redactedThinking` whenever the conversation crossed provider/model lines —
 * a violation of Anthropic's all-or-none thinking-block contract and a loss
 * of reasoning context for compatible reasoning endpoints (DeepSeek,
 * Z.AI, custom anthropic-messages providers configured via `models.yaml`).
 */
function makeAnthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
interface WireRedactedBlock {
	type: "redacted_thinking";
	data: string;
}
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock =
	| WireThinkingBlock
	| WireTextBlock
	| WireRedactedBlock
	| WireToolUseBlock
	| { type: string; [key: string]: unknown };

describe("Anthropic prior-turn thinking preservation (#2257)", () => {
	it("preserves prior assistant thinking when crossing models on the same compatible endpoint", () => {
		// Conversation history was produced by `reasoning-model-v1`; the next
		// request targets `reasoning-model-v2` on the same anthropic-messages
		// custom provider. The first assistant turn is PRIOR (there is a later
		// assistant turn from v2), so the latest-only preservation path doesn't
		// help — without the fix the prior thinking block is demoted to text.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const priorThinkingText = "Plan: read README, then summarize.";
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: priorThinkingText, thinkingSignature: "sig_v1" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Got the body, now translating", thinkingSignature: "sig_v2" },
					{ type: "text", text: "Voici le résumé en français." },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Now translate it to Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(2);
		const priorBlocks = assistants[0].content as WireBlock[];
		// The prior thinking block must survive as a `thinking` block (not be
		// silently downgraded to `text`). Cross-model signatures are stripped so
		// the downstream emits unsigned thinking, which compatible reasoning
		// endpoints (`replayUnsignedThinking: true`) accept on continuation.
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking).toBeDefined();
		expect(thinking?.thinking).toBe(priorThinkingText);
		expect(thinking?.signature).toBe("");
		// And the paired tool_use must still be present right after it.
		const toolUse = priorBlocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe("toolu_prior");
	});

	it("keeps the signature on prior turns when the source model matches the target", () => {
		// Same provider+api+id throughout: signatures are valid and must ride
		// the wire untouched (prompt-cache stability + Anthropic's all-or-none
		// invariant).
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant([
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig_same" },
				{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "summarising", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("And now in Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("plan");
		expect(thinking?.signature).toBe("sig_same");
	});

	it("preserves redacted_thinking blocks from prior anthropic-messages turns", () => {
		// Anthropic's "include ALL thinking blocks (including redacted ones)"
		// rule means redacted_thinking from earlier turns must survive whenever
		// we replay any thinking content from the same turn.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig" },
					{ type: "redactedThinking", data: "encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "later", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const redacted = priorBlocks.find(b => b.type === "redacted_thinking") as WireRedactedBlock | undefined;
		expect(redacted).toBeDefined();
		expect(redacted?.data).toBe("encrypted-blob");
	});

	it("does not promote prior unsigned thinking from non-anthropic sources to thinking blocks", () => {
		// Cross-API replay: prior turn came from OpenAI-responses with no
		// Anthropic signature. The all-or-none rule scope is per-API; we must
		// not invent thinking blocks for a turn whose source can't sign them —
		// the existing cross-API text demotion is the right behavior.
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "openai chain-of-thought", thinkingSignature: "" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{
					api: "openai-responses",
					provider: "openai",
					model: "o1-preview",
				} as Partial<AssistantMessage>,
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
		// Reasoning text still survives on the wire (as text, via the existing
		// cross-API demotion path).
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe("openai chain-of-thought");
	});
});
