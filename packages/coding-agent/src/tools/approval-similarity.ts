/**
 * Similarity classifier for the "Approve Similar <tool> Commands for Session"
 * approval option: decides whether a pending tool call matches the subjects
 * the user already approved for that tool this session.
 *
 * Two backends, selected by `providers.approvalSimilarityModel`:
 *
 * - `online` (default): the TINY/smol role model classifies via
 *   {@link completeSimple}.
 * - a local key: the on-device memory model classifies via
 *   {@link tinyModelClient.complete} with an inline prompt.
 *
 * Fail-safe by contract: any error, timeout, abort, or unparsable output
 * resolves to `false` (the approval gate prompts again). Never throws.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import approvalSimilarityPrompt from "../prompts/system/approval-similarity.md" with { type: "text" };
import approvalSimilarityLocalPrompt from "../prompts/system/approval-similarity-local.md" with { type: "text" };
import { stripAnsi } from "../tiny/message-preproc";
import { isTinyMemoryLocalModelKey, isTinyMemoryReasoningModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";
import { getSimilarApprovals } from "./session-approvals";

const SIMILARITY_SYSTEM_PROMPT = prompt.render(approvalSimilarityPrompt);

/**
 * Hard bound on the whole classification: a stalled backend must not freeze
 * the approval prompt; the caller's abort signal is combined with it.
 */
const CLASSIFY_TIMEOUT_MS = 10_000;

/** Per-approved-subject character budget (head-truncated); keeps the classifier prompt small. */
const MAX_SUBJECT_CHARS = 160;
/** Budget for the pending call's subject — it deserves more context than one approved entry. */
const MAX_CANDIDATE_CHARS = 400;

/**
 * Local classifiers occasionally need more room for chat-template boilerplate.
 * OpenAI-compatible endpoints reject values below 16, so 16 is the smallest
 * portable budget for the non-reasoning answer.
 */
const ANSWER_MAX_TOKENS = 16;
/**
 * Reasoning-safe budget (online, and local reasoning models): sized to survive
 * backends that ignore `disableReasoning` — the yes/no keyword needs to land
 * after any unavoidable thinking preamble (issue #4355).
 */
const REASONING_SAFE_MAX_TOKENS = 1024;

export interface ApprovalSimilarityDeps {
	sessionId: string;
	toolName: string;
	/** Raw subject of the pending call — `approvalSubject(args)` output. */
	subject: string;
	settings: Settings;
	registry: ModelRegistry;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

/**
 * True when `deps.subject` is similar to a subject the user approved for
 * `deps.toolName` this session. With no recorded subjects (or an unknown
 * session) there is nothing to compare against: returns `false` without a
 * model call.
 */
export async function isSimilarToApprovedCommand(deps: ApprovalSimilarityDeps): Promise<boolean> {
	const approvedRaw = getSimilarApprovals(deps.sessionId, deps.toolName);
	const candidateRaw = stripAnsi(deps.subject).trim();
	if (approvedRaw.length === 0 || candidateRaw.length === 0) return false;

	const backend = deps.settings.get("providers.approvalSimilarityModel");
	const approved = approvedRaw.map(subject => boundedSubject(subject, MAX_SUBJECT_CHARS));
	const candidate = boundedSubject(candidateRaw, MAX_CANDIDATE_CHARS);
	const bounded: ApprovalSimilarityDeps = {
		...deps,
		signal: deps.signal
			? AbortSignal.any([deps.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)])
			: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
	};
	try {
		const similar =
			backend === ONLINE_MEMORY_MODEL_KEY
				? await classifyOnline(approved, candidate, bounded)
				: await classifyLocal(approved, candidate, backend, bounded);
		return similar ?? false;
	} catch (error) {
		logger.debug("approval-similarity: classification failed", {
			error: error instanceof Error ? error.message : String(error),
			backend,
		});
		return false;
	}
}

async function classifyOnline(
	approved: string[],
	candidate: string,
	deps: ApprovalSimilarityDeps,
): Promise<boolean | undefined> {
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		throw new Error("approval-similarity: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`approval-similarity: no API key for ${model.provider}/${model.id}`);
	}
	const metadata = deps.metadataResolver?.(model.provider);

	const response = await completeSimple(
		model,
		{
			systemPrompt: [SIMILARITY_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: `Approved commands:\n${approved.map(subject => `- ${subject}`).join("\n")}\n\nNew command:\n${candidate}`,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: deps.registry.resolver(model, deps.sessionId),
			maxTokens: REASONING_SAFE_MAX_TOKENS,
			disableReasoning: true,
			metadata,
			signal: deps.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`approval-similarity: online classification failed: ${response.errorMessage ?? "unknown error"}`);
	}

	const outputText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
	return parseApprovalSimilarity(outputText);
}

async function classifyLocal(
	approved: string[],
	candidate: string,
	modelKey: string,
	deps: ApprovalSimilarityDeps,
): Promise<boolean | undefined> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`approval-similarity: unsupported local classifier model: ${modelKey}`);
	}
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey)
		? Math.max(ANSWER_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
		: ANSWER_MAX_TOKENS;
	const builtPrompt = prompt.render(approvalSimilarityLocalPrompt, { approved, candidate });
	const output = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens,
		signal: deps.signal,
	});
	if (!output) {
		return undefined;
	}
	return parseApprovalSimilarity(output);
}

/** Strict yes/no-prefix parse; anything else is unparsable (fail-safe). */
export function parseApprovalSimilarity(text: string): boolean | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed.startsWith("yes")) return true;
	if (trimmed.startsWith("no")) return false;
	return undefined;
}

/** ANSI-free, head-truncated subject; the head carries the operation, the tail is usually arguments. */
function boundedSubject(subject: string, maxChars: number): string {
	const cleaned = stripAnsi(subject).trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars - 1)}…`;
}
