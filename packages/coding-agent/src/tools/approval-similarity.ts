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
import { logger, prompt, withTimeout } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import approvalSimilarityPrompt from "../prompts/system/approval-similarity.md" with { type: "text" };
import approvalSimilarityLocalPrompt from "../prompts/system/approval-similarity-local.md" with { type: "text" };
import approvalSimilarityUserPrompt from "../prompts/system/approval-similarity-user.md" with { type: "text" };
import { stripAnsi } from "../tiny/message-preproc";
import { isTinyMemoryLocalModelKey, isTinyMemoryReasoningModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";
import { getSimilarApprovals } from "./session-approvals";

const SIMILARITY_SYSTEM_PROMPT = prompt.render(approvalSimilarityPrompt);

/**
 * Hard bound on the whole classification: a stalled backend must not freeze the
 * approval prompt; the caller's abort signal is combined with it. Kept under
 * the time a user needs to answer the prompt themselves — past that the
 * classifier is slower than the gate it replaces, and its fail-safe (a normal
 * prompt) is the better outcome. A cold local backend loses its first
 * classification to this bound while the worker loads the model; the retry on
 * the next gated call finds it warm.
 */
const CLASSIFY_TIMEOUT_MS = 3_000;

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
	/** Raw subject of the pending call — `approvalSubject(tool, args)` output. */
	subject: string;
	/** Exact-repeat key of the pending call — `approvalIdentity(resolvedArgs)` output. */
	identity: string;
	settings: Settings;
	/** Required by the `online` backend only; the local backend classifies on-device. */
	registry?: ModelRegistry;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

/**
 * True when `deps.subject` is similar to a subject the user approved for
 * `deps.toolName` this session. With no recorded subjects (or an unknown
 * session) there is nothing to compare against: returns `false` without a
 * model call. A call whose arguments the user already approved answers itself,
 * also without a model call.
 */
export async function isSimilarToApprovedCommand(deps: ApprovalSimilarityDeps): Promise<boolean> {
	const approvedEntries = getSimilarApprovals(deps.sessionId, deps.toolName);
	const candidateRaw = stripAnsi(deps.subject).trim();
	if (approvedEntries.length === 0 || candidateRaw.length === 0) return false;

	// The very call the user read in the prompt and approved: no model can add
	// anything, so the repeat costs neither a request nor the wait for one.
	// Matched on the args digest only — subject text is truncated for display
	// long before it is recorded, so calls differing past the cut share it.
	if (approvedEntries.some(entry => entry.identity === deps.identity)) return true;

	const backend = deps.settings.get("providers.approvalSimilarityModel");
	// Both backends render approved subjects as `- <subject>` list items, and a
	// subject is the tool's multi-line approval detail text ("Path: …\nContent:
	// …"); indenting the continuation lines keeps each entry one list item.
	const approved = approvedEntries.map(entry =>
		boundedSubject(entry.subject, MAX_SUBJECT_CHARS).replaceAll("\n", "\n  "),
	);
	const candidate = boundedSubject(candidateRaw, MAX_CANDIDATE_CHARS);
	const bounded: ApprovalSimilarityDeps = {
		...deps,
		signal: deps.signal
			? AbortSignal.any([deps.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)])
			: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
	};
	try {
		// The combined abort signal cancels the backend's own work; `withTimeout`
		// bounds the wait itself, because stages between here and the request
		// ignore it — notably the credential resolution in `classifyOnline`, which
		// may refresh an OAuth token over the network. It takes no signal of its
		// own: an already-aborted one would make it reject before it adopts the
		// classification promise, leaving that rejection unhandled.
		const classify =
			backend === ONLINE_MEMORY_MODEL_KEY
				? classifyOnline(approved, candidate, bounded)
				: classifyLocal(approved, candidate, backend, bounded);
		const similar = await withTimeout(classify, CLASSIFY_TIMEOUT_MS, "classification timed out");
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
	// Only this backend needs the registry, so the requirement lives here: a
	// context without one still reaches the local backend, and here it joins the
	// throws below under the caller's fail-safe (a normal approval prompt).
	const registry = deps.registry;
	if (!registry) {
		throw new Error("approval-similarity: no model registry for online classification");
	}
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		throw new Error("approval-similarity: no tiny/smol model available for classification");
	}
	const apiKey = await registry.getApiKey(model, deps.sessionId);
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
					content: prompt.render(approvalSimilarityUserPrompt, { approved, candidate }),
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: registry.resolver(model, deps.sessionId),
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
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey) ? REASONING_SAFE_MAX_TOKENS : ANSWER_MAX_TOKENS;
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
