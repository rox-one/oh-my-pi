import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";

describe("loadPuppeteer cwd restoration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces a restore failure after the import succeeds", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { loadPuppeteer } from "./src/tools/browser/launch.ts";
const previousCwd = process.cwd();
const originalChdir = process.chdir.bind(process);
process.chdir = directory => {
	if (directory === previousCwd) throw new Error("restore denied");
	originalChdir(directory);
};
try {
	await loadPuppeteer();
	process.exit(2);
} catch (error) {
	if (error instanceof Error && error.message === "restore denied") process.exit(0);
	process.stderr.write(String(error));
	process.exit(1);
}`,
			],
			{ cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	});
});
