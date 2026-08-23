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
});
