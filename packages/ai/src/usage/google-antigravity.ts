import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import * as AIError from "../error";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { DAY_MS, parseIsoTimestamp, WEEK_MS } from "./shared";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	dailyQuotaInfos?: AntigravityQuotaInfo[];
	weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	weeklyQuotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

interface AntigravityQuotaSummaryBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	remainingFraction?: number;
	remaining?: {
		remainingFraction?: number;
		case?: string;
		value?: number;
	};
	resetTime?: string;
	disabled?: boolean;
}

interface AntigravityQuotaSummaryGroup {
	displayName?: string;
	buckets?: AntigravityQuotaSummaryBucket[];
}

interface AntigravityQuotaSummaryResponse {
	groups?: AntigravityQuotaSummaryGroup[];
	response?: { groups?: AntigravityQuotaSummaryGroup[] };
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const RETRIEVE_USER_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

interface AntigravityWindowDescriptor {
	id: string;
	label: string;
	durationMs?: number;
}

function classifyWindow(id: string | undefined, label: string | undefined): AntigravityWindowDescriptor | undefined {
	const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
	if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	if (source.includes("5h") || source.includes("five hour") || /5[\s_-]*hour/.test(source)) {
		return { id: "5h", label: "Five Hour", durationMs: FIVE_HOURS_MS };
	}
	if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
		return { id: "daily", label: "Daily", durationMs: DAY_MS };
	}
	if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
	return undefined;
}

function inferWindowFromReset(resetAt: number | undefined, nowMs: number): AntigravityWindowDescriptor {
	if (resetAt !== undefined && resetAt - nowMs > DAY_MS) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	return { id: "daily", label: "Daily", durationMs: DAY_MS };
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
	return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
	quotaInfos: AntigravityQuotaInfo[],
	nowMs: number,
): WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor> {
	const descriptors = new WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor>();
	const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

	for (const info of quotaInfos) {
		const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
		if (explicitDescriptor) {
			descriptors.set(info, explicitDescriptor);
			continue;
		}
		const group = groups.get(quotaInferenceKey(info)) ?? [];
		group.push({ info, resetAt: parseIsoTimestamp(info.resetTime) });
		groups.set(quotaInferenceKey(info), group);
	}

	for (const group of groups.values()) {
		const resetTimes = [...new Set(group.map(entry => entry.resetAt).filter(resetAt => resetAt !== undefined))].sort(
			(a, b) => a - b,
		);
		const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
		for (const entry of group) {
			const descriptor =
				latestReset !== undefined && entry.resetAt === latestReset
					? { id: "weekly", label: "Weekly", durationMs: WEEK_MS }
					: inferWindowFromReset(entry.resetAt, nowMs);
			descriptors.set(entry.info, descriptor);
		}
	}

	return descriptors;
}

function withWindowDescriptor(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): AntigravityQuotaInfo {
	if (!descriptor) return info;
	return {
		...info,
		windowId: info.windowId ?? descriptor.id,
		windowLabel: info.windowLabel ?? descriptor.label,
	};
}

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): UsageWindow | undefined {
	const resetAt = parseIsoTimestamp(info.resetTime);
	const hasResetAt = resetAt !== undefined;
	if (!descriptor && !hasResetAt) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
		...(hasResetAt ? { resetsAt: resetAt } : {}),
	};
}

function buildAmount(info: AntigravityQuotaInfo): UsageAmount {
	const apiRemainingFraction = clampFraction(info.remainingFraction);
	// Observed Antigravity responses omit remainingFraction for exhausted
	// Google/Gemini counters and keep only resetTime. Treat that shape as
	// "blocked until reset" rather than unknown so a healthy sibling backend
	// counter cannot mask it during dedupe.
	const remainingFraction = apiRemainingFraction ?? (info.resetTime ? 0 : undefined);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
	switch (info.modelProvider ?? info.apiProvider) {
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
			return "Anthropic";
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return "Google";
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return "OpenAI";
		default:
			return undefined;
	}
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: AntigravityWindowDescriptor) => {
		results.push({ ...source, ...withWindowDescriptor(value, windowDescriptor), ...(tier ? { tier } : {}) });
	};
	const addValue = (
		value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined,
		tier?: string,
		windowDescriptor?: AntigravityWindowDescriptor,
	) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const entry of value) addInfo(entry, tier, windowDescriptor);
			return;
		}
		addInfo(value, tier, windowDescriptor);
	};

	addValue(info.quotaInfo);
	addValue(info.quotaInfos);
	addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
	addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
	addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
	addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			addValue(value, tier);
		}
	}

	const addWindowMap = (values?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>) => {
		if (!values) return;
		for (const [windowId, value] of Object.entries(values)) {
			addValue(value, undefined, classifyWindow(windowId, undefined));
		}
	};
	addWindowMap(info.quotaInfoByWindow);
	addWindowMap(info.quotaInfosByWindow);

	return results;
}

