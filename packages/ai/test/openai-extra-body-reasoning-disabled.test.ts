import { describe, expect, it } from "bun:test";
import { applyOpenAIExtraBody } from "@oh-my-pi/pi-ai/providers/openai-shared";

describe("applyOpenAIExtraBody reasoningDisabled", () => {
	it("strips only reasoning-only keys, preserving unrelated extraBody fields", () => {
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { thinking: { type: "enabled" }, provider: { order: ["foo"] } }, {
			reasoningDisabled: true,
		});

		expect(params.thinking).toBeUndefined();
		expect(params.provider).toEqual({ order: ["foo"] });
	});

	it("merges the full extraBody blob (including reasoning keys) when reasoningDisabled is not set", () => {
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { thinking: { type: "enabled" }, provider: { order: ["foo"] } });

		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.provider).toEqual({ order: ["foo"] });
	});

	it("strips top-level dialect toggles that could re-enable reasoning after the disabled encoding", () => {
		// Reproduces the reported Qwen payload: the encoder already wrote
		// `chat_template_kwargs.enable_thinking: false` for the disabled turn,
		// but a caller-supplied extraBody carrying `enable_thinking: true` and
		// `reasoning_effort` must not survive the merge and flip it back on.
		// Unrelated gateway-routing fields (`gateway`) must still pass through.
		const params: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } };
		applyOpenAIExtraBody(
			params,
			{ enable_thinking: true, reasoning_effort: "high", reasoning: { effort: "high" }, gateway: "route-a" },
			{ reasoningDisabled: true },
		);

		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.reasoning).toBeUndefined();
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(params.gateway).toBe("route-a");
	});

	it("does not treat inherited Object.prototype members as reasoning keys", () => {
		// A plain-object index (`REASONING_ONLY_EXTRA_BODY_KEYS[key]`) would read
		// `constructor`/`toString` off the prototype chain as truthy and silently
		// drop them even though they are not reasoning controls; the Set-backed
		// lookup must only match the explicit reasoning-control key list.
		const params: Record<string, unknown> = {};
		applyOpenAIExtraBody(params, { constructor: "keep-me", toString: "also-keep", thinking: { type: "enabled" } }, {
			reasoningDisabled: true,
		});

		expect(params["constructor"]).toBe("keep-me");
		expect(params["toString"]).toBe("also-keep");
		expect(params.thinking).toBeUndefined();
	});
});