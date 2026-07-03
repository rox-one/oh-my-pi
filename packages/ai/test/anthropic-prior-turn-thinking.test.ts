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

	it("drops prior redacted_thinking when unsigned thinking is demoted to text", () => {
		// Official Anthropic targets do not replay unsigned thinking natively.
		// Once a cross-model prior turn's visible thinking signature is stripped,
		// that thinking becomes text on the wire; the redacted sibling must not
		// remain as a lone native redacted_thinking block.
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig_custom" },
					{ type: "redactedThinking", data: "foreign-encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "official latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe("visible reasoning");
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(priorBlocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
	});

	it("demotes invalid official Anthropic prior signatures to Fable markdown prose after a model switch", () => {
		// official Anthropic → official Fable, with the signed turn no longer
		// latest. The source signature is bound to the issuing Anthropic model,
		// so replaying it after the switch must not emit native thinking or
		// Anthropic/Kimi-style thinking tags that Fable treats as visible text.
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-fable-5",
			name: "Claude Fable 5",
			baseUrl: "https://api.anthropic.com",
		});
		const reasoning = "Need to preserve the plan while switching models.";
		const messages: Message[] = [
			makeUser("Read the project notes"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: "sig_sonnet" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "NOTES.md" } },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			),
			toolResult("toolu_prior", "notes body"),
			makeAssistant([{ type: "text", text: "I found the relevant notes." }], {
				provider: "anthropic",
				model: "claude-fable-5",
				stopReason: "stop",
			}),
			makeUser("Continue from those notes."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(2);
		const priorBlocks = assistants[0].content as WireBlock[];
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking("claude-fable-5", reasoning));
		expect(text?.text).toBe(reasoning);
		expect(text?.text).not.toContain("<thinking>");
		expect(text?.text).not.toContain("</thinking>");
		expect(text?.text).not.toContain("<think>");
		expect(text?.text).not.toContain("</think>");
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
	});

	it("does not demote same-model official Anthropic unsigned thinking to text", () => {
		// Same-model Anthropic replay is not a dialect transition. If a committed
		// tool-use turn lacks a usable thinking signature, the native thinking block
		// is unreplayable, but serializing it as target-dialect text would
		// incorrectly apply the cross-model fallback intended for real transitions.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "anthropic",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.anthropic.com",
			});
			const reasoning = `Need to inspect the layout before editing with ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: "" },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "anthropic", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target, false);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops same-model Anthropic thinking blocks with undefined signatures (regression test for 018b3dc61, restoring 93996bc48)", () => {
		// Regression: commit 018b3dc61 narrowed the drop guard to catch only
		// empty-string signatures, but same-model thinking blocks from aborted
		// or prior turns may have undefined signatures (marked by the
		// untrustworthy-turn recovery at :410-414). These must also be dropped,
		// not demoted to text, because demotion triggers the reasoning_extraction
		// safety classifier and causes hard refusals from Fable 5 and Opus 4.8.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "anthropic",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.anthropic.com",
			});
			const reasoning = `Internal reasoning that should not leak for ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: undefined },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "anthropic", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target, false);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			// Must not produce a native thinking block
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			// Must not demote to text (neither <thinking> tags nor plain text containing the reasoning)
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			// Tool call must still be present
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops redacted siblings when same-model abandoned-tool-use thinking is discarded", () => {
		// Abandoned tool-use turns strip every thinking signature before replay.
		// If the same-model signing-target guard then drops that visible
		// thinking block, its redacted sibling must be dropped too; replaying a
		// lone `redacted_thinking` block violates Anthropic's all-thinking-blocks
		// contract for that assistant turn.
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const toolCallId = "toolu_abandoned";
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Private discarded reasoning.", thinkingSignature: "sig_dropped" },
					{ type: "redactedThinking", data: "encrypted-sibling" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
				],
				{
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			toolResult(toolCallId, "view body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Later signed reasoning.", thinkingSignature: "sig_latest" },
					{ type: "text", text: "Done." },
				],
				{
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(blocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
		const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
		expect(textBlocks).toHaveLength(0);
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe(toolCallId);
	});

	it("drops same-model unsigned thinking when the runtime clone flips signingEndpoint after a signing 400 (#4428 review)", () => {
		// When `buildParams` detects a signing proxy at runtime (via the `400
		// Invalid signature in thinking block` retry path), it clones the model
		// compat with `replayUnsignedThinking: false` AND `signingEndpoint: true`.
		// The `signingEndpoint` flip is load-bearing: without it,
		// `transformMessages` would keep the unsigned block, then
		// `convertAnthropicMessages` would demote it to text via
		// `renderDemotedThinking`, leaking the private reasoning as visible
		// assistant prose and adding cumulative `reasoning_extraction` heat
		// on Claude targets. This test pins the drop behavior against the
		// effective (runtime-cloned) compat shape.
		// Mirror the exact clone shape produced by `buildParams` when the
		// signing 400 fires: preserve every resolved compat field, then flip
		// `replayUnsignedThinking → false` and `signingEndpoint → true`.
		// `signingEndpoint` is a *resolved* field (not part of the sparse
		// `AnthropicCompat` override), so this cannot be expressed through
		// `buildModel({ compat: … })`; the post-override cast is the same
		// pattern `buildParams` uses at runtime.
		const base = makeAnthropicModel({
			provider: "custom-anthropic",
			id: "reasoning-model",
			baseUrl: "https://opencode.cloudflare.dev/anthropic",
		});
		const target: Model<"anthropic-messages"> = {
			...base,
			compat: { ...base.compat, replayUnsignedThinking: false, signingEndpoint: true },
		};
		const reasoning = "Private reasoning that must not leak after auto-mark.";
		const toolCallId = "toolu_autopin";
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: undefined },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
				],
				{},
			),
			toolResult(toolCallId, "view body"),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		// Native thinking dropped, no demoted-text carrier, tool call preserved.
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
		expect(textBlocks).toHaveLength(0);
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe(toolCallId);
	});

	it("strips official Anthropic source signatures on cross-model replay to a 3p target", () => {
		// official Anthropic → 3p. Anthropic's signature is bound to the
		// issuing model+session, so the 3p target cannot reverify or
		// meaningfully continue from it; passing it through would leak
		// private continuation metadata for no benefit. The unsigned thinking
		// is still emitted natively because the 3p target's compat advertises
		// `replayUnsignedThinking: true`.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic reasoning", thinkingSignature: "sig_anthropic" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "v2 reasoning", thinkingSignature: "sig_v2" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("anthropic reasoning");
		expect(thinking?.signature).toBe("");
	});

	it("preserves prior unsigned thinking from non-anthropic sources on unsigned-replay targets", () => {
		// Anthropic-compatible targets that advertise `replayUnsignedThinking`
		// accept unsigned native thinking as their semantic-carry analogue.
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
