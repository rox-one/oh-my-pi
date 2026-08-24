import { afterAll, beforeAll, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils";

const originalProfile = getActiveProfile();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	setProfile(originalProfile);
	resetSettingsForTest();
});

test("renders profile plus compact metric status line", () => {
	setProfile("work");
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "GPT-5.6-Sol", contextWindow: 100000 } },
		messages: [],
		model: { name: "GPT-5.6-Sol", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
			getUsageStatistics: () => ({
				input: 25000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 25005,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => ({ tokens: 9100, contextWindow: 100000, percent: 9.1 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "profile"],
		rightSegments: ["token_total", "context_pct"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: {
			token_total: { breakdown: true },
			context_pct: { compact: true },
		},
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(120).content);
	expect(rendered).toContain("GPT-5.6-Sol");
	expect(rendered).toContain("p:work");
	expect(rendered).toContain("in:25K out:5");
	expect(rendered).toContain("ctx:9.1%");
	expect(rendered).not.toContain("100K");
});
