import { afterEach, describe, expect, it } from "bun:test";
import {
	addSimilarApproval,
	approvalIdentity,
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
		addSimilarApproval("", "bash", "echo hi", "id-1");
		expect(isToolApprovedForSession("", "bash")).toBe(false);
		expect(getSimilarApprovals("", "bash")).toEqual([]);
	});

	it("similar approvals are kept newest-first, deduped by identity, and capped at 10 per tool", () => {
		const sid = newSessionId();
		const subjects = () => getSimilarApprovals(sid, "bash").map(entry => entry.subject);
		for (let i = 1; i <= 12; i++) addSimilarApproval(sid, "bash", `cmd-${i}`, `id-${i}`);
		// The two oldest subjects fall off the back of the cap.
		expect(subjects()).toEqual([
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
		// Re-approving the same call refreshes it without duplicating.
		addSimilarApproval(sid, "bash", "cmd-5", "id-5");
		expect(subjects()).toEqual([
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
		// Same display text, different arguments: two grants, not one — the
		// display subject never merges distinct calls.
		addSimilarApproval(sid, "bash", "cmd-5", "id-5-other-args");
		expect(subjects().slice(0, 2)).toEqual(["cmd-5", "cmd-5"]);
		expect(
			getSimilarApprovals(sid, "bash")
				.map(entry => entry.identity)
				.slice(0, 2),
		).toEqual(["id-5-other-args", "id-5"]);
		// Subjects are recorded per tool, not per session-wide list.
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
	});

	it("truncates a bulk subject for retention without merging calls that differ past the bound", () => {
		const sid = newSessionId();
		const head = `Path: src/a.ts\nContent: ${"x".repeat(200)}`;
		const bulk = `${head}${"y".repeat(64 * 1024)}`;
		addSimilarApproval(sid, "write", bulk, "id-safe");
		const [recorded, ...rest] = getSimilarApprovals(sid, "write");
		expect(rest).toEqual([]);
		// Bounded, but the head the classifier reads survives intact.
		expect(recorded?.subject.length).toBe(4096);
		expect(recorded?.subject.startsWith(head)).toBe(true);
		expect(recorded?.subject.endsWith("…")).toBe(true);
		// Two calls whose subjects are identical after that bound stay two
		// grants: the identity, not the retained text, decides what repeats.
		addSimilarApproval(sid, "write", `${bulk}-different-tail`, "id-pwn");
		expect(getSimilarApprovals(sid, "write").map(entry => entry.identity)).toEqual(["id-pwn", "id-safe"]);
		expect(getSimilarApprovals(sid, "write")[0]?.subject).toBe(recorded?.subject);
	});

	it("whole-tool approval supersedes that tool's similar list but not other tools'", () => {
		const sid = newSessionId();
		addSimilarApproval(sid, "bash", "git status", "id-bash");
		addSimilarApproval(sid, "write", "src/a.ts", "id-write");
		approveToolForSession(sid, "bash");
		expect(getSimilarApprovals(sid, "bash")).toEqual([]);
		expect(isToolApprovedForSession(sid, "bash")).toBe(true);
		expect(getSimilarApprovals(sid, "write")).toEqual([{ identity: "id-write", subject: "src/a.ts" }]);
	});

	it("clearSessionApprovals wipes only the targeted session's state", () => {
		const sid = newSessionId();
		const other = newSessionId();
		approveToolForSession(sid, "bash");
		addSimilarApproval(sid, "write", "src/a.ts", "id-write");
		approveToolForSession(other, "bash");
		clearSessionApprovals(sid);
		expect(isToolApprovedForSession(sid, "bash")).toBe(false);
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
		expect(isToolApprovedForSession(other, "bash")).toBe(true);
	});
});

describe("approvalIdentity", () => {
	it("separates calls whose approval subjects are identical after truncation", () => {
		// Every tool cuts bulk payloads to 2000 chars for the prompt, and the store
		// bounds the result again at 4096, so these two writes are recorded as the
		// same text. Only the identity keeps them apart, and it must, or approving
		// the first auto-approves the second with no model and no prompt.
		const head = "x".repeat(8_000);
		expect(approvalIdentity({ content: `${head}SAFE`, path: "src/a.ts" })).not.toBe(
			approvalIdentity({ content: `${head}PWN!`, path: "src/a.ts" }),
		);
	});

	it("is independent of key insertion order so a true repeat matches itself", () => {
		expect(approvalIdentity({ content: "a", path: "src/a.ts" })).toBe(
			approvalIdentity({ path: "src/a.ts", content: "a" }),
		);
		expect(approvalIdentity({ nested: { b: 2, a: 1 } })).toBe(approvalIdentity({ nested: { a: 1, b: 2 } }));
	});
});

describe("approvalSubject", () => {
	/** A tool declaring no approval detail lines — the structural fallback path. */
	const plain = {};
	/** Shaped like the real `write` tool's formatter (`src/tools/write.ts`). */
	const writeLike = {
		formatApprovalDetails: (args: unknown): string[] => {
			const params = args as { path?: string; content?: string };
			return [`Path: ${params.path ?? "(missing)"}`, `Content:\n${params.content ?? ""}`];
		},
	};

	it("prefers the tool's approval detail lines so truncation cannot hide the target", () => {
		const content = 'import * as fs from "node:fs/promises";\n'.repeat(20);
		const subject = approvalSubject(writeLike, { content, path: "src/deep/module/handler.ts" });
		expect(subject.startsWith("Path: src/deep/module/handler.ts\nContent:\n")).toBe(true);
		// The classifier head-truncates each recorded subject to 160 chars; the
		// path must survive that budget or every file sharing an import
		// prologue classifies as "similar".
		expect(subject.slice(0, 160)).toContain("src/deep/module/handler.ts");
	});

	it("accepts a single detail string and drops empty detail lines", () => {
		expect(approvalSubject({ formatApprovalDetails: () => "Command: git status" }, { command: "ls" })).toBe(
			"Command: git status",
		);
		expect(approvalSubject({ formatApprovalDetails: () => ["", "Action: open"] }, {})).toBe("Action: open");
	});

	it("falls back to the raw command when details are absent, empty, or throw", () => {
		expect(approvalSubject(plain, { command: "git status", timeout: 30 })).toBe("git status");
		expect(approvalSubject({ formatApprovalDetails: () => [] }, { command: "git status" })).toBe("git status");
		// A third-party formatter that throws must not fail the tool call.
		const thrower = {
			formatApprovalDetails: (): string => {
				throw new Error("formatter exploded");
			},
		};
		expect(approvalSubject(thrower, { command: "git status" })).toBe("git status");
	});

	it("puts bulk payload fields last in the JSON fallback", () => {
		const content = "x".repeat(400);
		const subject = approvalSubject(plain, { content, path: "src/a.ts" });
		expect(subject.startsWith('{"path":"src/a.ts","content":')).toBe(true);
		// Key insertion order must not change the subject: recorded and
		// candidate subjects are compared as strings.
		expect(approvalSubject(plain, { path: "src/a.ts", content })).toBe(subject);
	});

	it("falls back to sorted-key JSON that is independent of key insertion order", () => {
		expect(approvalSubject(plain, { b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		// Equivalent nested args must produce the identical subject — the
		// similarity classifier compares these strings for equality.
		const first = approvalSubject(plain, { x: { b: 2, a: 1 }, c: 3 });
		const second = approvalSubject(plain, { c: 3, x: { a: 1, b: 2 } });
		expect(first).toBe('{"c":3,"x":{"a":1,"b":2}}');
		expect(second).toBe(first);
	});

	it("treats a non-string or empty command field as absent", () => {
		expect(approvalSubject(plain, { command: 42, a: 1 })).toBe('{"a":1,"command":42}');
		expect(approvalSubject(plain, { command: "" })).toBe('{"command":""}');
	});

	it("stringifies non-object args deterministically", () => {
		expect(approvalSubject(plain, undefined)).toBe("null");
		expect(approvalSubject(plain, "echo hi")).toBe('"echo hi"');
		expect(approvalSubject(plain, [1, "a"])).toBe('[1,"a"]');
		// JSON.stringify drops undefined-valued properties; so does the subject.
		expect(approvalSubject(plain, { a: undefined, b: 1 })).toBe('{"b":1}');
	});
});
