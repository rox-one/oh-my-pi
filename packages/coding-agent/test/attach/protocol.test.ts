import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import {
	ATTACH_CAPABILITY_HEX_LENGTH,
	ATTACH_MAX_FRAME_BYTES,
	ATTACH_PROGRESS_MAX_LINE_LENGTH,
	ATTACH_PROGRESS_MAX_OUTPUT_LINES,
	ATTACH_PROGRESS_MAX_TOOL_LENGTH,
	AttachBoundedQueue,
	AttachFrameAccumulator,
	AttachProtocolError,
	type AttachSnapshot,
	decodeAttachLine,
	encodeAttachMessage,
	formatAttachKey,
	generateAttachCapability,
	isAttachCapability,
	isHelloMessage,
	sanitizeAttachProgress,
	shrinkAttachSnapshot,
} from "../../src/attach/protocol";
import { attachKeyString, parseAttachKeyString } from "../../src/attach/registry";

const KEY = { workerId: "w1", ownerScope: "scope-a" };

function hello(capability = "a".repeat(64)) {
	return { kind: "hello" as const, version: 1, capability, client: { role: "pane" as const, name: "t" } };
}

describe("attach protocol capability", () => {
	it("generates a 64-char lowercase hex capability", () => {
		const a = generateAttachCapability();
		const b = generateAttachCapability();
		expect(a).toHaveLength(ATTACH_CAPABILITY_HEX_LENGTH);
		expect(a).toMatch(/^[0-9a-f]+$/);
		expect(a).not.toBe(b);
	});

	it("validates capability shape exactly", () => {
		expect(isAttachCapability(generateAttachCapability())).toBe(true);
		expect(isAttachCapability("short")).toBe(false);
		expect(isAttachCapability("Z".repeat(ATTACH_CAPABILITY_HEX_LENGTH))).toBe(false);
		expect(isAttachCapability(42)).toBe(false);
		expect(isAttachCapability(null)).toBe(false);
	});
});

describe("attach frame encoding/decoding", () => {
	it("round-trips every client message kind", () => {
		const messages = [
			hello(),
			{ kind: "subscribe" as const, workerIds: ["w1"], ownerScopes: ["scope-a"] },
			{ kind: "follow_up" as const, ref: "r1", key: KEY, payload: "prompt", timeoutMs: 100 },
			{ kind: "abort" as const, key: KEY, reason: "user" },
			{ kind: "ping" as const, nonce: 7 },
			{ kind: "bye" as const },
		];
		for (const message of messages) {
			const frame = encodeAttachMessage(message);
			expect(frame[frame.byteLength - 1]).toBe(0x0a); // newline-terminated
			expect(decodeAttachLine(frame.subarray(0, -1))).toEqual(message);
		}
	});

	it("round-trips server messages with nested snapshot and event", () => {
		const message = {
			kind: "event" as const,
			event: {
				type: "state" as const,
				key: KEY,
				state: "running" as const,
				at: 5,
			},
		};
		expect(decodeAttachLine(encodeAttachMessage(message).subarray(0, -1))).toEqual(message);
	});

	it("rejects empty and malformed frames", () => {
		expect(() => decodeAttachLine(Buffer.alloc(0))).toThrowError(AttachProtocolError);
		expect(() => decodeAttachLine(Buffer.from("not json", "utf8"))).toThrowError(AttachProtocolError);
		try {
			decodeAttachLine(Buffer.from("[]", "utf8"));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AttachProtocolError);
			expect((error as AttachProtocolError).code).toBe("malformed");
		}
	});

	it("rejects unknown kinds and missing kind fields", () => {
		try {
			decodeAttachLine(Buffer.from(JSON.stringify({ kind: "explode" }), "utf8"));
			expect.unreachable();
		} catch (error) {
			expect((error as AttachProtocolError).code).toBe("unknown_kind");
		}
		try {
			decodeAttachLine(Buffer.from("{}", "utf8"));
			expect.unreachable();
		} catch (error) {
			expect((error as AttachProtocolError).code).toBe("malformed");
		}
	});

	it("rejects frames larger than the 1 MiB cap", () => {
		const oversized = { kind: "ping" as const, nonce: 0, pad: "x".repeat(ATTACH_MAX_FRAME_BYTES) };
		expect(() => encodeAttachMessage(oversized)).toThrowError(AttachProtocolError);
	});

	it("identifies hello messages for strict hello-first auth", () => {
		expect(isHelloMessage(hello())).toBe(true);
		expect(isHelloMessage({ kind: "ping" as const })).toBe(false);
	});
});

