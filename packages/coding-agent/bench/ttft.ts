/**
 * TTFT (time-to-first-token) benchmark for the coding agent.
 *
 * Measures the in-process latency a user feels between pressing Enter on a chat
 * message and the first streamed model text/thinking appearing — the "Working…"
 * gap. The LLM transport is replaced with a mock streamFn that emits one token
 * immediately (delayMs: 0), so the measured time is PURE controllable overhead:
 *
 *   AgentSession.#promptWithMessage preflight  (getApiKey, system-prompt build,
 *                                               before_agent_start hook, token
 *                                               estimation, compaction check …)
 *   + agent-loop streamAssistantResponse preflight (convertToLlm, normalizeTools,
 *                                               context build, telemetry …)
 *   + stream dispatch + event surfacing back to session listeners
 *
 * Out of scope (uncontrollable / network): real network TTFT/TLS, and the
 * opt-in `auto`-thinking classifier round-trip (only active when the user
 * selects the `auto` thinking selector). They bound this metric from above in
 * production; this benchmark isolates the code we can actually optimize.
 *
 * Run: bun packages/coding-agent/bench/ttft.ts
 */
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic workload fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT = "Look at the recent code review comments on my open PRs and fix the issues.";

const RESPONSE_TEXT = "I'll start by checking the open pull requests for review comments.";

const MODEL: Model = (() => {
	const m = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!m) throw new Error("claude-sonnet-4-5 missing from bundled catalog");
	return m;
})();

// A realistic multi-section system prompt (a few KB) so per-turn system-prompt
// handling processes representative bytes.
const SYSTEM_PROMPT: string[] = [
	"# Role",
	"You are a senior software engineer pair programmer operating inside a terminal coding agent.",
	"Be terse, evidence-first, and concrete. Every claim about code must be grounded.",
	"",
	"# Tools",
	"You have tools for reading files, editing, running shell commands, searching, and more.",
	"Prefer the narrowest tool. Never guess at file contents — read first.",
	"",
	"# Principles",
	"- Optimize for correctness first, then for the next maintainer.",
	"- Fix problems at the source; remove obsolete code.",
	"- Reuse existing patterns; a second convention beside an existing one is prohibited.",
	"- Never yield non-trivial work without proof: tests, E2E, or QA.",
	"- Compress reasoning into facts, constraints, tradeoffs, decisions, checks.",
	"",
	"# Workflow",
	"1. Scope: read relevant skills and existing conventions before touching files.",
	"2. Research: read sections, not snippets; run references before modifying exported symbols.",
	"3. Decompose: update todos; default to parallel for complex changes.",
	"4. Implement: fix at the source; prefer updating existing files over creating new ones.",
	"5. Verify: run the specific test that covers your change; test behavior not plumbing.",
	"6. Cleanup: changelog, tests, removing scaffolding — last, gated on the request working.",
];

// ~30 tools with realistic object schemas so normalizeTools' per-turn schema
// serialization (a flagged deferrable cost) is exercised at production scale.
function makeTool(i: number): AgentTool {
	return {
		name: `tool_${i}`,
		label: `Tool ${i}`,
		description: `Deterministic benchmark tool number ${i}. Exercises per-turn tool-schema normalization with a representative object schema and a multi-sentence description so the measured cost reflects a real tool registry rather than an empty one.`,
		parameters: type({
			target: "string",
			query: "string",
			content: "string",
			"offset?": "number",
			"limit?": "number",
			"createDirs?": "boolean",
			"encoding?": "string",
		}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}
const TOOLS: AgentTool[] = Array.from({ length: 30 }, (_, i) => makeTool(i));

// Warm-history fixture: a mid-conversation state (3 user + 3 assistant turns)
// so the steady-state costs the user feels — last-assistant compaction check,
// history conversion, and token estimation — are exercised, not just the empty
// first-prompt floor.
function buildWarmHistory(): AgentMessage[] {
	const history: AgentMessage[] = [];
	const userTexts = [
		"Can you summarize the architecture of the agent runtime package?",
		"How does the streaming pipeline decode the first token from the provider?",
		"What runs between submitting a message and the model's first token?",
	];
	const assistantTexts = [
		"The agent runtime exposes a turn entrypoint that builds provider context, fires the LLM stream, and forwards deltas as events. Context assembly, tool normalization, and API-key resolution all happen before the first byte.",
		"The streaming client decodes SSE incrementally: each blank-line boundary yields one event, which is JSON-parsed and mapped to a content delta. There is no buffering for a full object — the first delta is emitted as soon as a complete SSE event arrives.",
		"Between submit and first token: the session validates the API key, may run a pre-prompt compaction check, builds the system prompt, resolves file mentions, then the agent loop converts messages, normalizes tools, builds context, and finally fires the request.",
	];
	const baseUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (let i = 0; i < userTexts.length; i++) {
		const u: UserMessage = { role: "user", content: userTexts[i], timestamp: 1_700_000_000_000 + i };
		const a: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: assistantTexts[i] }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL.id,
			usage: baseUsage,
			stopReason: "stop",
			timestamp: 1_700_000_000_000 + i + 1,
		};
		history.push(u, a);
	}
	return history;
}
const WARM_HISTORY = buildWarmHistory();

// ─────────────────────────────────────────────────────────────────────────────
// Measurement
// ─────────────────────────────────────────────────────────────────────────────

