import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { sumSubagentCost } from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentKind } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

beforeAll(async () => {
	await initTheme();
});

function ctxWith(subagentCost: number): SegmentContext {
	return { subagentCost } as unknown as SegmentContext;
}

// ANSI is irrelevant to the amount; strip it before asserting the number.
function plain(text: string): string {
	return stripVTControlCharacters(text);
}

function registerSub(registry: AgentRegistry, id: string, historyCost?: number): void {
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		session: null,
		...(historyCost === undefined
			? {}
			: { history: { metrics: { tokens: 0, requests: 0, tools: 0, cost: historyCost, durationMs: 0 } } }),
	});
}

function observedWithCost(id: string, cost: number): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		status: "active",
		lastUpdate: 0,
		progress: { cost } as ObservableSession["progress"],
	};
}

describe("subagent_cost status-line segment", () => {
	it("is hidden at zero cost", () => {
		const result = renderSegment("subagent_cost", ctxWith(0));
		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("is hidden when the cost is not finite", () => {
		for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const result = renderSegment("subagent_cost", ctxWith(cost));
			expect(result.visible).toBe(false);
			expect(result.content).toBe("");
		}
	});

	it("renders the agents icon and a two-decimal dollar amount", () => {
		const result = renderSegment("subagent_cost", ctxWith(1.234));
		expect(result.visible).toBe(true);
		const expected = theme.icon.agents ? `${theme.icon.agents} $1.23` : "$1.23";
		expect(plain(result.content)).toBe(expected);
	});
});

describe("sumSubagentCost", () => {
	it("prefers live observer progress over persisted history for the same agent", () => {
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", 5);
		expect(sumSubagentCost(registry, [observedWithCost("Worker", 1.5)])).toBe(1.5);
	});

	it("falls back to persisted history when no live progress exists", () => {
		const registry = new AgentRegistry();
		registerSub(registry, "Done", 2.5);
		expect(sumSubagentCost(registry, [])).toBe(2.5);
	});

	it("sums live and historical costs across agents", () => {
		const registry = new AgentRegistry();
		registerSub(registry, "Live", 5);
		registerSub(registry, "Done", 2.5);
		expect(sumSubagentCost(registry, [observedWithCost("Live", 1.5)])).toBe(4);
	});

	it("ignores refs that are not subagents", () => {
		const registry = new AgentRegistry();
		for (const kind of ["main", "advisor"] satisfies AgentKind[]) {
			registry.register({
				id: `NotSub-${kind}`,
				displayName: kind,
				kind,
				session: null,
				history: { metrics: { tokens: 0, requests: 0, tools: 0, cost: 9, durationMs: 0 } },
			});
		}
		expect(sumSubagentCost(registry, [])).toBe(0);
	});

	it("ignores non-finite costs from both live progress and history", () => {
		const registry = new AgentRegistry();
		registerSub(registry, "NaNHistory", Number.NaN);
		registerSub(registry, "NaNLive");
		expect(sumSubagentCost(registry, [observedWithCost("NaNLive", Number.NaN)])).toBe(0);
	});
});
