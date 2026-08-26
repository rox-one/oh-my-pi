import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await initTheme();
});

describe("SettingsSelectorComponent persistence scope", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	let agentDir: string;
	let projectConfigPath: string;
	let changes: Array<{ path: string; value: unknown }>;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-scope-test-");
		projectDir = tempDir.join("project");
		agentDir = tempDir.join("agent");
		projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		// Global fallback disagrees with the project override so a shadowed
		// global edit is observable: effective (project) stays true.
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true }, custom: { keep: true } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		changes = [];
	});

	afterEach(async () => {
		resetSettingsForTest();
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
	}

	it("writes the global layer while callbacks receive the shadowing effective value", async () => {
		// Start both layers at true, then toggle only the global fallback to
		// false. The persisted scope and active effective value must diverge.
		settings.set("ask.enabled", true, "global");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain("Settings · project");
		expect(settings.getGlobalValue("ask.enabled")).toBe(true);
		expect(settings.get("ask.enabled")).toBe(true);

		// Alt+S switches to global scope; the row reflects the global layer
		// (true), so Enter writes false even though project remains true.
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\n");

		expect(settings.getGlobalValue("ask.enabled")).toBe(false);
		expect(settings.get("ask.enabled")).toBe(true);
		// Side-effect handlers receive the merged effective value, not the
		// global fallback displayed in the row.
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: true });

		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
		});
	});

	it("inherits the global fallback when removing a project override", async () => {
		const selector = createSelector();
		// Locate the Ask row via search, then Esc lands on its tab with the row
		// selected so Delete can remove the project override in list mode.
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\x1b");
		selector.handleInput("\x1b[3~");

		expect(settings.get("ask.enabled")).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });

		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({ custom: { keep: true } });
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
	});
});
