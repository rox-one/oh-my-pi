import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

/**
 * RPC `set_mode` end-to-end: the client drives a real `--mode rpc` CLI
 * process. Skipped without ANTHROPIC_API_KEY (same as the rest of rpc.test.ts).
 */
describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("RPC set_mode", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-set-mode-${Snowflake.next()}`);
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		client.stop();
		if (sessionDir && fs.existsSync(sessionDir)) {
			removeSyncWithRetries(sessionDir);
		}
	});

	test("set_mode toggles plan mode and persists mode_change entries", async () => {
		await client.start();
		expect((await client.getState()).mode).toBe("none");

		expect(await client.setMode("plan")).toBe("plan");
		const state = await client.getState();
		expect(state.mode).toBe("plan");
		expect(state.sessionFile).toBeDefined();

		expect(await client.setMode("none")).toBe("none");
		expect((await client.getState()).mode).toBe("none");
	}, 60000);

	test("set_mode rejects goal without an objective and enforces mutual exclusion", async () => {
		await client.start();

		await expect(client.setMode("goal")).rejects.toThrow(/requires an objective/);
		expect(await client.setMode("goal", "Write a haiku")).toBe("goal");
		expect((await client.getState()).mode).toBe("goal");

		await expect(client.setMode("plan")).rejects.toThrow(/Exit goal mode first/);
		expect((await client.getState()).mode).toBe("goal");

		expect(await client.setMode("none")).toBe("none");
		expect((await client.getState()).mode).toBe("none");
	}, 60000);

	test("switch_session restores the persisted mode", async () => {
		await client.start();
		expect(await client.setMode("plan")).toBe("plan");
		const planSessionFile = (await client.getState()).sessionFile!;

		// A fresh session has no mode chain.
		await client.newSession();
		expect((await client.getState()).mode).toBe("none");

		// Switching back to the plan session restores plan mode.
		await client.switchSession(planSessionFile);
		expect((await client.getState()).mode).toBe("plan");
	}, 60000);
});