interface TurnLatency {
	ttft: number;
	preflight: number;
}

interface BenchDeps {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
}

/**
 * One measured turn. Construction happens before the timer starts, so only the
 * `prompt() → first non-empty assistant text/thinking delta` span is measured.
 * `preflight` is the split from prompt-entry to the moment the agent loop first
 * invokes the transport (the most directly controllable component).
 */
async function measureOnce(deps: BenchDeps, seedHistory: AgentMessage[] | null): Promise<TurnLatency> {
	const marker = { calledAt: 0 };
	const mock = createMockModel({ responses: [{ content: [RESPONSE_TEXT] }] });
	const innerStream = mock.stream;
	const streamFn: StreamFn = (...args) => {
		marker.calledAt = performance.now();
		return innerStream(...args);
	};

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: MODEL,
			systemPrompt: SYSTEM_PROMPT,
			tools: TOOLS,
			messages: seedHistory ? [...seedHistory] : [],
		},
		streamFn,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: deps.settings,
		modelRegistry: deps.modelRegistry,
	});

	const { promise: firstDelta, resolve: onFirstDelta } = Promise.withResolvers<number>();
	let settled = false;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (settled) return;
		if (event.type !== "message_update") return;
		if (event.message.role !== "assistant") return;
		const inner = event.assistantMessageEvent;
		if ((inner.type === "text_delta" || inner.type === "thinking_delta") && inner.delta.length > 0) {
			settled = true;
			onFirstDelta(performance.now());
		}
	});

	forceGc();
	const t0 = performance.now();
	const promptP = session.prompt(PROMPT);
	try {
		const TTFT_TIMEOUT_MS = 15_000;
		const timeout = Bun.sleep(TTFT_TIMEOUT_MS).then(() => {
			throw new Error("ttft measurement timed out");
		});
		const ttft = await Promise.race([
			firstDelta,
			promptP.then(() => Promise.reject(new Error("turn finished with no assistant text delta"))),
			timeout,
		]);
		await promptP;
		return { ttft: ttft - t0, preflight: marker.calledAt > 0 ? marker.calledAt - t0 : Number.NaN };
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

function median(samples: number[]): number {
	if (samples.length === 0) return Number.NaN;
	const s = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(samples: number[], p: number): number {
	if (samples.length === 0) return Number.NaN;
	const s = [...samples].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
	return s[idx];
}

function minimum(samples: number[]): number {
	if (samples.length === 0) return Number.NaN;
	let m = samples[0];
	for (let i = 1; i < samples.length; i++) {
		if (samples[i] < m) m = samples[i];
	}
	return m;
}

function forceGc(): void {
	// Flush per-iteration construction garbage so major-GC pauses don't pollute
	// the measured turn (observed: p90 10-26ms vs a ~0.3ms intrinsic floor).
	if (typeof Bun.gc === "function") Bun.gc(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const WARMUP_ITERATIONS = 12;
const MEASURED_ITERATIONS = 60;

interface ScenarioResult {
	ttfts: number[];
	preflights: number[];
}

async function runScenario(
	name: string,
	deps: BenchDeps,
	seedHistory: AgentMessage[] | null,
): Promise<ScenarioResult> {
	for (let i = 0; i < WARMUP_ITERATIONS; i++) {
		await measureOnce(deps, seedHistory);
	}
	const ttfts: number[] = [];
	const preflights: number[] = [];
	for (let i = 0; i < MEASURED_ITERATIONS; i++) {
		const r = await measureOnce(deps, seedHistory);
		ttfts.push(r.ttft);
		preflights.push(r.preflight);
	}
	const ttftMed = median(ttfts);
	console.error(
		`[ttft:bench] ${name}: ttft min=${minimum(ttfts).toFixed(3)} p10=${percentile(ttfts, 0.1).toFixed(3)} p50=${ttftMed.toFixed(3)} p90=${percentile(ttfts, 0.9).toFixed(3)} ms | preflight min=${minimum(preflights).toFixed(3)} p50=${median(preflights).toFixed(3)} ms`,
	);
	return { ttfts, preflights };
}

async function main(): Promise<void> {
	const tempDir = TempDir.createSync("@pi-ttft-bench-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const deps: BenchDeps = { authStorage, modelRegistry, settings };

	try {
		const cold = await runScenario("cold (empty session)", deps, null);
		const warm = await runScenario("warm (mid-conversation)", deps, WARM_HISTORY);

		// Primary metric: warm-scenario MINIMUM time-to-first-token. The minimum is
		// the most reproducible estimate of the intrinsic in-process cost (least
		// affected by GC/scheduling interference) and the most sensitive to real
		// code changes that remove per-turn work. Lower is better.
		console.log(`METRIC ttft_ms=${minimum(warm.ttfts).toFixed(4)}`);
		console.log(`METRIC ttft_cold_ms=${minimum(cold.ttfts).toFixed(4)}`);
		console.log(`METRIC preflight_ms=${minimum(warm.preflights).toFixed(4)}`);
		console.log(`METRIC preflight_cold_ms=${minimum(cold.preflights).toFixed(4)}`);
		console.log(`METRIC ttft_warm_p50_ms=${median(warm.ttfts).toFixed(4)}`);
	} finally {
		authStorage.close();
		tempDir.removeSync();
	}
}

await main();
