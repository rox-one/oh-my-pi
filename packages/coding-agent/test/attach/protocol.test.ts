import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ATTACH_CAPABILITY_HEX_LENGTH,
	ATTACH_CMD_ACK_CACHE_SIZE,
	ATTACH_LEASE_PROOF_HEX_LENGTH,
	ATTACH_MAX_FRAME_BYTES,
	ATTACH_PROGRESS_MAX_LINE_LENGTH,
	ATTACH_PROGRESS_MAX_OUTPUT_LINES,
	ATTACH_PROGRESS_MAX_TOOL_LENGTH,
	ATTACH_TRANSCRIPT_ITEMS_PER_FRAME,
	ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES,
	ATTACH_TRANSCRIPT_MAX_STRING_CHARS,
	AttachBoundedQueue,
	AttachFrameAccumulator,
	type AttachMessage,
	AttachProtocolError,
	type AttachSessionEntry,
	type AttachSnapshot,
	boundAttachTranscriptEntry,
	boundAttachTranscriptItems,
	decodeAttachLine,
	encodeAttachMessage,
	formatAttachKey,
	generateAttachCapability,
	generateAttachLeaseProof,
	isAttachCapability,
	isAttachLeaseProof,
	isControllerRole,
	isHelloMessage,
	sanitizeAttachProgress,
	shrinkAttachSnapshot,
} from "../../src/attach/protocol";
import { attachKeyString, parseAttachKeyString } from "../../src/attach/registry";
import type { SessionMessageEntry } from "../../src/session/session-entries";

const KEY = { workerId: "w1", ownerScope: "scope-a" };
const PROOF = "b".repeat(64);
const LEASE = { leaseId: "lease-1", proof: PROOF, generation: 1, graceMs: 30_000 };

function hello(capability = "a".repeat(64), role: "pane" | "director" | "observer" = "pane") {
	return { kind: "hello" as const, version: 2, capability, client: { role, name: "t" } };
}

function messageEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function entry(overrides: Partial<AttachSessionEntry> = {}): AttachSessionEntry {
	return {
		key: KEY,
		state: "idle",
		createdAt: 1,
		updatedAt: 1,
		lastActivityAt: null,
		pendingFollowUps: 0,
		attachedClients: 1,
		summary: null,
		...overrides,
	};
}

