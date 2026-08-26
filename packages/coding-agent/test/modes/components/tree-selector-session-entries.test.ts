import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const timestamp = "2026-08-06T00:00:00.000Z";

function makeEntries(): SessionEntry[] {
	return [
		{
			type: "title_change",
			id: "title",
			parentId: null,
			timestamp,
			title: "Renamed session",
			source: "auto",
		},
		{
			type: "mode_change",
			id: "mode",
			parentId: "title",
			timestamp,
			mode: "plan",
		},
		{
			type: "reset_boundary",
			id: "reset",
			parentId: "mode",
			timestamp,
		},
		{
			type: "service_tier_change",
			id: "tier",
			parentId: "reset",
			timestamp,
			serviceTier: { openai: "priority" },
		},
		{
			type: "session_init",
			id: "init",
			parentId: "tier",
			timestamp,
			systemPrompt: "System prompt",
			task: "Investigate the tree",
			tools: ["read"],
			agent: "scout",
		},
		{
			type: "ttsr_injection",
			id: "ttsr",
			parentId: "init",
			timestamp,
			injectedRules: ["review-rule"],
		},
		{
			type: "credential_pin",
			id: "credential",
			parentId: "ttsr",
			timestamp,
			provider: "anthropic",
			hash: "secret-hash",
		},
	];
}

function chain(entries: SessionEntry[]): SessionTreeNode[] {
	let child: SessionTreeNode | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		child = { entry: entries[index], children: child ? [child] : [] };
	}
	return child ? [child] : [];
}

function render(entries: SessionEntry[], filter: "default" | "all"): string {
	const selector = new TreeSelectorComponent(
		chain(entries),
		entries.at(-1)?.id ?? null,
		80,
		() => {},
		() => {},
		undefined,
		filter,
	);
	return Bun.stripANSI(selector.render(160).join("\n"));
}

describe("TreeSelectorComponent session entry rendering", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders informative rows for every SessionEntry variant in the all filter", () => {
		const output = render(makeEntries(), "all");

		expect(output).toContain("[title: Renamed session]");
		expect(output).toContain("[mode: plan]");
		expect(output).toContain("[reset]");
		expect(output).toContain("[service tier: openai=priority]");
		expect(output).toContain("[session init: scout] Investigate the tree");
		expect(output).toContain("[ttsr: review-rule]");
		expect(output).toContain("[credential pin: anthropic]");
		expect(output).not.toContain("secret-hash");
	});

	it("hides bookkeeping entries by default while keeping reset boundaries visible", () => {
		const output = render(makeEntries(), "default");

		expect(output).toContain("[reset]");
		expect(output).not.toContain("[title:");
		expect(output).not.toContain("[mode:");
		expect(output).not.toContain("[service tier:");
		expect(output).not.toContain("[session init:");
		expect(output).not.toContain("[ttsr:");
		expect(output).not.toContain("[credential pin:");
	});
});