describe("attach frame accumulator (bounded framing)", () => {
	it("splits a stream across chunks and strips delimiters", () => {
		const accumulator = new AttachFrameAccumulator();
		const frame = encodeAttachMessage(hello());
		const half = Math.floor(frame.byteLength / 2);
		expect(accumulator.push(frame.subarray(0, half))).toEqual([]);
		expect(accumulator.push(frame.subarray(half))).toEqual([frame.subarray(0, -1)]);
		expect(accumulator.pendingBytes).toBe(0);
	});

	it("extracts multiple frames from a single chunk", () => {
		const accumulator = new AttachFrameAccumulator();
		const a = encodeAttachMessage({ kind: "ping" as const, nonce: 1 });
		const b = encodeAttachMessage({ kind: "ping" as const, nonce: 2 });
		const frames = accumulator.push(Buffer.concat([a, b]));
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual(a.subarray(0, -1));
		expect(frames[1]).toEqual(b.subarray(0, -1));
	});

	it("throws frame_too_large for a partial frame over the cap", () => {
		const accumulator = new AttachFrameAccumulator();
		try {
			accumulator.push(Buffer.alloc(ATTACH_MAX_FRAME_BYTES + 1));
			expect.unreachable();
		} catch (error) {
			expect((error as AttachProtocolError).code).toBe("frame_too_large");
		}
	});

	it("throws frame_too_large for a complete frame over the cap", () => {
		const accumulator = new AttachFrameAccumulator();
		const chunk = Buffer.concat([Buffer.alloc(ATTACH_MAX_FRAME_BYTES + 1), Buffer.from("\n", "utf8")]);
		expect(() => accumulator.push(chunk)).toThrowError(AttachProtocolError);
	});
});

describe("attach bounded write queue (backpressure)", () => {
	it("enforces the frame cap", () => {
		const queue = new AttachBoundedQueue<Buffer>(frame => frame.byteLength, 2, 1_000_000);
		expect(queue.enqueue(Buffer.from("a"))).toBe(true);
		expect(queue.enqueue(Buffer.from("b"))).toBe(true);
		expect(queue.enqueue(Buffer.from("c"))).toBe(false);
		expect(queue.isOverHighWater).toBe(true);
		expect(queue.length).toBe(2);
	});

	it("enforces the byte cap and accounts dequeue", () => {
		const queue = new AttachBoundedQueue<Buffer>(frame => frame.byteLength, 10, 10);
		expect(queue.enqueue(Buffer.from("12345"))).toBe(true);
		expect(queue.enqueue(Buffer.from("123456"))).toBe(false); // 5 + 6 > 10
		const item = queue.dequeue();
		expect(item).toEqual(Buffer.from("12345"));
		expect(queue.bytes).toBe(0);
		expect(queue.enqueue(Buffer.from("123456"))).toBe(true);
	});
});