function quotaSummaryGroups(data: AntigravityQuotaSummaryResponse): AntigravityQuotaSummaryGroup[] {
	return data.response?.groups ?? data.groups ?? [];
}

function quotaSummaryRemainingFraction(bucket: AntigravityQuotaSummaryBucket): number | undefined {
	if (bucket.remainingFraction !== undefined) return bucket.remainingFraction;
	if (bucket.remaining?.remainingFraction !== undefined) return bucket.remaining.remainingFraction;
	if (bucket.remaining?.case === "remainingFraction") return bucket.remaining.value;
	return undefined;
}

function quotaSummaryCounter(
	group: AntigravityQuotaSummaryGroup,
	bucket: AntigravityQuotaSummaryBucket,
): { key: string; label: string } | undefined {
	const bucketId = bucket.bucketId?.toLowerCase();
	const groupName = group.displayName?.toLowerCase() ?? "";
	if (bucketId === "gemini-5h" || bucketId === "gemini-weekly") {
		return { key: "google", label: group.displayName ?? "Gemini Models" };
	}
	if (bucketId === "3p-5h" || bucketId === "3p-weekly") {
		return { key: "third-party", label: group.displayName ?? "Claude and GPT Models" };
	}
	if (bucketId) return undefined;
	if (groupName.includes("gemini")) return { key: "google", label: group.displayName ?? "Gemini Models" };
	if (groupName.includes("claude") || groupName.includes("gpt") || groupName.includes("third party")) {
		return { key: "third-party", label: group.displayName ?? "Claude and GPT Models" };
	}
	return undefined;
}

function quotaSummaryWindow(bucket: AntigravityQuotaSummaryBucket): AntigravityWindowDescriptor | undefined {
	switch (bucket.bucketId?.toLowerCase()) {
		case "gemini-5h":
		case "3p-5h":
			return classifyWindow("5h", bucket.displayName);
		case "gemini-weekly":
		case "3p-weekly":
			return classifyWindow("weekly", bucket.displayName);
		default:
			return bucket.bucketId ? undefined : classifyWindow(bucket.window, bucket.displayName);
	}
}

