import { describe, expect, it } from "bun:test";
import { toolCallCwd, toolWriteTargets } from "@oh-my-pi/pi-coding-agent/tools/approval-write-targets";

/** Every relative path in this file resolves against it; grant keys are absolute. */
const REPO = "/repo";

describe("toolWriteTargets", () => {
	it("reads a write call's single target", () => {
		expect(toolWriteTargets("write", { path: "src/a.ts", content: "export {};" }, REPO)).toEqual([
			`${REPO}/src/a.ts`,
		]);
		expect(toolWriteTargets("write", { path: `${REPO}/src/a.ts`, content: "" }, "/elsewhere")).toEqual([
			`${REPO}/src/a.ts`,
		]);
		// Nothing to pin down: no argument names a file.
		expect(toolWriteTargets("write", { content: "export {};" }, REPO)).toEqual([]);
		expect(toolWriteTargets("write", "not an object", REPO)).toEqual([]);
	});

	it("reads an edit call's target in replace and patch shapes, including a rename destination", () => {
		expect(toolWriteTargets("edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, REPO)).toEqual([
			`${REPO}/src/a.ts`,
		]);
		// A patch entry may move the file: the destination is written too, so it
		// needs its own grant.
		expect(
			toolWriteTargets(
				"edit",
				{ path: "src/a.ts", edits: [{ op: "update", diff: "@@" }, { rename: "src/b.ts" }] },
				REPO,
			),
		).toEqual([`${REPO}/src/a.ts`, `${REPO}/src/b.ts`]);
	});

	it("reads every file a hashline patch touches, including an MV destination", () => {
		const input = ["[src/a.ts#A1B2]", "PUT 1.=1:", "+x", "[src/b.ts#C3D4]", "MV src/c.ts"].join("\n");

		// One `edit` call can write several files; a grant for one of them must not
		// stand in for the rest, so all of them are reported.
		expect(toolWriteTargets("edit", { input }, REPO)).toEqual([
			`${REPO}/src/a.ts`,
			`${REPO}/src/b.ts`,
			`${REPO}/src/c.ts`,
		]);
	});

	it("reads every file an apply-patch envelope touches, including a move destination", () => {
		const input = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+export {};",
			"*** Update File: src/old.ts",
			"*** Move to: src/moved.ts",
			"@@",
			"-a",
			"+b",
			"*** Delete File: src/gone.ts",
			"*** End Patch",
		].join("\n");

		expect(toolWriteTargets("edit", { input }, REPO)).toEqual([
			`${REPO}/src/new.ts`,
			`${REPO}/src/old.ts`,
			`${REPO}/src/moved.ts`,
			`${REPO}/src/gone.ts`,
		]);
	});

	it("reports nothing for input neither patch dialect accepts", () => {
		// A call that cannot apply grants nothing, and a parse failure must not
		// escape into the approval gate.
		expect(toolWriteTargets("edit", { input: "just prose" }, REPO)).toEqual([]);
		expect(toolWriteTargets("edit", { input: "*** Begin Patch\n*** End Patch" }, REPO)).toEqual([]);
		expect(toolWriteTargets("edit", { input: "" }, REPO)).toEqual([]);
	});

	it("reports nothing for a tool whose targets only a model can read out of it", () => {
		// `bash` writes through a shell command, so its file grants come from the
		// classifier's cited targets instead — structural coverage would let
		// `rm -rf src/a.ts` ride a grant to write `src/a.ts`.
		expect(toolWriteTargets("bash", { command: "echo hi > src/a.ts" }, REPO)).toEqual([]);
		expect(toolWriteTargets("task", { prompt: "write src/a.ts" }, REPO)).toEqual([]);
	});

	it("drops targets no grant key can pin down, and repeats", () => {
		// Handler-owned schemes are not files, and a glob names a set that would
		// widen with the filesystem.
		expect(toolWriteTargets("write", { path: "local://notes.md", content: "" }, REPO)).toEqual([]);
		expect(toolWriteTargets("write", { path: "src/*.ts", content: "" }, REPO)).toEqual([]);
		expect(toolWriteTargets("edit", { path: "src/a.ts", edits: [{ rename: "./src/a.ts" }] }, REPO)).toEqual([
			`${REPO}/src/a.ts`,
		]);
	});
});

describe("toolCallCwd", () => {
	it("follows a bash call's own cwd and falls back to the session's", () => {
		// `bash` may run anywhere, so a relative target of its command resolves
		// against the directory that call actually uses.
		expect(toolCallCwd("bash", { command: "ls", cwd: "packages/tui" }, REPO)).toBe(`${REPO}/packages/tui`);
		expect(toolCallCwd("bash", { command: "ls", cwd: "/tmp/build" }, REPO)).toBe("/tmp/build");
		expect(toolCallCwd("bash", { command: "ls" }, REPO)).toBe(REPO);
		expect(toolCallCwd("bash", { command: "ls", cwd: "" }, REPO)).toBe(REPO);
		// A value that is no directory this session can pin down leaves the session
		// cwd in place rather than producing a grant key nothing will match.
		expect(toolCallCwd("bash", { command: "ls", cwd: "local://sandbox" }, REPO)).toBe(REPO);
	});

	it("ignores a cwd argument on any other tool", () => {
		// Only `bash` has a `cwd` argument; for the file tools the session's own
		// directory is the one their paths resolve against.
		expect(toolCallCwd("write", { path: "a.ts", content: "", cwd: "/tmp" }, REPO)).toBe(REPO);
		expect(toolCallCwd("edit", { path: "a.ts" }, REPO)).toBe(REPO);
	});
});
