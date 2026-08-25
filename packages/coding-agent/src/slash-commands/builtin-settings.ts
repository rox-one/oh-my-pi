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
			await runtime.settings.reloadFromDisk();
			await runtime.notifyConfigChanged?.();
			// Refresh AFTER the settings reload so provider discovery sees the new
			// disabled-provider set: an edit that enables a discovery-backed
			// provider must surface its models in the same reload. Then re-resolve
			// role consumers — the reload's modelRoles signal fired against the
			// pre-refresh registry, so an advisor may have recorded no_model for a
			// role that resolves fine now.
			let modelsFailure: string | undefined;
			try {
				await runtime.session?.refreshModels();
			} catch (error) {
				modelsFailure = error instanceof Error ? error.message : String(error);
			}
			runtime.session?.reapplyModelRoles();
			// Reconcile session-owned settings the reload cannot reach on its own:
			// the live session snapshots these at construction (agent/SDK fields),
			// so settings.get() alone would report them applied without changing
			// actual behavior. persist=false — the value may come from a project
			// or --config overlay, and writing it through settings.set would
			// promote an overlay-only value into global config.
			if (runtime.session) {
				const nextAdvisorEnabled = runtime.settings.get("advisor.enabled");
				if (runtime.session.isAdvisorEnabled() !== nextAdvisorEnabled) {
					runtime.session.setAdvisorEnabled(nextAdvisorEnabled);
				}
				const nextSteeringMode = runtime.settings.get("steeringMode");
				if (runtime.session.steeringMode !== nextSteeringMode) {
					runtime.session.setSteeringMode(nextSteeringMode, false);
				}
				const nextFollowUpMode = runtime.settings.get("followUpMode");
				if (runtime.session.followUpMode !== nextFollowUpMode) {
					runtime.session.setFollowUpMode(nextFollowUpMode, false);
				}
				const nextInterruptMode = runtime.settings.get("interruptMode");
				if (runtime.session.interruptMode !== nextInterruptMode) {
					runtime.session.setInterruptMode(nextInterruptMode, false);
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