function buildQuotaSummaryLimits(data: AntigravityQuotaSummaryResponse, params: UsageFetchParams): UsageLimit[] {
	const credential = params.credential;
	const deduped = new Map<string, UsageLimit>();

	for (const group of quotaSummaryGroups(data)) {
		for (const bucket of group.buckets ?? []) {
			if (bucket.disabled) continue;
			const counter = quotaSummaryCounter(group, bucket);
			const descriptor = quotaSummaryWindow(bucket);
			if (!counter || !descriptor) continue;

			const quotaInfo: AntigravityQuotaInfo = {
				remainingFraction: quotaSummaryRemainingFraction(bucket),
				resetTime: bucket.resetTime,
				windowId: descriptor.id,
				windowLabel: descriptor.label,
			};
			if (quotaInfo.remainingFraction === undefined && quotaInfo.resetTime === undefined) continue;

			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo, descriptor);
			const key = `${counter.key}|${descriptor.id}`;
			const limit: UsageLimit = {
				id: `${params.provider}:${counter.key}:default:${descriptor.id}`,
				label: counter.label,
				scope: {
					provider: params.provider,
					accountId: credential.accountId,
					projectId: credential.projectId,
					windowId: descriptor.id,
				},
				window,
				amount,
				status: getUsageStatus(amount.remainingFraction),
			};

			const existing = deduped.get(key);
			const existingFraction = existing?.amount.remainingFraction;
			const nextFraction = amount.remainingFraction;
			if (
				!existing ||
				(existingFraction === undefined && nextFraction !== undefined) ||
				(existingFraction !== undefined && nextFraction !== undefined && nextFraction < existingFraction)
			) {
				deduped.set(key, limit);
			}
		}
	}

	return [...deduped.values()].sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl?.replace(/\/+$/, "");
	const endpoints = baseUrl ? [baseUrl] : [DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.sandbox.googleapis.com"];

	const requestEndpoint = async (path: string): Promise<{ response: Response; endpoint: string } | undefined> => {
		let response: Response | undefined;
		let attemptedEndpoint = DEFAULT_ENDPOINT;
		for (const endpoint of endpoints) {
			attemptedEndpoint = endpoint;
			try {
				response = await ctx.fetch(`${endpoint}${path}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
						"User-Agent": getAntigravityUserAgent(),
					},
					body: JSON.stringify({ project: credential.projectId }),
					signal: params.signal,
				});

				if (response.ok) return { response, endpoint };
				if (!AIError.isTransientStatus(response.status)) break;
			} catch (error) {
				if (endpoint === endpoints[endpoints.length - 1]) throw error;
			}
		}
		return response ? { response, endpoint: attemptedEndpoint } : undefined;
	};

	// This endpoint backs the Antigravity usage screen and exposes the real
	// account-wide pools: Gemini and third-party models, each with 5h and weekly
	// buckets. The legacy per-model response below does not identify those pools
	// reliably, so use it only when the summary endpoint is unavailable.
	const summaryResult = await requestEndpoint(RETRIEVE_USER_QUOTA_SUMMARY_PATH);
	if (summaryResult?.response.ok) {
		const summaryData = (await summaryResult.response.json()) as AntigravityQuotaSummaryResponse;
		const summaryLimits = buildQuotaSummaryLimits(summaryData, params);
		if (summaryLimits.length > 0) {
			const metadata: UsageReport["metadata"] = {
				endpoint: summaryResult.endpoint,
				usageSource: "retrieveUserQuotaSummary",
				projectId: credential.projectId,
			};
			if (credential.email) metadata.email = credential.email;
			if (credential.accountId) metadata.accountId = credential.accountId;
			return {
				provider: params.provider,
				fetchedAt: nowMs,
				limits: summaryLimits,
				metadata,
				raw: summaryData,
			};
		}
	}

	const modelsResult = await requestEndpoint(FETCH_AVAILABLE_MODELS_PATH);
	if (!modelsResult?.response.ok) {
		ctx.logger?.warn("Antigravity usage fetch failed", {
			status: modelsResult?.response.status ?? 0,
			statusText: modelsResult?.response.statusText ?? "unknown",
		});
		return null;
	}
	const successfulEndpoint = modelsResult.endpoint;
	const data = (await modelsResult.response.json()) as AntigravityUsageResponse;

	// The API returns per-model quota entries, but quota is shared across
	// models within the same backend counter, tier, and reset window. Keep
	// Google and Anthropic-backed Antigravity models separate so a healthy
	// Claude counter cannot mask an exhausted Gemini counter.
	const deduped = new Map<
		string,
		{
			amount: UsageAmount;
			window: UsageWindow | undefined;
			tier: string | undefined;
			tierKey: string;
			windowId: string;
			counterName: string | undefined;
			counterKey: string;
		}
	>();
	let earliestReset: number | undefined;

	for (const [_modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
		for (const quotaInfo of quotaInfos) {
			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
			if (window?.resetsAt) {
				earliestReset = earliestReset ? Math.min(earliestReset, window.resetsAt) : window.resetsAt;
			}
			const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
			const counterName = formatCounterName(quotaInfo);
			const counterKey = counterName?.toLowerCase() ?? "default";
			// Use the parsed window id when available so provider enum names like
			// WINDOW_WEEKLY normalize into the same visible `/usage` group as
			// weeklyQuotaInfo entries.
			const windowId = window?.id ?? quotaInfo.windowId ?? "default";
			const key = `${counterKey}|${tierKey}|${windowId}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, { amount, window, tier: quotaInfo.tier, tierKey, windowId, counterName, counterKey });
				continue;
			}
			// Merge: keep the entry with fraction data for the bar, but
			// also keep any window with a reset time so "resets in…" survives.
			const eFrac = existing.amount.remainingFraction;
			const cFrac = amount.remainingFraction;
			const eHasFrac = eFrac !== undefined;
			const cHasFrac = cFrac !== undefined;

			let bestAmount = existing.amount;
			let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
			let bestTier = existing.tier ?? quotaInfo.tier;

			if (!eHasFrac && cHasFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			}
			// Always merge in window with reset time if the current
			// best doesn't have one.
			if (!bestWindow?.resetsAt && window?.resetsAt) {
				bestWindow = window;
			}
			deduped.set(key, {
				amount: bestAmount,
				window: bestWindow,
				tier: bestTier,
				tierKey: existing.tierKey,
				windowId: existing.windowId,
				counterName: existing.counterName,
				counterKey: existing.counterKey,
			});
		}
	}

	const limits: UsageLimit[] = [];
	for (const entry of deduped.values()) {
		const label = entry.counterName ? `Usage (${entry.counterName})` : "Usage";
		limits.push({
			id: `${params.provider}:${entry.counterKey}:${entry.tierKey}:${entry.windowId}`,
			label,
			scope: {
				provider: params.provider,
				accountId: credential.accountId,
				projectId: credential.projectId,
				tier: entry.tier,
				windowId: entry.windowId,
			},
			window: entry.window,
			amount: entry.amount,
			status: getUsageStatus(entry.amount.remainingFraction),
		});
	}

	limits.sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});

	const metadata: UsageReport["metadata"] = {
		endpoint: successfulEndpoint,
		projectId: credential.projectId,
	};
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata,
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};

