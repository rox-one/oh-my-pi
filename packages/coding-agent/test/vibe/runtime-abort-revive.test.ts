import { describe, expect, it } from "bun:test";
import { vibeWorkerSurvivesTurnSettle } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

/**
 * Regression (attach v2 live failure 2026-08-13): a pane Ctrl-C abort of a
 * vibe worker's in-flight follow-up turn unregistered the worker and closed
 * its owned pane. The abort unwinding can race the agent_end → idle status
 * sync, so at settle time the agent ref may still be `running`. The settle
 * decision must treat a pane abort (user interrupt) as revivable — the
 * worker survives registered/idle — while kill, suspension, a terminal ref,
 * and ordinary non-idle settles stay terminal.
 */
describe("vibeWorkerSurvivesTurnSettle", () => {
	it("keeps a worker alive on a pane abort even while the agent ref is still running", () => {
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: "running",
			}),
		).toBe(true);
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: "idle",
			}),
		).toBe(true);
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: "parked",
			}),
		).toBe(true);
	});

	it("keeps a worker alive on a pane abort with a MISSING ref (pre-monitor/spawn window)", () => {
		// The Ctrl-C landed before the worker's session (and its agent ref)
		// existed. The record survives idle WITHOUT a phantom session claim;
		// the next prompt re-spawns a fresh session.
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: undefined,
			}),
		).toBe(true);
	});

	it("keeps ordinary non-abort settles terminal when the ref is not idle/parked", () => {
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: false,
				registeredStatus: "running",
			}),
		).toBe(false);
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: false,
				registeredStatus: undefined,
			}),
		).toBe(false);
	});

	it("never revives killed or suspended workers, even under a pane abort", () => {
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: true,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: "idle",
			}),
		).toBe(false);
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: true,
				paneAbortPending: true,
				registeredStatus: "idle",
			}),
		).toBe(false);
	});

	it("treats a terminal aborted ref as dead even under a pane abort", () => {
		expect(
			vibeWorkerSurvivesTurnSettle({
				killed: false,
				suspended: false,
				paneAbortPending: true,
				registeredStatus: "aborted",
			}),
		).toBe(false);
	});
});
