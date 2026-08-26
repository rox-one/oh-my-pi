import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resumeCommand, resumeCommandForSession } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getActiveProfile,
	getSessionsDir,
	removeSyncWithRetries,
	Snowflake,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.omp/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --profile personal --resume abc123`);
	});
});

describe("resumeCommandForSession", () => {
	// setAgentDir / setProfile rewrite process env and the dirs snapshot; capture
	// and restore the exact env, then rebuild dirs from it, so a suite that starts
	// under a named profile is not left in the default profile with a stale
	// override for the next test file.
	const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const originalEnv: Record<string, string | undefined> = {};
	let tempDir: string;

	beforeEach(() => {
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		tempDir = path.join(os.tmpdir(), `resume-hint-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		setAgentDir(path.join(tempDir, "omp-agent"));
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(tempDir);
	});

	it("uses the compact --resume <id> form for a managed bucket session", () => {
		const id = "0198abcd-ef01-2345-6789-abcdef012345";
		const managed = path.join(getSessionsDir(), "--home-user-project--", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		expect(resumeCommandForSession(id, managed)).toBe(`${APP_NAME} --resume ${id}`);
	});

	it("advertises the explicit path for a path-resumed foreign session id-resolution cannot find (#9544)", () => {
		const id = "0198abcd-ef01-2345-6789-abcdef012345";
		const foreign = path.join(tempDir, "pi", "agent", "sessions", "--home-user-project--", `2026-01-01_${id}.jsonl`);
		expect(resumeCommandForSession(id, foreign)).toBe(`${APP_NAME} --resume ${foreign}`);
	});

	it("quotes a foreign path containing shell-significant characters", () => {
		const id = "0198abcd-ef01-2345-6789-abcdef012345";
		const foreign = path.join(tempDir, "my sessions", `2026-01-01_${id}.jsonl`);
		expect(resumeCommandForSession(id, foreign)).toBe(`${APP_NAME} --resume '${foreign}'`);
	});

	it("carries the active profile into the foreign-path form", () => {
		setProfile("personal");
		const id = "0198abcd-ef01-2345-6789-abcdef012345";
		const foreign = path.join(tempDir, "pi-session.jsonl");
		expect(resumeCommandForSession(id, foreign)).toBe(`${APP_NAME} --profile personal --resume ${foreign}`);
	});
});