describe("attach snapshot shrinking", () => {
	const entry = (workerId: string, updatedAt: number, summary: string) => ({
		key: { workerId, ownerScope: "scope-a" },
		state: "idle" as const,
		createdAt: 0,
		updatedAt,
		lastActivityAt: null,
		pendingFollowUps: 0,
		attachedClients: 0,
		summary,
	});

	it("keeps the most recently updated sessions when capped", () => {
		const snapshot: AttachSnapshot = {
			version: 1,
			generatedAt: 100,
			sessions: [entry("old", 1, "s"), entry("mid", 2, "s"), entry("new", 3, "s")],
		};
		const shrunk = shrinkAttachSnapshot(snapshot, { maxSessions: 2 });
		expect(shrunk.sessions.map(s => s.key.workerId)).toEqual(["new", "mid"]);
	});

	it("truncates summaries to maxSummaryLength", () => {
		const snapshot: AttachSnapshot = {
			version: 1,
			generatedAt: 100,
			sessions: [entry("w", 1, "x".repeat(500))],
		};
		const shrunk = shrinkAttachSnapshot(snapshot, { maxSummaryLength: 8 });
		expect(shrunk.sessions[0].summary).toHaveLength(8);
	});

	it("leaves snapshots within bounds untouched", () => {
		const snapshot: AttachSnapshot = { version: 1, generatedAt: 1, sessions: [entry("w", 1, "fine")] };
		expect(shrinkAttachSnapshot(snapshot)).toEqual(snapshot);
	});
});

describe("attach progress sanitization", () => {
	it("omits empty and whitespace-only optional fields", () => {
		expect(sanitizeAttachProgress({ outputTail: [] })).toEqual({ outputTail: [] });
		expect(
			sanitizeAttachProgress({ currentTool: "", currentToolArgs: "  ", lastIntent: "", outputTail: [] }),
		).toEqual({
			outputTail: [],
		});
		expect("currentTool" in sanitizeAttachProgress({ outputTail: [] })).toBe(false);
		expect("lastIntent" in sanitizeAttachProgress({ outputTail: [] })).toBe(false);
	});

	it("keeps non-empty optional fields and bounds content", () => {
		const result = sanitizeAttachProgress({
			currentTool: "bash",
			currentToolArgs: "ls -la",
			lastIntent: "check the files",
			outputTail: ["a", "b"],
		});
		expect(result.currentTool).toBe("bash");
		expect(result.currentToolArgs).toBe("ls -la");
		expect(result.lastIntent).toBe("check the files");
		expect(result.outputTail).toEqual(["a", "b"]);
	});

	it("collapses multi-line values to their first line and caps length", () => {
		const long = "x".repeat(ATTACH_PROGRESS_MAX_TOOL_LENGTH + 50);
		const result = sanitizeAttachProgress({
			currentTool: `${long}\nsecond line`,
			outputTail: ["line1\nline2", "y".repeat(ATTACH_PROGRESS_MAX_LINE_LENGTH + 50)],
		});
		expect(result.currentTool).toBe("x".repeat(ATTACH_PROGRESS_MAX_TOOL_LENGTH));
		expect(result.outputTail).toEqual(["line1", "y".repeat(ATTACH_PROGRESS_MAX_LINE_LENGTH)]);
	});

	it("keeps only the last ATTACH_PROGRESS_MAX_OUTPUT_LINES tail lines", () => {
		const result = sanitizeAttachProgress({
			outputTail: Array.from({ length: ATTACH_PROGRESS_MAX_OUTPUT_LINES + 2 }, (_, i) => `out-${i}`),
		});
		expect(result.outputTail).toEqual(["out-2", "out-3", "out-4"]);
	});
});

describe("attach key helpers", () => {
	it("round-trips through key strings with NUL separator", () => {
		const keyString = attachKeyString(KEY);
		expect(keyString).toBe("scope-a\u0000w1");
		expect(parseAttachKeyString(keyString)).toEqual(KEY);
	});

	it("handles an empty owner scope", () => {
		const keyString = attachKeyString({ workerId: "bare", ownerScope: "" });
		expect(parseAttachKeyString(keyString)).toEqual({ workerId: "bare", ownerScope: "" });
	});

	it("formats stable labels", () => {
		expect(formatAttachKey(KEY)).toBe("scope-a/w1");
	});
});
