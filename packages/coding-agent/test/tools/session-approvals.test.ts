import { afterEach, describe, expect, it } from "bun:test";
import {
	addSimilarApproval,
	approvalSubject,
	approveToolForSession,
	clearSessionApprovals,
	getSimilarApprovals,
	isToolApprovedForSession,
} from "@oh-my-pi/pi-coding-agent/tools/session-approvals";

// The store is module-level and shared across the suite; each test gets fresh
// session ids and every id is released afterwards so later files see a clean map.
let idCounter = 0;
const usedSessionIds: string[] = [];

function newSessionId(): string {
	const id = `session-approvals-test-${++idCounter}`;
	usedSessionIds.push(id);
	return id;
}

afterEach(() => {
	for (const id of usedSessionIds) clearSessionApprovals(id);
	usedSessionIds.length = 0;
});

describe("session approval store", () => {
	it("whole-tool approval is visible immediately and scoped to its session", () => {
		const sid = newSessionId();
		const other = newSessionId();
		expect(isToolApprovedForSession(sid, "bash")).toBe(false);
		approveToolForSession(sid, "bash");
		expect(isToolApprovedForSession(sid, "bash")).toBe(true);
		// Approvals never leak into other sessions or other tools.
		expect(isToolApprovedForSession(other, "bash")).toBe(false);
		expect(isToolApprovedForSession(sid, "write")).toBe(false);
	});

	it("an empty session id records nothing — the feature stays inert", () => {
		approveToolForSession("", "bash");
		addSimilarApproval("", "bash", "echo hi");
		expect(isToolApprovedForSession("", "bash")).toBe(false);
		expect(getSimilarApprovals("", "bash")).toEqual([]);
	});

	it("similar approvals are kept newest-first, deduped, and capped at 10 per tool", () => {
		const sid = newSessionId();
		for (let i = 1; i <= 12; i++) addSimilarApproval(sid, "bash", `cmd-${i}`);
		// The two oldest subjects fall off the back of the cap.
		expect(getSimilarApprovals(sid, "bash")).toEqual([
			"cmd-12",
			"cmd-11",
			"cmd-10",
			"cmd-9",
			"cmd-8",
			"cmd-7",
			"cmd-6",
			"cmd-5",
			"cmd-4",
			"cmd-3",
		]);
		// Re-approving a recorded subject refreshes it without duplicating.
		addSimilarApproval(sid, "bash", "cmd-5");
		expect(getSimilarApprovals(sid, "bash")).toEqual([
			"cmd-5",
			"cmd-12",
			"cmd-11",
			"cmd-10",
			"cmd-9",
			"cmd-8",
			"cmd-7",
			"cmd-6",
			"cmd-4",
			"cmd-3",
		]);
		// Subjects are recorded per tool, not per session-wide list.
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
	});

	it("whole-tool approval supersedes that tool's similar list but not other tools'", () => {
		const sid = newSessionId();
		addSimilarApproval(sid, "bash", "git status");
		addSimilarApproval(sid, "write", "src/a.ts");
		approveToolForSession(sid, "bash");
		expect(getSimilarApprovals(sid, "bash")).toEqual([]);
		expect(isToolApprovedForSession(sid, "bash")).toBe(true);
		expect(getSimilarApprovals(sid, "write")).toEqual(["src/a.ts"]);
	});

	it("clearSessionApprovals wipes only the targeted session's state", () => {
		const sid = newSessionId();
		const other = newSessionId();
		approveToolForSession(sid, "bash");
		addSimilarApproval(sid, "write", "src/a.ts");
		approveToolForSession(other, "bash");
		clearSessionApprovals(sid);
		expect(isToolApprovedForSession(sid, "bash")).toBe(false);
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
		expect(isToolApprovedForSession(other, "bash")).toBe(true);
	});
});

describe("approvalSubject", () => {
	it("uses the raw command string for command-shaped args", () => {
		expect(approvalSubject({ command: "git status", timeout: 30 })).toBe("git status");
	});

	it("falls back to sorted-key JSON that is independent of key insertion order", () => {
		expect(approvalSubject({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		// Equivalent nested args must produce the identical subject — the
		// similarity classifier compares these strings for equality.
		const first = approvalSubject({ x: { b: 2, a: 1 }, c: 3 });
		const second = approvalSubject({ c: 3, x: { a: 1, b: 2 } });
		expect(first).toBe('{"c":3,"x":{"a":1,"b":2}}');
		expect(second).toBe(first);
	});

	it("treats a non-string or empty command field as absent", () => {
		expect(approvalSubject({ command: 42, a: 1 })).toBe('{"a":1,"command":42}');
		expect(approvalSubject({ command: "" })).toBe('{"command":""}');
	});

	it("stringifies non-object args deterministically", () => {
		expect(approvalSubject(undefined)).toBe("null");
		expect(approvalSubject("echo hi")).toBe('"echo hi"');
		expect(approvalSubject([1, "a"])).toBe('[1,"a"]');
		// JSON.stringify drops undefined-valued properties; so does the subject.
		expect(approvalSubject({ a: undefined, b: 1 })).toBe('{"b":1}');
	});
});
