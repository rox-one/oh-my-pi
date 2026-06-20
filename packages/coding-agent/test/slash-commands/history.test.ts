import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(slashHistory: boolean | undefined = undefined) {
	const addToHistory = vi.fn();
	const setText = vi.fn();
	const showSettingsSelector = vi.fn();
	const get = vi.fn((path: string) => (path === "tui.slashHistory" ? slashHistory : undefined));

	return {
		addToHistory,
		setText,
		showSettingsSelector,
		runtime: {
			ctx: {
				editor: { addToHistory, setText },
				settings: { get },
				showSettingsSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("slash command history", () => {
	it("stores built-in slash commands for recall by default", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/settings", harness.runtime)).toBe(true);

		expect(harness.showSettingsSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.addToHistory).toHaveBeenCalledWith("/settings");
	});

	it("respects the slash command history opt-out", async () => {
		const harness = createRuntime(false);

		expect(await executeBuiltinSlashCommand("/settings", harness.runtime)).toBe(true);

		expect(harness.addToHistory).not.toHaveBeenCalled();
	});
});
