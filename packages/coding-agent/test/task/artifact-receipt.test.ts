/**
 * Contract for the subagent output artifact receipt (issue #9646).
 *
 * A completed task may only advertise `agent://<id>` after the bytes were
 * written AND read back. The receipt carries the URI, SHA-256, and byte count
 * so the parent can verify the pointer it was handed; when the write cannot be
 * verified there is no receipt and no pointer at all.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { writeVerifiedAgentOutput } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../../src/prompts/tools/task-summary.md" with { type: "text" };

describe("writeVerifiedAgentOutput", () => {
	it("returns a receipt whose hash and byte count match the file on disk", async () => {
		using dir = TempDir.createSync("@omp-artifact-receipt-");
		const body = "Findings: rate limiter drops the Retry-After header.\nSee auth/rate-limit.ts:88.\n";

		const written = await writeVerifiedAgentOutput(dir.path(), "Auditor", body);
		if (!written.ok) throw new Error(`expected a receipt, got: ${written.error}`);

		const { artifact } = written;
		expect(artifact.uri).toBe("agent://Auditor");
		expect(artifact.path).toBe(path.join(dir.path(), "Auditor.md"));

		const onDisk = await Bun.file(artifact.path).bytes();
		expect(artifact.bytes).toBe(onDisk.byteLength);
		expect(artifact.sha256).toBe(new Bun.CryptoHasher("sha256").update(onDisk).digest("hex"));
		expect(await Bun.file(artifact.path).text()).toBe(body);
	});

	it("counts bytes, not UTF-16 units, for multi-byte output", async () => {
		using dir = TempDir.createSync("@omp-artifact-receipt-utf8-");
		// Four 3-byte characters: 12 bytes on disk, 4 UTF-16 units in memory.
		const body = "日本語訳";

		const written = await writeVerifiedAgentOutput(dir.path(), "Translator", body);
		if (!written.ok) throw new Error(`expected a receipt, got: ${written.error}`);

		expect(written.artifact.bytes).toBe(12);
		expect(written.artifact.charCount).toBe(4);
	});

	it("reports an error instead of a receipt when the artifact cannot be written", async () => {
		using dir = TempDir.createSync("@omp-artifact-receipt-fail-");
		// A file where the artifacts dir should be: every write below it fails.
		const notADir = path.join(dir.path(), "blocked");
		await Bun.write(notADir, "occupied");

		const written = await writeVerifiedAgentOutput(notADir, "Blocked", "result body");

		expect(written.ok).toBe(false);
		if (written.ok) throw new Error("expected a failure");
		expect(written.error.length).toBeGreaterThan(0);
	});
});

describe("task-result envelope", () => {
	const base = {
		agentName: "reviewer",
		id: "Auditor",
		status: "completed",
		duration: "8.7s",
		preview: "Findings: rate limiter drops the Retry-After header.",
		mergeSummary: "",
	};

	it("publishes the verified artifact URI, size, and hash", () => {
		const rendered = prompt.render(taskSummaryTemplate, {
			...base,
			truncated: true,
			artifact: {
				uri: "agent://Auditor",
				sha256: "d1e8a0b3c5f2",
				size: "12.4 KB",
				lineCount: 214,
			},
		});

		expect(rendered).toContain(
			'<artifact uri="agent://Auditor" bytes="12.4 KB" lines="214" sha256="d1e8a0b3c5f2" />',
		);
		expect(rendered).toContain('<preview full-output="agent://Auditor">');
		expect(rendered).not.toContain("<artifact-unavailable>");
	});

	it("never claims a full-output pointer when the artifact was not verified", () => {
		const rendered = prompt.render(taskSummaryTemplate, {
			...base,
			truncated: true,
			artifactError: "ENOSPC: no space left on device",
		});

		expect(rendered).not.toContain("full-output");
		expect(rendered).not.toContain("agent://");
		expect(rendered).toContain("<artifact-unavailable>");
		expect(rendered).toContain("ENOSPC: no space left on device");
	});
});
