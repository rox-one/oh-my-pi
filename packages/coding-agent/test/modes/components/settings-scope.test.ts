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

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-scope-test-");
	});

	afterEach(async () => {
		resetSettingsForTest();
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	it("defaults to project scope, exposes scope switching, and inherits the effective fallback", async () => {
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true }, custom: { keep: true } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		const changes: Array<{ path: string; value: unknown }> = [];
		const selector = new SettingsSelectorComponent(
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

		expect(selector.render(120).join("\n")).toContain("Settings · project");
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\n");
		expect(settings.get("ask.enabled")).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });

		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
		selector.handleInput("\n");
		expect(settings.get("ask.enabled")).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });
		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: true } });

		selector.handleInput("\x1b");
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · project");
		selector.handleInput("\x1b[3~");
		expect(settings.get("ask.enabled")).toBe(true);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: true });
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({ custom: { keep: true } });
	});
});
