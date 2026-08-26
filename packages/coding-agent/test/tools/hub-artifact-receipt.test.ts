import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { registerArtifactsDir } from "../../src/internal-urls/registry-helpers";
import { buildJobResult, snapshotJobs } from "../../src/tools/hub/jobs";
import type { CoordinationDetails } from "../../src/tools/hub/types";

const managers: AsyncJobManager[] = [];

function createManager(retentionMs?: number): AsyncJobManager {
	const manager = new AsyncJobManager(retentionMs === undefined ? {} : { retentionMs });
	managers.push(manager);
	return manager;
}

function resultText(result: AgentToolResult<CoordinationDetails>): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("expected a text result");
	return content.text;
}

async function settleTask(manager: AsyncJobManager, body: string): Promise<string> {
	const id = manager.register("task", "Auditor", async () => body, { id: "Auditor", agentId: "Auditor" });
	const job = manager.getJob(id);
	if (!job) throw new Error("expected the task job to be registered");
	await job.promise;
	return id;
}

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 200 });
	}
});

describe("hub task artifact receipts", () => {
	it("publishes only the task artifact URI carried by a verified matching receipt", async () => {
		const manager = createManager();
		const id = await settleTask(manager, "01234567890123456789");
		const receipt = {
			uri: "agent://Auditor",
			sha256: "a".repeat(64),
			bytes: 20,
			lineCount: 1,
			charCount: 20,
		};
		manager.setTaskArtifactOutcome(id, { outputMeta: receipt });
		const session = { asyncJobManager: manager };

		expect(snapshotJobs(session, manager.getAllJobs())[0]?.outputMeta).toEqual(receipt);
		expect(resultText(buildJobResult(session, manager, "jobs", manager.getAllJobs(), []))).toContain(
			"artifact 20 B at `agent://Auditor`",
		);

		const scopedReceipt = { ...receipt, uri: "agent://Auditor?lease=session-a" };
		manager.setTaskArtifactOutcome(id, { outputMeta: scopedReceipt });
		expect(snapshotJobs(session, manager.getAllJobs())[0]?.outputMeta).toEqual(scopedReceipt);

		manager.setTaskArtifactOutcome(id, { outputMeta: { ...receipt, uri: "agent://Other" } });
		const status = resultText(buildJobResult(session, manager, "jobs", manager.getAllJobs(), []));
		expect(status).toContain("read it with `wait` on this id");
		expect(status).not.toContain("agent://Other");
	});

	it("keeps a colliding task receipt on the resolved job ID", async () => {
		const manager = createManager();
		const retainedId = await settleTask(manager, "retained task body");
		const receipt = {
			uri: "agent://Auditor",
			sha256: "b".repeat(64),
			bytes: 9,
			lineCount: 1,
			charCount: 9,
		};
		const resolvedId = manager.register(
			"task",
			"Auditor",
			async ({ jobId }) => {
				await Promise.resolve();
				manager.setTaskArtifactOutcome(jobId, { outputMeta: receipt });
				return "new task";
			},
			{ id: "Auditor", agentId: "Auditor" },
		);
		const resolvedJob = manager.getJob(resolvedId);
		if (!resolvedJob) throw new Error("expected the colliding task job to be registered");
		await resolvedJob.promise;

		expect(resolvedId).not.toBe(retainedId);
		expect(manager.getJob(retainedId)?.outputMeta).toBeUndefined();
		expect(manager.getJob(resolvedId)?.outputMeta).toEqual(receipt);
		const session = { asyncJobManager: manager };
		expect(resultText(buildJobResult(session, manager, "jobs", manager.getAllJobs(), []))).toContain(
			"artifact 9 B at `agent://Auditor`",
		);
	});

	it("releases a published temporary artifact when its task job is evicted", async () => {
		using dir = TempDir.createSync("@omp-hub-artifact-eviction-");
		const lease = "eviction-test";
		const unregister = registerArtifactsDir(dir.path(), lease);
		const manager = createManager(60_000);
		const id = await settleTask(manager, "retained task body");
		const uri = `agent://Auditor?lease=${lease}`;
		await Bun.write(dir.join("Auditor.md"), "retained artifact body");
		const released = Promise.withResolvers<void>();
		const release = async (): Promise<void> => {
			try {
				unregister();
				await fs.rm(dir.path(), { recursive: true, force: true });
			} finally {
				released.resolve();
			}
		};
		manager.setTaskArtifactOutcome(
			id,
			{
				outputMeta: {
					uri,
					sha256: "c".repeat(64),
					bytes: 22,
					lineCount: 1,
					charCount: 22,
				},
			},
			release,
		);

		const handler = new AgentProtocolHandler();
		expect((await handler.resolve(parseInternalUrl(uri))).content).toBe("retained artifact body");
		expect(manager.evictCompletedJobs()).toBe(1);
		await released.promise;
		await expect(handler.resolve(parseInternalUrl(uri))).rejects.toThrow("Artifact lease unavailable");
	});

	it("keeps an unpersisted task result available through wait", async () => {
		const manager = createManager();
		const body = "The artifact write failed, but this delivery body remains available.";
		const id = await settleTask(manager, body);
		manager.setTaskArtifactOutcome(id, { artifactError: "artifact readback mismatch" });
		const session = { asyncJobManager: manager };

		const [snapshot] = snapshotJobs(session, manager.getAllJobs());
		expect(snapshot?.outputMeta).toBeUndefined();
		expect(snapshot?.artifactError).toBe("artifact readback mismatch");
		const jobs = resultText(buildJobResult(session, manager, "jobs", manager.getAllJobs(), []));
		expect(jobs).toContain("read it with `wait` on this id");
		expect(jobs).not.toContain("agent://Auditor");
		expect(resultText(buildJobResult(session, manager, "wait", manager.getAllJobs(), []))).toContain(body);
	});
});
