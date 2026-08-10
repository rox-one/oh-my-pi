import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { getSessionMode, reconcileSessionMode, setSessionMode, suspendSessionMode } from "../src/modes/rpc/rpc-modes";
import { createTestSession, type TestSessionContext } from "./utilities";
import type { SessionEntry } from "../src/session/session-entries";

const isModeChangeEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "mode_change" }> =>
	entry.type === "mode_change";

/** Minimal persisted session file: header + one mode_change entry. */
function writeSessionFile(dir: string, name: string, mode: "plan" | "vibe" | "goal" | "none"): string {
	const sessionId = Snowflake.next().toString();
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: dir,
	};
	const entryId = Snowflake.next().slice(0, 8);
	const modeChange = {
		type: "mode_change",
		id: entryId,
		parentId: sessionId,
		timestamp: new Date().toISOString(),
		mode,
		...(mode === "plan" ? { data: { planFilePath: "local://PLAN.md" } } : {}),
	};
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(modeChange)}\n`, "utf8");
	return file;
}

describe("rpc session modes (headless controller)", () => {
	let ctx: TestSessionContext;

	beforeEach(async () => {
		ctx = await createTestSession({ vibeTools: true });
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test("starts in none mode", () => {
		expect(getSessionMode(ctx.session)).toBe("none");
	});

	test("set_mode plan enters plan mode, persists mode_change, and resets on none", async () => {
		expect(await setSessionMode(ctx.session, "plan")).toBe("plan");
		expect(getSessionMode(ctx.session)).toBe("plan");
		expect(ctx.session.getPlanModeState()?.enabled).toBe(true);
		expect(ctx.session.peekPlanProposalHandler()).toBeDefined();

		const modeEntries = ctx.sessionManager.getEntries().filter(isModeChangeEntry);
		expect(modeEntries.at(-1)?.mode).toBe("plan");

		expect(await setSessionMode(ctx.session, "none")).toBe("none");
		expect(ctx.session.getPlanModeState()).toBeUndefined();
		expect(ctx.session.peekPlanProposalHandler()).toBeUndefined();
		expect(ctx.sessionManager.getEntries().filter(isModeChangeEntry).at(-1)?.mode).toBe("none");
	});

	test("set_mode enforces mutual exclusion (exit-first semantics)", async () => {
		await setSessionMode(ctx.session, "plan");
		await expect(setSessionMode(ctx.session, "goal", "Ship it")).rejects.toThrow(/Exit plan mode first/);
		await expect(setSessionMode(ctx.session, "vibe")).rejects.toThrow(/Exit plan mode first/);
		expect(getSessionMode(ctx.session)).toBe("plan");

		await setSessionMode(ctx.session, "none");
		await setSessionMode(ctx.session, "vibe");
		await expect(setSessionMode(ctx.session, "plan")).rejects.toThrow(/Exit vibe mode first/);
		expect(getSessionMode(ctx.session)).toBe("vibe");
	});

	test("set_mode goal requires an objective", async () => {
		await expect(setSessionMode(ctx.session, "goal")).rejects.toThrow(/requires an objective/);
		expect(getSessionMode(ctx.session)).toBe("none");

		expect(await setSessionMode(ctx.session, "goal", "Write a haiku")).toBe("goal");
		expect(ctx.session.getGoalModeState()?.goal.objective).toBe("Write a haiku");
		expect(getSessionMode(ctx.session)).toBe("goal");
	});

	test("set_mode vibe enters and exits vibe mode", async () => {
		expect(await setSessionMode(ctx.session, "vibe")).toBe("vibe");
		expect(ctx.session.getVibeModeState()?.enabled).toBe(true);
		expect(ctx.sessionManager.getEntries().filter(isModeChangeEntry).at(-1)?.mode).toBe("vibe");

		expect(await setSessionMode(ctx.session, "none")).toBe("none");
		expect(ctx.session.getVibeModeState()).toBeUndefined();
		expect(ctx.sessionManager.getEntries().filter(isModeChangeEntry).at(-1)?.mode).toBe("none");
	});

	test("switch_session restores the persisted mode (reconcile hooks)", async () => {
		// Plan session file and a fresh "none" file.
		const planFile = writeSessionFile(ctx.tempDir, `plan-${Snowflake.next()}.jsonl`, "plan");
		const freshFile = writeSessionFile(ctx.tempDir, `fresh-${Snowflake.next()}.jsonl`, "none");

		// Install the same hooks rpc-mode.ts installs.
		ctx.session.setSessionBeforeSwitchReconciler(() => suspendSessionMode(ctx.session));
		ctx.session.setSessionSwitchReconciler(() => reconcileSessionMode(ctx.session));

		await ctx.session.switchSession(freshFile);
		expect(getSessionMode(ctx.session)).toBe("none");

		await ctx.session.switchSession(planFile);
		expect(getSessionMode(ctx.session)).toBe("plan");
		expect(ctx.session.getPlanModeState()?.enabled).toBe(true);

		await ctx.session.switchSession(freshFile);
		expect(getSessionMode(ctx.session)).toBe("none");
		expect(ctx.session.getPlanModeState()).toBeUndefined();
	});
});
