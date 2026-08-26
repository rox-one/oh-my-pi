/**
 * Regression test for #4507:
 * `/extensions` toggle (capability-registry `disableProvider` /
 * `enableProvider`) must mutate the new `disabledExtensionProviders` list
 * ONLY — never the model/login `disabledProviders` list. Legacy configs
 * with only the older key set migrate their value into the new list on
 * first `initializeWithSettings` so users who wrote `disabledProviders: [x]`
 * intending "hide everything from x" keep the joint behavior.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	disableProvider,
	enableProvider,
	getDisabledProviders,
	initializeWithSettings,
	isProviderEnabled,
	resetProviderStateForTests,
} from "@oh-my-pi/pi-coding-agent/capability";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("capability registry — extension-provider split (#4507)", () => {
	afterEach(() => {
		resetProviderStateForTests();
		resetSettingsForTest();
	});

	test("disableProvider writes disabledExtensionProviders and leaves disabledProviders alone", async () => {
		const settings = await Settings.init({ inMemory: true });
		initializeWithSettings(settings);

		disableProvider("cursor");

		expect(settings.get("disabledExtensionProviders")).toEqual(["cursor"]);
		expect(settings.get("disabledProviders")).toEqual([]);
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(getDisabledProviders()).toEqual(["cursor"]);

		enableProvider("cursor");
		expect(settings.get("disabledExtensionProviders")).toEqual([]);
		expect(isProviderEnabled("cursor")).toBe(true);
	});

	test("model-side disabledProviders survives /extensions toggle round-trips", async () => {
		const settings = await Settings.init({ inMemory: true });
		initializeWithSettings(settings);

		// Once the split key is configured, even as an empty list, the model-side
		// list must stay independent from extension toggles.
		settings.set("disabledExtensionProviders", []);
		settings.setDisabledProviders(["github-copilot"]);

		disableProvider("cursor");
		disableProvider("windsurf");
		enableProvider("cursor");

		// Model-side list untouched by any extension toggle.
		expect(settings.get("disabledProviders")).toEqual(["github-copilot"]);
		expect(settings.get("disabledExtensionProviders")).toEqual(["windsurf"]);
	});

	test("legacy migration: disabledProviders seeds the extension set when disabledExtensionProviders is empty", async () => {
		const settings = await Settings.init({
			inMemory: true,
			overrides: { disabledProviders: ["cursor", "opencode"] },
		});
		initializeWithSettings(settings);

		expect(isProviderEnabled("cursor")).toBe(false);
		expect(isProviderEnabled("opencode")).toBe(false);
		expect(getDisabledProviders()).toEqual(["cursor", "opencode"]);

		// Legacy migration is a read-through: the on-disk `disabledProviders`
		// stays intact until the user explicitly toggles a provider, at which
		// point only the new key is written.
		expect(settings.get("disabledProviders")).toEqual(["cursor", "opencode"]);
		expect(settings.get("disabledExtensionProviders")).toEqual([]);

		disableProvider("windsurf");
		expect(settings.get("disabledExtensionProviders")).toEqual(["cursor", "opencode", "windsurf"]);
		expect(settings.get("disabledProviders")).toEqual(["cursor", "opencode"]);
	});

	test("explicit disabledExtensionProviders wins over legacy disabledProviders", async () => {
		const settings = await Settings.init({
			inMemory: true,
			overrides: {
				disabledProviders: ["cursor"],
				disabledExtensionProviders: ["windsurf"],
			},
		});
		initializeWithSettings(settings);

		expect(isProviderEnabled("cursor")).toBe(true);
		expect(isProviderEnabled("windsurf")).toBe(false);
		expect(getDisabledProviders()).toEqual(["windsurf"]);
	});

	test("explicitly-empty disabledExtensionProviders is honored over legacy disabledProviders", async () => {
		// Reproduces the review scenario: user runs with model-side
		// `disabledProviders: ["cursor"]`, then re-enables the last extension
		// provider from the `/extensions` UI, which persists
		// `disabledExtensionProviders: []`. The next boot MUST NOT roll that
		// choice back by falling through to the legacy list — an explicitly
		// configured empty value is a deliberate signal.
		const settings = await Settings.init({
			inMemory: true,
			overrides: {
				disabledProviders: ["cursor"],
				disabledExtensionProviders: [],
			},
		});
		initializeWithSettings(settings);

		expect(isProviderEnabled("cursor")).toBe(true);
		expect(getDisabledProviders()).toEqual([]);
	});

	test("path-scoped disabledExtensionProviders resolves against cwd", async () => {
		const projectDir = "/tmp/omp-4507-project";
		const otherDir = "/tmp/omp-4507-other";

		const settings = await Settings.init({
			cwd: projectDir,
			inMemory: true,
			overrides: {
				disabledExtensionProviders: [
					"always",
					{ pathPrefix: projectDir, providers: ["cursor"] },
					{ pathPrefix: otherDir, providers: ["windsurf"] },
				],
			},
		});

		expect(settings.get("disabledExtensionProviders")).toEqual(["always", "cursor"]);
		initializeWithSettings(settings);
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(isProviderEnabled("windsurf")).toBe(true);

		await settings.reloadForCwd(otherDir);
		expect(settings.get("disabledExtensionProviders")).toEqual(["always", "windsurf"]);
		expect(isProviderEnabled("cursor")).toBe(true);
		expect(isProviderEnabled("windsurf")).toBe(false);
	});

	test("isProviderEnabled(cwd) labels providers against the requested workspace", async () => {
		const projectDir = "/tmp/omp-4507-active";
		const otherDir = "/tmp/omp-4507-target";

		const settings = await Settings.init({
			cwd: projectDir,
			inMemory: true,
			overrides: {
				disabledExtensionProviders: [
					{ pathPrefix: projectDir, providers: ["cursor"] },
					{ pathPrefix: otherDir, providers: ["windsurf"] },
				],
			},
		});
		initializeWithSettings(settings);

		// Session stays scoped to projectDir; a display load for otherDir must
		// label providers against otherDir's mask, not the active singleton cwd.
		expect(isProviderEnabled("windsurf", otherDir)).toBe(false);
		expect(isProviderEnabled("cursor", otherDir)).toBe(true);
		// Active scope still reflects projectDir when cwd is omitted.
		expect(isProviderEnabled("cursor")).toBe(false);
		expect(isProviderEnabled("windsurf")).toBe(true);
	});
});
