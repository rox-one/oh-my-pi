import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SETTINGS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-settings",
		aliases: ["reload-config"],
		description:
			"Re-read config.yml (and project/overlay settings) from disk, refresh the models.yml model catalog, and apply both without a restart",
		acpDescription: "Reload settings and models from disk",
		handle: async (_command, runtime) => {
			const before = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
				before.set(key, runtime.settings.get(key));
			}
			// Refresh the catalog BEFORE the settings reload: reloadFromDisk fires
			// the modelRoles signal, and consumers such as SessionAdvisors resolve
			// the new role against the registry immediately. The registry must
			// already contain models added in the same edit, or the new role
			// records `no_model` and stays inactive until the next role change.
			let modelsFailure: string | undefined;
			try {
				await runtime.session?.refreshModels();
			} catch (error) {
				modelsFailure = error instanceof Error ? error.message : String(error);
			}
			await runtime.settings.reloadFromDisk();
			await runtime.notifyConfigChanged?.();
			// Reconcile session-owned settings the reload cannot reach on its own:
			// the live session snapshots these at construction (agent/SDK fields),
			// so settings.get() alone would report them applied without changing
			// actual behavior.
			if (runtime.session) {
				const nextAdvisorEnabled = runtime.settings.get("advisor.enabled");
				if (runtime.session.isAdvisorEnabled() !== nextAdvisorEnabled) {
					runtime.session.setAdvisorEnabled(nextAdvisorEnabled);
				}
				const nextSteeringMode = runtime.settings.get("steeringMode");
				if (runtime.session.steeringMode !== nextSteeringMode) {
					runtime.session.setSteeringMode(nextSteeringMode);
				}
				const nextFollowUpMode = runtime.settings.get("followUpMode");
				if (runtime.session.followUpMode !== nextFollowUpMode) {
					runtime.session.setFollowUpMode(nextFollowUpMode);
				}
				const nextInterruptMode = runtime.settings.get("interruptMode");
				if (runtime.session.interruptMode !== nextInterruptMode) {
					runtime.session.setInterruptMode(nextInterruptMode);
				}
			}

			const changed: SettingPath[] = [];
			for (const [key, previous] of before) {
				if (!Bun.deepEquals(previous, runtime.settings.get(key))) {
					changed.push(key);
				}
			}
			if (modelsFailure) {
				await runtime.output(`Settings reloaded from disk (models.yml failed: ${modelsFailure})`);
				return;
			}
			if (changed.length === 0) {
				await runtime.output("Settings reloaded from disk. No effective values changed.");
				return;
			}
			await runtime.output(`Settings reloaded from disk. Applied: ${changed.join(", ")}`);
		},
	},
];