function getAntigravityCounterKeysForModel(context: CredentialRankingContext | undefined): string[] {
	const modelId = context?.modelId?.toLowerCase();
	if (!modelId) return [];
	if (modelId.startsWith("claude-")) return ["third-party", "anthropic"];
	if (modelId.startsWith("gemini-") || modelId.startsWith("gemma-")) return ["google"];
	if (modelId.startsWith("gpt-") || modelId.startsWith("openai/")) return ["third-party", "openai"];
	return [];
}

function getAntigravityCounterLimits(report: UsageReport, counterKey: string): UsageLimit[] {
	const prefix = `${report.provider}:${counterKey}:`;
	return report.limits.filter(limit => limit.id.toLowerCase().startsWith(prefix));
}

// Exhaustion checks are only safe with a concrete backend counter. A no-model
// Antigravity credential lookup (for example image-provider discovery) must
// not turn one exhausted family into a provider-wide block.
function scopeAntigravityLimitsForModel(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit[] {
	const counterKeys = getAntigravityCounterKeysForModel(context);
	for (const counterKey of counterKeys) {
		const backendLimits = getAntigravityCounterLimits(report, counterKey);
		if (backendLimits.length > 0) return backendLimits;
	}
	return counterKeys.length > 0 ? getAntigravityCounterLimits(report, "default") : [];
}

function rankAntigravityLimits(report: UsageReport, context: CredentialRankingContext | undefined): UsageLimit[] {
	if (getAntigravityCounterKeysForModel(context).length === 0) return report.limits;
	return scopeAntigravityLimitsForModel(report, context);
}

/**
 * Antigravity quota summaries return a Google pool plus a shared third-party
 * pool for Claude and GPT, each with 5-hour and weekly windows. Legacy fallback
 * reports can still expose separate Anthropic/OpenAI counters. `fetchAntigravityUsage`
 * sorts `limits` ascending by `remainingFraction`; after model-family scoping,
 * the most-pressured relevant counter/window is index 0.
 *
 * Leave `secondary` unset: AuthStorage compares secondary metrics before
 * primary metrics, which is correct for providers with a fixed short/long
 * split but wrong here. Ranking Antigravity by the bottleneck counter first
 * avoids preferring an account at 95% Gemini daily / 0% Claude weekly over one
 * with healthier Gemini headroom.
 */
export const antigravityRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		return { primary: rankAntigravityLimits(report, context)[0] };
	},
	scopeLimits: scopeAntigravityLimitsForModel,
	// Always return a scope for Antigravity so missing/unknown model context
	// cannot fall through to AuthStorage's provider-wide block bucket.
	blockScope(context) {
		const counterKey = getAntigravityCounterKeysForModel(context)[0];
		return `counter:${counterKey ?? "unknown"}`;
	},
	// Summary windows carry `durationMs`; fall back to daily only for legacy
	// unlabelled quotaInfo entries from `fetchAvailableModels`.
	windowDefaults: { primaryMs: DAY_MS, secondaryMs: DAY_MS },
};