function snapshot(sessions: AttachSessionEntry[] = []): AttachSnapshot {
	return { version: 2, generatedAt: 1, sessions };
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

describe("attach protocol lease proof", () => {
	it("generates a 64-char lowercase hex proof", () => {
		const a = generateAttachLeaseProof();
		const b = generateAttachLeaseProof();
		expect(a).toHaveLength(ATTACH_LEASE_PROOF_HEX_LENGTH);
		expect(a).toMatch(/^[0-9a-f]+$/);
		expect(a).not.toBe(b);
	});

	it("validates proof shape exactly", () => {
		expect(isAttachLeaseProof(generateAttachLeaseProof())).toBe(true);
		expect(isAttachLeaseProof("short")).toBe(false);
		expect(isAttachLeaseProof("Z".repeat(ATTACH_LEASE_PROOF_HEX_LENGTH))).toBe(false);
		expect(isAttachLeaseProof(42)).toBe(false);
		expect(isAttachLeaseProof(null)).toBe(false);
	});
});

describe("attach frame encoding/decoding", () => {
	it("round-trips every client message kind", () => {
		const messages = [
			hello(),
			hello("a".repeat(64), "director"),
			hello("a".repeat(64), "observer"),
			{
				kind: "view_open" as const,
				key: KEY,
			},
			{
				kind: "view_open" as const,
				key: KEY,
				resume: { leaseId: "lease-1", proof: PROOF, generation: 2 },
			},
			{
				kind: "prompt" as const,
				key: KEY,
				leaseId: "lease-1",
				proof: PROOF,
				generation: 1,
				cmdSeq: 1,
				cmdId: "cmd-1",
				ref: "r1",
				text: "continue",
				timeoutMs: 100,
			},
			{
				kind: "abort_turn" as const,
				key: KEY,
				leaseId: "lease-1",
				proof: PROOF,
				generation: 1,
				cmdSeq: 2,
				cmdId: "cmd-2",
			},
			{
				kind: "detach" as const,
				key: KEY,
				leaseId: "lease-1",
				proof: PROOF,
				generation: 1,
				reason: "user",
			},
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

	it("round-trips every server message kind", () => {
		const messages: AttachMessage[] = [
			{
				kind: "hello_ok",
				version: 2,
				server: { pid: 1, startedAt: 2 },
				snapshot: snapshot([entry()]),
			},
			{ kind: "view_open_ok", key: KEY, lease: LEASE, epoch: 1, entry: entry(), cwd: "/cwd" },
			{
				kind: "view_open_rejected",
				key: KEY,
				code: "lease_busy",
				message: "controlled",
				holder: { generation: 1, expiresInMs: 100 },
			},
			{ kind: "transcript_begin", key: KEY, epoch: 1, seq: 1 },
			{ kind: "transcript_items", key: KEY, epoch: 1, seq: 2, items: [messageEntry("m1", "hi")] },
			{ kind: "transcript_end", key: KEY, epoch: 1, seq: 3, watermark: 1, model: "deepseek/ds" },
			{
				kind: "transcript_append",
				key: KEY,
				epoch: 1,
				seq: 4,
				items: [messageEntry("m2", "more")],
				watermark: 1,
			},
			{ kind: "transcript_reset", key: KEY, epoch: 1, seq: 5, reason: "branch switched" },
			{ kind: "prompt_accepted", key: KEY, ref: "r1", cmdId: "cmd-1" },
			{ kind: "prompt_result", key: KEY, ref: "r1", cmdId: "cmd-1", ok: true, payload: "out" },
			{
				kind: "control_rejected",
				key: KEY,
				cmdId: "cmd-1",
				ref: "r1",
				code: "out_of_order",
				message: "stale sequence",
			},
			{ kind: "snapshot", snapshot: snapshot([entry()]) },
			{
				kind: "event",
				event: {
					type: "lease_granted",
					key: KEY,
					generation: 1,
				},
			},
			{ kind: "pong", nonce: 7 },
			// The decoder routes server `bye` through the client validator,
			// which drops the `reason` field (see the dedicated test below).
			{ kind: "bye" },
			{ kind: "error", code: "auth_failed", message: "bad capability" },
		];
		for (const message of messages) {
			const frame = encodeAttachMessage(message);
			expect(decodeAttachLine(frame.subarray(0, -1))).toEqual(message);
		}
	});

	it("round-trips a nested event with every event type", () => {
		const events: AttachMessage["kind"] extends never ? never : Extract<AttachMessage, { kind: "event" }>["event"][] =
			[
				{ type: "registered", key: KEY, entry: entry() },
				{ type: "updated", key: KEY, entry: entry({ state: "running" }) },
				{ type: "state", key: KEY, state: "running", at: 5 },
				{ type: "removed", key: KEY, reason: "killed" },
				{ type: "follow_up_accepted", key: KEY, ref: "r1" },
				{ type: "follow_up_result", key: KEY, ref: "r1", ok: true, payload: "out" },
				{ type: "abort_accepted", key: KEY },
				{ type: "lease_granted", key: KEY, generation: 1 },
				{ type: "lease_expired", key: KEY, reason: "grace" },
				{ type: "lease_revoked", key: KEY, reason: "detach" },
				{ type: "progress", key: KEY, at: 1, currentTool: "bash", outputTail: ["out"] },
			];
		for (const event of events) {
			const message: AttachMessage = { kind: "event", event };
			expect(decodeAttachLine(encodeAttachMessage(message).subarray(0, -1))).toEqual(message);
		}
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

describe("attach message validation", () => {
	function expectMalformed(value: unknown): void {
		try {
			decodeAttachLine(Buffer.from(JSON.stringify(value), "utf8"));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AttachProtocolError);
			expect((error as AttachProtocolError).code).toBe("malformed");
		}
	}

	it("validates hello strictly (version, capability shape, role)", () => {
		// v2 hello has no `subscribe` field; a stale v1 field is ignored and
		// the normalized message carries no subscribe.
		const stale = { ...hello(), subscribe: true };
		const decoded = decodeAttachLine(Buffer.from(JSON.stringify(stale), "utf8")) as Extract<
			AttachMessage,
			{ kind: "hello" }
		>;
		expect(decoded).toEqual(hello());
		expect("subscribe" in decoded).toBe(false);

		try {
			decodeAttachLine(Buffer.from(JSON.stringify({ ...hello(), version: 0 }), "utf8"));
			expect.unreachable();
		} catch (error) {
			expect((error as AttachProtocolError).code).toBe("malformed");
		}
		try {
			decodeAttachLine(Buffer.from(JSON.stringify({ ...hello(), capability: "not-hex!" }), "utf8"));
			expect.unreachable();
		} catch (error) {
			expect((error as AttachProtocolError).code).toBe("auth_failed");
		}
		expectMalformed({ ...hello(), client: { role: "root", name: "x" } });
		// A missing client name is fine; a non-object client is not.
		expect(() =>
			decodeAttachLine(Buffer.from(JSON.stringify({ ...hello(), client: { role: "pane" } }), "utf8")),
		).not.toThrow();
		expectMalformed({ ...hello(), client: "pane" });
	});

	it("validates view_open with and without resume", () => {
		expectMalformed({ kind: "view_open", key: { workerId: "w1" } });
		expectMalformed({ kind: "view_open", key: KEY, resume: { leaseId: "", proof: PROOF, generation: 1 } });
		expectMalformed({ kind: "view_open", key: KEY, resume: { leaseId: "L", proof: "bad", generation: 1 } });
		expectMalformed({ kind: "view_open", key: KEY, resume: { leaseId: "L", proof: PROOF } });
		expect(() =>
			decodeAttachLine(Buffer.from(JSON.stringify({ kind: "view_open", key: KEY, resume: undefined }), "utf8")),
		).not.toThrow();
	});

	it("validates prompt control headers", () => {
		const base = {
			kind: "prompt",
			key: KEY,
			leaseId: "L",
			proof: PROOF,
			generation: 1,
			cmdSeq: 1,
			cmdId: "c1",
			ref: "r1",
			text: "go",
		};
		expect(() => decodeAttachLine(Buffer.from(JSON.stringify(base), "utf8"))).not.toThrow();
		expectMalformed({ ...base, cmdSeq: 0 });
		expectMalformed({ ...base, cmdSeq: 1.5 });
		expectMalformed({ ...base, cmdId: "" });
		expectMalformed({ ...base, ref: "" });
		expectMalformed({ ...base, text: 42 });
		expectMalformed({ ...base, proof: "short" });
		expectMalformed({ ...base, leaseId: "" });
	});

	it("validates abort_turn and detach lease fields", () => {
		const abort = {
			kind: "abort_turn",
			key: KEY,
			leaseId: "L",
			proof: PROOF,
			generation: 1,
			cmdSeq: 1,
			cmdId: "c1",
		};
		expect(() => decodeAttachLine(Buffer.from(JSON.stringify(abort), "utf8"))).not.toThrow();
		expectMalformed({ ...abort, cmdId: "" });

		const detach = { kind: "detach", key: KEY, leaseId: "L", proof: PROOF, generation: 1, reason: "user" };
		expect(() => decodeAttachLine(Buffer.from(JSON.stringify(detach), "utf8"))).not.toThrow();
		expectMalformed({ ...detach, generation: "1" });
		expectMalformed({ ...detach, proof: "bad" });
	});

	it("validates transcript frames and their item arrays", () => {
		expectMalformed({
			kind: "transcript_items",
			key: KEY,
			epoch: 1,
			seq: 2,
			items: [{ type: "model_change", id: "x", timestamp: "t" }],
		});
		expectMalformed({ kind: "transcript_items", key: KEY, epoch: 1, seq: 2, items: "nope" });
		expectMalformed({ kind: "transcript_end", key: KEY, epoch: 1, seq: 3, watermark: "2" });
		expectMalformed({ kind: "transcript_reset", key: KEY, epoch: 1, seq: 4 });
	});

	it("validates view_open_rejected codes and holder", () => {
		for (const code of ["lease_busy", "unknown_worker", "stale_resume", "internal"]) {
			const message = { kind: "view_open_rejected", key: KEY, code, message: "no" };
			expect(() => decodeAttachLine(Buffer.from(JSON.stringify(message), "utf8"))).not.toThrow();
		}
		expectMalformed({ kind: "view_open_rejected", key: KEY, code: "nope", message: "no" });
		expectMalformed({
			kind: "view_open_rejected",
			key: KEY,
			code: "lease_busy",
			message: "no",
			holder: { generation: 1 },
		});
	});

	it("validates control_rejected codes", () => {
		const codes = [
			"lease_required",
			"stale_lease",
			"stale_generation",
			"foreign_client",
			"duplicate",
			"out_of_order",
			"busy",
			"forbidden",
			"unknown_worker",
			"internal",
		];
		for (const code of codes) {
			const message = { kind: "control_rejected", key: KEY, cmdId: "c", ref: "r", code, message: "no" };
			expect(() => decodeAttachLine(Buffer.from(JSON.stringify(message), "utf8"))).not.toThrow();
		}
		expectMalformed({ kind: "control_rejected", key: KEY, code: "nope", message: "no" });
	});

	it("validates error codes", () => {
		expect(() =>
			decodeAttachLine(Buffer.from(JSON.stringify({ kind: "error", code: "shutdown", message: "bye" }), "utf8")),
		).not.toThrow();
		expectMalformed({ kind: "error", code: "explode", message: "bye" });
	});

	it("drops the bye reason on decode (server bye routes through the client validator)", () => {
		const decoded = decodeAttachLine(Buffer.from(JSON.stringify({ kind: "bye", reason: "shutting down" }), "utf8"));
		expect(decoded).toEqual({ kind: "bye" });
	});

	it("classifies controller roles", () => {
		expect(isControllerRole("pane")).toBe(true);
		expect(isControllerRole("director")).toBe(true);
		expect(isControllerRole("observer")).toBe(false);
	});
});

describe("attach transcript item bounding", () => {
	const FRAME = { kind: "transcript_items" as const, key: KEY, epoch: 1 };

	/** Encoded UTF-8 byte length of a value's JSON serialization. */
	function encodedBytes(value: unknown): number {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	}

	/** Assistant message whose content is `blockCount` blocks of `text`. */
	function bigBlocksEntry(
		id: string,
		blockCount: number,
		text = "x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS),
	): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message: {
				role: "assistant",
				content: Array.from({ length: blockCount }, () => ({ type: "text", text })),
				timestamp: 1,
			} as unknown as AgentMessage,
		};
	}

	function hasLoneSurrogate(value: string): boolean {
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = value.charCodeAt(i + 1);
				if (i + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
				i += 1;
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				return true;
			}
		}
		return false;
	}

	it("chunks at ATTACH_TRANSCRIPT_ITEMS_PER_FRAME entries (count remains a maximum)", () => {
		const items = Array.from({ length: ATTACH_TRANSCRIPT_ITEMS_PER_FRAME + 1 }, (_, i) =>
			messageEntry(`m${i}`, `text-${i}`),
		);
		const chunks = boundAttachTranscriptItems(items, FRAME);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(ATTACH_TRANSCRIPT_ITEMS_PER_FRAME);
		expect(chunks[1]).toHaveLength(1);
		expect(chunks[1]![0]!.id).toBe(`m${ATTACH_TRANSCRIPT_ITEMS_PER_FRAME}`);
		for (const chunk of chunks) {
			const frame = encodeAttachMessage({ ...FRAME, seq: 1, items: chunk });
			expect(frame.byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
		}
	});

	it("returns no chunks for empty input (begin/end watermark-0 path)", () => {
		expect(boundAttachTranscriptItems([], FRAME)).toEqual([]);
	});

	it("splits near-budget entries by encoded frame bytes, not count alone", () => {
		// Each entry is 23 × 16 KiB ≈ 377 KiB encoded (under the 384 KiB
		// per-entry cap, so no truncation): three of them (~1.13 MiB) cannot
		// fit a 1 MiB frame even though the count cap (25) is nowhere near
		// hit — the chunker must split on bytes.
		const items = ["m1", "m2", "m3"].map(id => bigBlocksEntry(id, 23));
		const chunks = boundAttachTranscriptItems(items, FRAME);
		expect(chunks.map(chunk => chunk.map(entry => entry.id))).toEqual([["m1", "m2"], ["m3"]]);
		for (const chunk of chunks) {
			const frame = encodeAttachMessage({ ...FRAME, seq: 1, items: chunk });
			expect(frame.byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
		}
	});

	it("measures multibyte UTF-8 in bytes when packing chunks", () => {
		// 11 blocks × 16K code units of U+1F600 = ~32 KiB UTF-8 bytes per
		// block ≈ 361 KiB per entry: three entries exceed the 1 MiB frame in
		// BYTES while a char-based accountant (≈ 270K chars total) would keep
		// them in one chunk.
		const text = "\u{1F600}".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS / 2);
		const items = ["m1", "m2", "m3"].map(id => bigBlocksEntry(id, 11, text));
		const chunks = boundAttachTranscriptItems(items, FRAME);
		expect(chunks.map(chunk => chunk.map(entry => entry.id))).toEqual([["m1", "m2"], ["m3"]]);
		for (const chunk of chunks) {
			const frame = encodeAttachMessage({ ...FRAME, seq: 1, items: chunk });
			expect(frame.byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
		}
	});

	it("truncates long string content to the per-entry budget", () => {
		const long = "x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS * 2);
		const bounded = boundAttachTranscriptEntry(messageEntry("m1", long));
		// The fixture message is a user message with string content.
		const boundedMessage = bounded.message as { content: string };
		const content = boundedMessage.content;
		expect(content.length).toBeLessThan(long.length);
		expect(content.startsWith("x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS))).toBe(true);
		expect(content.endsWith("[truncated]")).toBe(true);
		expect(bounded.id).toBe("m1");
	});

	it("truncates long strings inside content blocks recursively", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "short" },
				{ type: "text", text: "y".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS + 50) },
				{ type: "text", text: "tail", extra: [{ label: "z".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS + 10) }] },
			],
			api: "test",
			provider: "test",
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "end_turn",
			timestamp: 1,
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message,
		};
		const bounded = boundAttachTranscriptEntry(entry);
		// The fixture message is an assistant message with text blocks.
		const boundedMessage = bounded.message as unknown as {
			content: Array<{ type: string; text: string; extra?: Array<{ label: string }> }>;
		};
		const blocks = boundedMessage.content;
		expect(blocks[0]!.text).toBe("short");
		expect(blocks[1]!.text).toHaveLength(ATTACH_TRANSCRIPT_MAX_STRING_CHARS + 13);
		expect(blocks[1]!.text.endsWith("[truncated]")).toBe(true);
		expect(blocks[2]!.text).toBe("tail");
		expect(blocks[2]!.extra![0]!.label).toHaveLength(ATTACH_TRANSCRIPT_MAX_STRING_CHARS + 13);
		expect(blocks[2]!.extra![0]!.label.endsWith("[truncated]")).toBe(true);
	});

	it("never truncates into a surrogate pair", () => {
		// The slice boundary lands on a high surrogate (first half of
		// U+1F600): the tail must drop it so the wire round-trip stays
		// code-point clean instead of a JSON-escaped lone surrogate.
		const text = "x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS - 2) + "\u{1F600}".repeat(2);
		const bounded = boundAttachTranscriptEntry(messageEntry("m1", text));
		const boundedMessage = bounded.message as { content: string };
		expect(hasLoneSurrogate(boundedMessage.content)).toBe(false);
		expect(boundedMessage.content.endsWith("[truncated]")).toBe(true);
		const decoded = decodeAttachLine(
			encodeAttachMessage({ ...FRAME, seq: 1, items: [bounded] }).subarray(0, -1),
		) as Extract<AttachMessage, { kind: "transcript_items" }>;
		const round = decoded.items[0]!.message as { content: string };
		expect(hasLoneSurrogate(round.content)).toBe(false);
	});

	it("enforces the encoded per-entry byte cap for content-array messages", () => {
		// 26 blocks × 16 KiB ≈ 426 KiB: every string sits at the per-string
		// char cap, so only a byte-accurate pass can force further truncation.
		const entry = bigBlocksEntry("m1", 26);
		expect(encodedBytes(entry)).toBeGreaterThan(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
		const bounded = boundAttachTranscriptEntry(entry);
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
		const boundedMessage = bounded.message as { content: Array<{ type: string; text: string }> };
		expect(boundedMessage.content[0]!.text.length).toBeLessThan(ATTACH_TRANSCRIPT_MAX_STRING_CHARS);
		// The bounded entry still fits a frame on its own.
		const frame = encodeAttachMessage({ ...FRAME, seq: 1, items: [bounded] });
		expect(frame.byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
	});

	it("enforces the encoded per-entry byte cap for nested-object payloads", () => {
		// toolCall-style args: strings nested inside objects inside content
		// blocks — the content char pass does not recurse into nested objects.
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					args: {
						files: Array.from(
							{ length: 40 },
							(_, i) => `path-${i}/${"y".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS)}`,
						),
					},
				},
			],
			api: "test",
			provider: "test",
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "end_turn",
			timestamp: 1,
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message,
		};
		expect(encodedBytes(entry)).toBeGreaterThan(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
		const bounded = boundAttachTranscriptEntry(entry);
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
	});

	it("enforces the encoded per-entry byte cap for non-content message kinds", () => {
		const custom = {
			type: "bashExecution",
			command: "x".repeat(600_000),
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m2",
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message: custom,
		};
		expect(encodedBytes(entry)).toBeGreaterThan(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
		const bounded = boundAttachTranscriptEntry(entry);
		expect(encodedBytes(bounded)).toBeLessThanOrEqual(ATTACH_TRANSCRIPT_MAX_ENTRY_BYTES);
		const boundedMessage = bounded.message as { command: string };
		expect(boundedMessage.command.length).toBeLessThan(600_000);
	});

	it("rejects an entry that cannot fit a frame even after bounding", () => {
		// Tens of thousands of short strings survive even maximal truncation
		// (each ≥ 14 chars with the suffix), so the encoded entry stays far
		// over the frame budget: the chunker must fail rather than emit an
		// oversized frame.
		const message = {
			role: "assistant",
			content: Array.from({ length: 40_000 }, (_, i) => ({ type: "text", text: `field-${i}-payload` })),
			timestamp: 1,
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message,
		};
		expect(() => boundAttachTranscriptItems([entry], FRAME)).toThrow(AttachProtocolError);
	});

	it("leaves short content and non-content messages untouched", () => {
		const short = messageEntry("m1", "hello");
		expect(boundAttachTranscriptEntry(short)).toBe(short);

		// Messages without a `content` field (custom message kinds) are
		// returned unchanged while they stay under the encoded per-entry
		// budget — their payloads are already bounded by the executor.
		const custom = {
			type: "bashExecution",
			command: "x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS * 2),
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m2",
			parentId: null,
			timestamp: "2026-08-11T00:00:00.000Z",
			message: custom,
		};
		expect(boundAttachTranscriptEntry(entry)).toBe(entry);
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
	const makeEntry = (workerId: string, updatedAt: number, summary: string) => ({
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
		const snap: AttachSnapshot = {
			version: 2,
			generatedAt: 100,
			sessions: [makeEntry("old", 1, "s"), makeEntry("mid", 2, "s"), makeEntry("new", 3, "s")],
		};
		const shrunk = shrinkAttachSnapshot(snap, { maxSessions: 2 });
		expect(shrunk.sessions.map(s => s.key.workerId)).toEqual(["new", "mid"]);
	});

	it("truncates summaries to maxSummaryLength", () => {
		const snap: AttachSnapshot = {
			version: 2,
			generatedAt: 100,
			sessions: [makeEntry("w", 1, "x".repeat(500))],
		};
		const shrunk = shrinkAttachSnapshot(snap, { maxSummaryLength: 8 });
		expect(shrunk.sessions[0].summary).toHaveLength(8);
	});

	it("leaves snapshots within bounds untouched", () => {
		const snap: AttachSnapshot = { version: 2, generatedAt: 1, sessions: [makeEntry("w", 1, "fine")] };
		expect(shrinkAttachSnapshot(snap)).toEqual(snap);
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

	it("exposes the command-ack cache bound constant", () => {
		expect(ATTACH_CMD_ACK_CACHE_SIZE).toBeGreaterThan(0);
	});
});
