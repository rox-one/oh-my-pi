import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";

function searchDescriptions(options: { spawns?: string; maxRecursionDepth: number; taskDepth?: number }): string[] {
	const settings = Settings.isolated({ "task.maxRecursionDepth": options.maxRecursionDepth });
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		settings,
		taskDepth: options.taskDepth,
	} as ToolSession;
	return [new GlobTool(session).description, new GrepTool(session).description, new AstGrepTool(session).description];
}

describe("search tool spawn capability guidance", () => {
	it("advertises task and scout when spawning is available", () => {
		for (const description of searchDescriptions({ maxRecursionDepth: 1 })) {
			expect(description).toContain("Task");
			expect(description).toContain("scout");
		}
	});

	it("omits impossible task guidance when recursion depth is exhausted", () => {
		const descriptions = [
			...searchDescriptions({ maxRecursionDepth: 0 }),
			...searchDescriptions({ maxRecursionDepth: 1, taskDepth: 1 }),
		];
		for (const description of descriptions) {
			expect(description).not.toContain("Task");
			expect(description).not.toContain("scout");
		}
	});

	it("omits impossible task guidance when spawn policy disables spawning", () => {
		for (const description of searchDescriptions({ spawns: "", maxRecursionDepth: 1 })) {
			expect(description).not.toContain("Task");
			expect(description).not.toContain("scout");
		}
	});
});
