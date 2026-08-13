import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { AttachLiveSessionSource } from "../../src/attach/live-session";
import {
	ATTACH_MAX_FRAME_BYTES,
	ATTACH_TRANSCRIPT_MAX_STRING_CHARS,
	type AttachMessage,
	encodeAttachMessage,
} from "../../src/attach/protocol";
import { AttachRegistry } from "../../src/attach/registry";
import { ATTACH_SOCKET_FILE, ATTACH_TOKEN_FILE, AttachServer } from "../../src/attach/server";
import type { SessionMessageEntry } from "../../src/session/session-entries";

const KEY = { workerId: "w1", ownerScope: "scope-a" };
const PROOF = "b".repeat(64);

/** Minimal client: connects, sends frames, buffers decoded server messages. */
class TestClient {
	readonly messages: AttachMessage[] = [];
	readonly #socket: net.Socket;
	#closed: Promise<void>;
	#buffer = "";

	private constructor(socket: net.Socket, closed: Promise<void>) {
		this.#socket = socket;
		this.#closed = closed;
		socket.on("data", chunk => {
			this.#buffer += chunk.toString("utf8");
			let index = this.#buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.#buffer.slice(0, index);
				this.#buffer = this.#buffer.slice(index + 1);
				if (line.length > 0) this.messages.push(JSON.parse(line) as AttachMessage);
				index = this.#buffer.indexOf("\n");
			}
		});
	}

	static connect(socketFile: string): Promise<TestClient> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(socketFile);
			socket.once("error", reject);
			socket.once("connect", () => {
				socket.removeListener("error", reject);
				socket.on("error", () => {
					// Closure performs accounting; the close event follows.
				});
				const closed = new Promise<void>(resolveClosed => {
					socket.once("close", () => resolveClosed());
				});
				resolve(new TestClient(socket, closed));
			});
		});
	}

	send(message: AttachMessage): void {
		this.#socket.write(encodeAttachMessage(message));
	}

	sendRaw(data: Buffer): void {
		this.#socket.write(data);
	}

	/** Resolve once a message matching `predicate` has arrived (polling, deterministic). */
	async waitForMessage(predicate: (message: AttachMessage) => boolean, timeoutMs = 2000): Promise<AttachMessage> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.messages.find(predicate);
			if (found) return found;
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		throw new Error(`timed out waiting for message; got: ${JSON.stringify(this.messages)}`);
	}

	async waitForClose(timeoutMs = 2000): Promise<void> {
		await Promise.race([
			this.#closed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("connection did not close")), timeoutMs)),
		]);
	}

	close(): void {
		this.#socket.destroy();
	}
}

/** Fake live session presentation source with a mutable branch. */
function fakeSource(initial: readonly SessionMessageEntry[] = []) {
	let branchId = "b1";
	let entries: readonly SessionMessageEntry[] = initial;
	const listeners = new Set<() => void>();
	const source: AttachLiveSessionSource = {
		get branchId() {
			return branchId;
		},
		sessionFile: null,
		getCwd: () => "/cwd",
		getBranchEntries: () => entries,
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		setBranch(next: readonly SessionMessageEntry[]): void {
			entries = next;
		},
		setBranchId(id: string): void {
			branchId = id;
		},
		notify(): void {
			for (const listener of listeners) listener();
		},
	};
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

/** ~377 KiB encoded entry: 23 blocks at the per-string char cap. */
function bigEntry(id: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: {
			role: "assistant",
			content: Array.from({ length: 23 }, () => ({
				type: "text",
				text: "x".repeat(ATTACH_TRANSCRIPT_MAX_STRING_CHARS),
			})),
			timestamp: 1,
		} as unknown as AgentMessage,
	};
}

describe("attach server", () => {
	let runtimeDir: string;
	let server: AttachServer;
	let registry: AttachRegistry;
	let token: string;

	beforeEach(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-test-"));
		registry = new AttachRegistry({
			runPrompt: async () => ({ ok: true, payload: "turn-done" }),
			followUp: async () => ({ ok: true, payload: "turn-done" }),
		});
		server = new AttachServer({
			runtimeDir,
			ownerScope: "scope-a",
			registry,
			helloTimeoutMs: 500,
		});
		await server.start();
		token = (await fs.readFile(server.tokenFile, "utf8")).trim();
	});

	afterEach(async () => {
		await server.stop().catch(() => {
			// Already stopped.
		});
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	function hello(capability: string, extra: { role?: "pane" | "director" | "observer" } = {}) {
		return {
			kind: "hello" as const,
			version: 2,
			capability,
			client: { role: extra.role ?? "pane", name: "test-client" },
		};
	}

	/** Connect, authenticate, and (for pane clients) open a view on KEY. */
	async function openPaneView(capability = token): Promise<TestClient> {
		const client = await TestClient.connect(server.socketFile);
		client.send(hello(capability));
		await client.waitForMessage(message => message.kind === "hello_ok");
		client.send({ kind: "view_open", key: KEY });
		await client.waitForMessage(message => message.kind === "view_open_ok");
		return client;
	}

	/** The lease granted in the client's view_open_ok. */
	async function grantedLease(client: TestClient) {
		const ok = (await client.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
			AttachMessage,
			{ kind: "view_open_ok" }
		>;
		return ok.lease;
	}

	describe("filesystem permissions", () => {
		it("creates a 0700 runtime dir, 0600 token file, and 0600 socket", async () => {
			const dirMode = (await fs.stat(runtimeDir)).mode & 0o777;
			const tokenMode = (await fs.stat(server.tokenFile)).mode & 0o777;
			const socketMode = (await fs.stat(server.socketFile)).mode & 0o777;
			expect(dirMode).toBe(0o700);
			expect(tokenMode).toBe(0o600);
			expect(socketMode).toBe(0o600);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
		});

		it("uses the expected default file basenames", () => {
			expect(path.basename(server.socketFile)).toBe(ATTACH_SOCKET_FILE);
			expect(path.basename(server.tokenFile)).toBe(ATTACH_TOKEN_FILE);
		});

		it("replaces a corrupt persisted token with a fresh valid capability", async () => {
			await server.stop();
			const tokenPath = path.join(runtimeDir, ATTACH_TOKEN_FILE);
			await fs.writeFile(tokenPath, "not-a-valid-capability\n", { mode: 0o600 });
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry,
				helloTimeoutMs: 500,
			});
			await server.start();
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			expect(token).not.toBe("not-a-valid-capability");
			const tokenMode = (await fs.stat(server.tokenFile)).mode & 0o777;
			expect(tokenMode).toBe(0o600);

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			const ok = await client.waitForMessage(message => message.kind === "hello_ok");
			expect(ok).toMatchObject({ kind: "hello_ok", version: 2 });
			client.close();
		});
	});

	describe("capability never reaches logs", () => {
		it("does not place the hello capability in any logger.debug argument", async () => {
			const calls: unknown[][] = [];
			const debugSpy = spyOn(logger, "debug").mockImplementation((...args: unknown[]) => {
				calls.push(args);
			});
			try {
				const client = await TestClient.connect(server.socketFile);
				client.send(hello(token));
				await client.waitForMessage(message => message.kind === "hello_ok");
				client.close();

				const serialized = JSON.stringify(calls);
				expect(serialized).not.toContain(token);
				for (const args of calls) {
					const text = typeof args[0] === "string" ? args[0] : "";
					const payload = args[1];
					if (payload && typeof payload === "object") {
						expect("head" in payload).toBe(false);
						expect("capability" in (payload as object)).toBe(false);
						for (const value of Object.values(payload as Record<string, unknown>)) {
							if (typeof value === "string") {
								expect(value).not.toContain(token);
							}
						}
					}
					expect(text).not.toContain(token);
				}
				// Sanity: the decoded-kind log path still fired for hello.
				expect(
					calls.some(
						args =>
							args[0] === "attach: inbound frame" &&
							typeof args[1] === "object" &&
							args[1] !== null &&
							(args[1] as { kind?: string }).kind === "hello",
					),
				).toBe(true);
			} finally {
				debugSpy.mockRestore();
			}
		});
	});

	describe("strict hello-first authentication", () => {
		it("rejects a non-hello first frame with hello_required", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send({ kind: "ping" as const });
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "hello_required" });
			await client.waitForClose();
		});

		it("rejects a wrong capability with auth_failed", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello("deadbeef"));
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "auth_failed" });
			await client.waitForClose();
		});

		it("rejects a wrong protocol version", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send({ ...hello(token), version: 999 });
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "protocol_version" });
			await client.waitForClose();
		});

		it("drops a silent connection after the hello timeout", async () => {
			const client = await TestClient.connect(server.socketFile);
			const error = await client.waitForMessage(message => message.kind === "error", 2000);
			expect(error).toMatchObject({ kind: "error", code: "hello_required" });
			await client.waitForClose();
		});

		it("rejects an oversized frame with frame_too_large", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.sendRaw(Buffer.concat([Buffer.alloc(ATTACH_MAX_FRAME_BYTES + 1), Buffer.from("\n", "utf8")]));
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "frame_too_large" });
			await client.waitForClose();
		});
	});

	describe("authentication and snapshots", () => {
		it("accepts the correct capability and returns hello_ok with a snapshot", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			const ok = await client.waitForMessage(message => message.kind === "hello_ok");
			expect(ok).toMatchObject({ kind: "hello_ok", version: 2 });
			const helloOk = ok as Extract<AttachMessage, { kind: "hello_ok" }>;
			expect(helloOk.snapshot.sessions).toEqual([]);
			expect(helloOk.server.pid).toBe(process.pid);
			client.close();
		});

		it("rejects a duplicate hello after authentication", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send(hello(token));
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "hello_required" });
			await client.waitForClose();
		});

		it("answers pings with pong", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "ping" as const, nonce: 42 });
			const pong = await client.waitForMessage(message => message.kind === "pong");
			expect(pong).toMatchObject({ kind: "pong", nonce: 42 });
			client.close();
		});
	});

	describe("director/observer subscribe path (v1 compatibility)", () => {
		it("streams registered/state/updated/removed events for subscribed workers", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "director" }));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const });
			await client.waitForMessage(message => message.kind === "snapshot");

			registry.register(KEY, null, "spawned");
			// register → server attach() for subscribed clients → updated may arrive
			// before registered; wait specifically for the registration event.
			const registered = await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "registered",
			);
			expect((registered as Extract<AttachMessage, { kind: "event" }>).event).toMatchObject({
				type: "registered",
				key: KEY,
			});
			// Live attachedClients: the director subscription auto-attaches and emits updated.
			await client.waitForMessage(message => {
				if (message.kind !== "event") return false;
				const event = message.event;
				return event.type === "updated" && event.entry.attachedClients === 1;
			});

			registry.updateState(KEY, "running", "turn 1");
			await client.waitForMessage(message => {
				if (message.kind !== "event") return false;
				const event = message.event;
				return event.type === "state" && event.state === "running";
			});

			registry.updateState(KEY, "idle", "settled");
			await client.waitForMessage(message => {
				if (message.kind !== "event") return false;
				const event = message.event;
				return event.type === "updated" && event.entry.state === "idle";
			});

			registry.unregister(KEY, "killed");
			await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "removed",
			);
			client.close();
		});

		it("sends a snapshot push on subscribe and includes existing entries", async () => {
			registry.register(KEY, null, "existing");
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "director" }));
			const helloOk = (await client.waitForMessage(message => message.kind === "hello_ok")) as Extract<
				AttachMessage,
				{ kind: "hello_ok" }
			>;
			expect(helloOk.snapshot.sessions).toHaveLength(1);
			expect(helloOk.snapshot.sessions[0].key).toEqual(KEY);
			client.send({ kind: "subscribe" as const });
			const push = (await client.waitForMessage(message => message.kind === "snapshot")) as Extract<
				AttachMessage,
				{ kind: "snapshot" }
			>;
			expect(push.snapshot.sessions).toHaveLength(1);
			client.close();
		});

		it("narrows the event stream with a workerIds subscription filter", async () => {
			const OTHER = { workerId: "w2", ownerScope: "scope-a" };
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const, workerIds: ["w1"] });
			// The subscribe frame is async; wait for the snapshot push so the
			// server has marked the connection subscribed before registrations
			// emit events (events only fan out to subscribed clients).
			await client.waitForMessage(message => message.kind === "snapshot");

			registry.register(OTHER, null, "other");
			registry.register(KEY, null, "wanted");
			const event = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "registered" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.key.workerId === "w1",
			)) as Extract<AttachMessage, { kind: "event" }>;
			expect(event.event.key).toEqual(KEY);
			client.close();
		});

		it("rejects a follow_up from an observer role with control_rejected forbidden", async () => {
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "observer" }));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const });
			await client.waitForMessage(message => message.kind === "snapshot");
			client.send({ kind: "follow_up" as const, ref: "r1", key: KEY, payload: "p" });
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected.code).toBe("forbidden");
			expect(rejected.ref).toBe("r1");
			client.close();
		});

		it("rejects a legacy abort frame from an observer role with control_rejected forbidden", async () => {
			// Regression: the legacy `abort` frame ran unconditionally, so a
			// read-only observer holding the local capability token could
			// cancel the worker's in-flight turn without a controller lease.
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "observer" }));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const });
			await client.waitForMessage(message => message.kind === "snapshot");
			client.send({ kind: "abort" as const, key: KEY, reason: "observer-nudge" });
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected.code).toBe("forbidden");
			client.close();
		});

		it("still allows a director role to send the legacy abort frame", async () => {
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "director" }));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const });
			await client.waitForMessage(message => message.kind === "snapshot");
			client.send({ kind: "abort" as const, key: KEY, reason: "director-abort" });
			const event = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "abort_accepted",
			)) as Extract<AttachMessage, { kind: "event" }>;
			expect(event.event).toMatchObject({ type: "abort_accepted", key: KEY });
			client.close();
		});
	});

	describe("serialized follow-up over the wire (director path)", () => {
		it("runs a follow-up and streams accepted + result with the client ref", async () => {
			const seen: unknown[] = [];
			const serverRegistry = new AttachRegistry({
				runPrompt: async () => ({ ok: true }),
				followUp: async (key, payload) => {
					seen.push({ key, payload });
					return { ok: true, payload: "turn-done" };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { role: "director" }));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "subscribe" as const });
			await client.waitForMessage(message => message.kind === "snapshot");
			client.send({ kind: "follow_up" as const, ref: "ref-7", key: KEY, payload: "continue" });

			const result = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "follow_up_result",
			)) as Extract<AttachMessage, { kind: "event" }>;
			const followUpResult = result.event;
			expect(seen).toEqual([{ key: KEY, payload: "continue" }]);
			expect(followUpResult).toMatchObject({
				type: "follow_up_result",
				ref: "ref-7",
				ok: true,
				payload: "turn-done",
			});
			client.close();
		});

		it("rejects a follow-up for an unknown worker with unknown_worker", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "follow_up" as const, ref: "r", key: KEY, payload: "p" });
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "unknown_worker", ref: "r" });
			client.close();
		});

		it("rejects a concurrent follow-up for the same worker with busy", async () => {
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const serverRegistry = new AttachRegistry({
				runPrompt: async () => ({ ok: true }),
				followUp: async () => {
					await gate;
					return { ok: true };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "follow_up" as const, ref: "r1", key: KEY, payload: "p1" });
			await new Promise(resolve => setTimeout(resolve, 20)); // let the first claim the slot
			client.send({ kind: "follow_up" as const, ref: "r2", key: KEY, payload: "p2" });
			const error = await client.waitForMessage(message => message.kind === "error");
			expect(error).toMatchObject({ kind: "error", code: "busy", ref: "r2" });
			release();
			client.close();
		});
	});

	describe("view_open: lease + epoch + transcript snapshot", () => {
		it("grants a lease and streams the transcript snapshot from the live source", async () => {
			const { source } = fakeSource([messageEntry("e1", "first"), messageEntry("e2", "second")]);
			registry.register(KEY, source, "spawned");

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "view_open", key: KEY });

			const ok = (await client.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			expect(ok.key).toEqual(KEY);
			expect(ok.lease.generation).toBe(1);
			expect(ok.lease.proof).toMatch(/^[0-9a-f]{64}$/);
			expect(ok.lease.graceMs).toBeGreaterThan(0);
			expect(ok.epoch).toBeGreaterThan(0);
			expect(ok.entry.key).toEqual(KEY);
			expect(ok.entry.state).toBe("starting");
			expect(ok.cwd).toBe("/cwd");

			const begin = (await client.waitForMessage(message => message.kind === "transcript_append")) as Extract<
				AttachMessage,
				{ kind: "transcript_append" }
			>;
			// The initial feed is delivered through the live append path (the
			// first sync's branchId matches the freshly created feed state), so
			// the snapshot arrives as transcript_append + transcript_end.
			expect(begin).toMatchObject({ epoch: ok.epoch, seq: 1, watermark: 0 });
			expect(begin.items.map(item => item.id)).toEqual(["e1", "e2"]);
			const end = (await client.waitForMessage(message => message.kind === "transcript_end")) as Extract<
				AttachMessage,
				{ kind: "transcript_end" }
			>;
			expect(end).toMatchObject({ epoch: ok.epoch, seq: 2, watermark: 2 });
			client.close();
		});

		it("streams new entries as transcript_append when the source grows", async () => {
			const { source, setBranch, notify } = fakeSource([messageEntry("e1", "first")]);
			registry.register(KEY, source);
			const client = await openPaneView();
			const ok = (await client.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			await client.waitForMessage(message => message.kind === "transcript_end");

			setBranch([messageEntry("e1", "first"), messageEntry("e2", "second"), messageEntry("e3", "third")]);
			notify();
			// The initial feed already delivered an append (watermark 0); wait
			// for the growth append (watermark 1 = entries sent so far).
			const append = (await client.waitForMessage(
				message => message.kind === "transcript_append" && message.watermark === 1,
			)) as Extract<AttachMessage, { kind: "transcript_append" }>;
			expect(append.epoch).toBe(ok.epoch);
			expect(append.items.map(item => item.id)).toEqual(["e2", "e3"]);
			expect(append.watermark).toBe(1);
			const end = (await client.waitForMessage(
				message => message.kind === "transcript_end" && message.watermark === 3,
			)) as Extract<AttachMessage, { kind: "transcript_end" }>;
			expect(end.watermark).toBe(3);
			client.close();
		});

		it("resets and re-snapshots when the source branch switches", async () => {
			const { source, setBranch, setBranchId, notify } = fakeSource([messageEntry("e1", "old")]);
			registry.register(KEY, source);
			const client = await openPaneView();
			await client.waitForMessage(message => message.kind === "transcript_end");

			setBranchId("b2");
			setBranch([messageEntry("e4", "new branch")]);
			notify();

			const reset = (await client.waitForMessage(message => message.kind === "transcript_reset")) as Extract<
				AttachMessage,
				{ kind: "transcript_reset" }
			>;
			expect(reset.reason).toContain("branch");
			const begin = (await client.waitForMessage(message => message.kind === "transcript_begin")) as Extract<
				AttachMessage,
				{ kind: "transcript_begin" }
			>;
			expect(begin.seq).toBe(reset.seq + 1);
			const items = (await client.waitForMessage(message => message.kind === "transcript_items")) as Extract<
				AttachMessage,
				{ kind: "transcript_items" }
			>;
			expect(items.items.map(item => item.id)).toEqual(["e4"]);
			client.close();
		});

		it("streams near-budget entries over contiguous seq without oversized frames", async () => {
			const { source } = fakeSource([bigEntry("e1"), bigEntry("e2"), bigEntry("e3")]);
			registry.register(KEY, source, "spawned");

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "view_open", key: KEY });
			await client.waitForMessage(message => message.kind === "view_open_ok");
			const end = (await client.waitForMessage(
				message => message.kind === "transcript_end" && message.watermark === 3,
			)) as Extract<AttachMessage, { kind: "transcript_end" }>;

			// Three ~377 KiB entries cannot share one 1 MiB frame: the initial
			// feed arrives as two bounded appends ([e1,e2], [e3]) followed by
			// a contiguous transcript_end — no dropped seq, no reconnect.
			const appends = client.messages.filter(
				(message): message is Extract<AttachMessage, { kind: "transcript_append" }> =>
					message.kind === "transcript_append",
			);
			expect(appends.map(append => append.items.map(item => item.id))).toEqual([["e1", "e2"], ["e3"]]);
			expect(appends.map(append => append.seq)).toEqual([1, 2]);
			expect(end.seq).toBe(appends.length + 1);
			expect(end.watermark).toBe(3);
			for (const append of appends) {
				expect(encodeAttachMessage(append).byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
			}
			client.close();
		});

		it("re-snapshots near-budget entries over bounded transcript_items frames", async () => {
			const { source, setBranch, setBranchId, notify } = fakeSource([messageEntry("e1", "old")]);
			registry.register(KEY, source);
			const client = await openPaneView();
			await client.waitForMessage(message => message.kind === "transcript_end");

			setBranchId("b2");
			setBranch([bigEntry("e4"), bigEntry("e5"), bigEntry("e6")]);
			notify();

			const reset = (await client.waitForMessage(message => message.kind === "transcript_reset")) as Extract<
				AttachMessage,
				{ kind: "transcript_reset" }
			>;
			const begin = (await client.waitForMessage(message => message.kind === "transcript_begin")) as Extract<
				AttachMessage,
				{ kind: "transcript_begin" }
			>;
			const end = (await client.waitForMessage(
				message => message.kind === "transcript_end" && message.watermark === 3,
			)) as Extract<AttachMessage, { kind: "transcript_end" }>;
			const items = client.messages.filter(
				(message): message is Extract<AttachMessage, { kind: "transcript_items" }> =>
					message.kind === "transcript_items",
			);
			expect(items.map(frame => frame.items.map(item => item.id))).toEqual([["e4", "e5"], ["e6"]]);
			expect(begin.seq).toBe(reset.seq + 1);
			expect(items.map(frame => frame.seq)).toEqual([begin.seq + 1, begin.seq + 2]);
			expect(end.seq).toBe(begin.seq + 3);
			expect(end.watermark).toBe(3);
			for (const frame of items) {
				expect(encodeAttachMessage(frame).byteLength).toBeLessThanOrEqual(ATTACH_MAX_FRAME_BYTES);
			}
			client.close();
		});

		it("rejects a second pane view with lease_busy and holder info", async () => {
			registry.register(KEY, null);
			const first = await openPaneView();

			const second = await TestClient.connect(server.socketFile);
			second.send(hello(token));
			await second.waitForMessage(message => message.kind === "hello_ok");
			second.send({ kind: "view_open", key: KEY });
			const rejected = (await second.waitForMessage(message => message.kind === "view_open_rejected")) as Extract<
				AttachMessage,
				{ kind: "view_open_rejected" }
			>;
			expect(rejected.code).toBe("lease_busy");
			expect(rejected.holder).toEqual({ generation: 1, expiresInMs: expect.any(Number) });
			first.close();
			second.close();
		});

		it("resumes the lease on reconnect and re-snapshots in a fresh epoch", async () => {
			const { source } = fakeSource([messageEntry("e1", "first")]);
			registry.register(KEY, source);
			const first = await openPaneView();
			const firstOk = (await first.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			await first.waitForMessage(message => message.kind === "transcript_end");
			first.close();
			await first.waitForClose();

			// Same client instance, new socket, within the disconnect grace.
			const second = await TestClient.connect(server.socketFile);
			second.send(hello(token));
			await second.waitForMessage(message => message.kind === "hello_ok");
			second.send({
				kind: "view_open",
				key: KEY,
				resume: {
					leaseId: firstOk.lease.leaseId,
					proof: firstOk.lease.proof,
					generation: firstOk.lease.generation,
				},
			});
			const ok = (await second.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			expect(ok.lease.leaseId).toBe(firstOk.lease.leaseId);
			expect(ok.lease.proof).toBe(firstOk.lease.proof);
			expect(ok.lease.generation).toBe(2);
			expect(ok.epoch).toBeGreaterThan(firstOk.epoch);
			// The transcript is re-delivered in the new epoch via the live
			// append path (fresh feed state, matching branchId).
			const append = (await second.waitForMessage(message => message.kind === "transcript_append")) as Extract<
				AttachMessage,
				{ kind: "transcript_append" }
			>;
			expect(append.epoch).toBe(ok.epoch);
			expect(append.items.map(item => item.id)).toEqual(["e1"]);
			second.close();
		});

		it("rejects a view_open for an unknown worker", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "view_open", key: { workerId: "ghost", ownerScope: "scope-a" } });
			const rejected = (await client.waitForMessage(message => message.kind === "view_open_rejected")) as Extract<
				AttachMessage,
				{ kind: "view_open_rejected" }
			>;
			expect(rejected.code).toBe("unknown_worker");
			client.close();
		});

		it("normalizes an empty ownerScope to the server's scope", async () => {
			const { source } = fakeSource([messageEntry("e1", "first")]);
			registry.register(KEY, source);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "view_open", key: { workerId: "w1", ownerScope: "" } });
			const ok = (await client.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			expect(ok.key).toEqual(KEY);
			// The normalized key is echoed, and controls with an empty scope work.
			const lease = ok.lease;
			client.send({
				kind: "prompt",
				key: { workerId: "w1", ownerScope: "" },
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "cmd-1",
				ref: "p1",
				text: "hello",
			});
			const accepted = (await client.waitForMessage(message => message.kind === "prompt_accepted")) as Extract<
				AttachMessage,
				{ kind: "prompt_accepted" }
			>;
			expect(accepted.ref).toBe("p1");
			client.close();
		});
	});

	describe("no-live-session snapshot boundary", () => {
		it("opens the prompt gate with an empty boundary before the session materializes, then resnapshots", async () => {
			let materialized: AttachLiveSessionSource | null = null;
			const serverRegistry = new AttachRegistry({
				runPrompt: async () => ({ ok: true, payload: "pre-materialize" }),
				liveSessionOf: () => materialized,
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			// Worker registered, but its session has NOT materialized yet.
			registry.register(KEY, null);

			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "view_open", key: KEY });
			const ok = (await client.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;

			// A valid EMPTY snapshot boundary for the current epoch: monotonic
			// seq, watermark 0 — the boundary the client's prompt gate needs.
			const begin = (await client.waitForMessage(message => message.kind === "transcript_begin")) as Extract<
				AttachMessage,
				{ kind: "transcript_begin" }
			>;
			expect(begin).toMatchObject({ epoch: ok.epoch, seq: 1 });
			const end = (await client.waitForMessage(message => message.kind === "transcript_end")) as Extract<
				AttachMessage,
				{ kind: "transcript_end" }
			>;
			expect(end).toMatchObject({ epoch: ok.epoch, seq: 2, watermark: 0 });

			// The gate is OPEN: a prompt can run before the session materializes.
			const lease = ok.lease;
			client.send({
				kind: "prompt",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "cmd-pre",
				ref: "p1",
				text: "go",
			});
			const accepted = (await client.waitForMessage(message => message.kind === "prompt_accepted")) as Extract<
				AttachMessage,
				{ kind: "prompt_accepted" }
			>;
			expect(accepted.ref).toBe("p1");
			const result = (await client.waitForMessage(message => message.kind === "prompt_result")) as Extract<
				AttachMessage,
				{ kind: "prompt_result" }
			>;
			expect(result).toMatchObject({ ref: "p1", cmdId: "cmd-pre", ok: true, payload: "pre-materialize" });

			// The session materializes: the parked feed emits transcript_reset
			// + a fresh snapshot (branch mismatch) and subscribes going forward.
			const { source } = fakeSource([messageEntry("e1", "materialized")]);
			materialized = source;
			registry.updateState(KEY, "running", "materialized");
			const reset = (await client.waitForMessage(message => message.kind === "transcript_reset")) as Extract<
				AttachMessage,
				{ kind: "transcript_reset" }
			>;
			expect(reset).toMatchObject({ epoch: ok.epoch, reason: expect.stringContaining("branch") });
			const resetBegin = (await client.waitForMessage(
				message => message.kind === "transcript_begin" && message.seq === reset.seq + 1,
			)) as Extract<AttachMessage, { kind: "transcript_begin" }>;
			expect(resetBegin.seq).toBe(reset.seq + 1);
			const items = (await client.waitForMessage(message => message.kind === "transcript_items")) as Extract<
				AttachMessage,
				{ kind: "transcript_items" }
			>;
			expect(items.items.map(item => item.id)).toEqual(["e1"]);
			const resetEnd = (await client.waitForMessage(
				message => message.kind === "transcript_end" && message.seq > 2,
			)) as Extract<AttachMessage, { kind: "transcript_end" }>;
			expect(resetEnd).toMatchObject({ watermark: 1 });
			client.close();
		});
	});

	describe("controller prompts", () => {
		it("accepts a prompt, runs it through the registry, and delivers the result", async () => {
			const seen: Array<{ key: unknown; text: string }> = [];
			const serverRegistry = new AttachRegistry({
				runPrompt: async (key, text) => {
					seen.push({ key, text });
					return { ok: true, payload: "turn-done" };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			const client = await openPaneView();
			const lease = await grantedLease(client);
			client.send({
				kind: "prompt",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "cmd-1",
				ref: "p1",
				text: "continue please",
			});
			const accepted = (await client.waitForMessage(message => message.kind === "prompt_accepted")) as Extract<
				AttachMessage,
				{ kind: "prompt_accepted" }
			>;
			expect(accepted).toMatchObject({ ref: "p1", cmdId: "cmd-1" });
			const result = (await client.waitForMessage(message => message.kind === "prompt_result")) as Extract<
				AttachMessage,
				{ kind: "prompt_result" }
			>;
			expect(result).toMatchObject({ ref: "p1", cmdId: "cmd-1", ok: true, payload: "turn-done" });
			expect(seen).toEqual([{ key: KEY, text: "continue please" }]);
			client.close();
		});

		it("rejects a second prompt while the first is in flight with busy", async () => {
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const serverRegistry = new AttachRegistry({
				runPrompt: async () => {
					await gate;
					return { ok: true };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			const client = await openPaneView();
			const lease = await grantedLease(client);
			const promptFrame = (cmdId: string, cmdSeq: number, ref: string) => ({
				kind: "prompt" as const,
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq,
				cmdId,
				ref,
				text: "go",
			});
			client.send(promptFrame("cmd-1", 1, "p1"));
			await client.waitForMessage(message => message.kind === "prompt_accepted");
			client.send(promptFrame("cmd-2", 2, "p2"));
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected).toMatchObject({ code: "busy", cmdId: "cmd-2", ref: "p2" });
			release();
			await client.waitForMessage(message => message.kind === "prompt_result");
			client.close();
		});

		it("replays a cached result for a repeated cmdId without re-running", async () => {
			const calls: string[] = [];
			const serverRegistry = new AttachRegistry({
				runPrompt: async (_key, text) => {
					calls.push(text);
					return { ok: true, payload: "first-run" };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			// First connection runs the command and caches the outcome.
			const first = await openPaneView();
			const lease = await grantedLease(first);
			first.send({
				kind: "prompt",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "same-cmd",
				ref: "p1",
				text: "run me",
			});
			await first.waitForMessage(message => message.kind === "prompt_result");
			expect(calls).toEqual(["run me"]);
			first.close();
			await first.waitForClose();

			// The same client reconnects and replays the in-flight command id.
			const second = await TestClient.connect(server.socketFile);
			second.send(hello(token));
			await second.waitForMessage(message => message.kind === "hello_ok");
			second.send({
				kind: "view_open",
				key: KEY,
				resume: { leaseId: lease.leaseId, proof: lease.proof, generation: lease.generation },
			});
			const ok = (await second.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			second.send({
				kind: "prompt",
				key: KEY,
				leaseId: ok.lease.leaseId,
				proof: ok.lease.proof,
				generation: ok.lease.generation,
				cmdSeq: 1,
				cmdId: "same-cmd",
				ref: "p2",
				text: "run me",
			});
			const accepted = (await second.waitForMessage(message => message.kind === "prompt_accepted")) as Extract<
				AttachMessage,
				{ kind: "prompt_accepted" }
			>;
			expect(accepted.ref).toBe("p2");
			const result = (await second.waitForMessage(message => message.kind === "prompt_result")) as Extract<
				AttachMessage,
				{ kind: "prompt_result" }
			>;
			expect(result).toMatchObject({ ref: "p2", cmdId: "same-cmd", ok: true, payload: "first-run" });
			// The callback ran exactly once: the replay was served from cache.
			expect(calls).toEqual(["run me"]);
			second.close();
		});

		it("rejects out-of-order, stale-lease, foreign-proof, and stale-generation prompts", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			const lease = await grantedLease(client);
			const frame = (overrides: Partial<Extract<AttachMessage, { kind: "prompt" }>> = {}) => ({
				kind: "prompt" as const,
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "cmd-x",
				ref: "p-x",
				text: "go",
				...overrides,
			});

			client.send(frame({ cmdSeq: 1, cmdId: "cmd-1", ref: "p1" }));
			await client.waitForMessage(message => message.kind === "prompt_accepted");
			await client.waitForMessage(message => message.kind === "prompt_result");

			// Duplicate sequence on the same connection.
			client.send(frame({ cmdSeq: 1, cmdId: "cmd-dup", ref: "p-dup" }));
			const outOfOrder = (await client.waitForMessage(
				message => message.kind === "control_rejected" && message.cmdId === "cmd-dup",
			)) as Extract<AttachMessage, { kind: "control_rejected" }>;
			expect(outOfOrder).toMatchObject({ code: "out_of_order", cmdId: "cmd-dup" });

			// Stale lease id.
			client.send(frame({ leaseId: "wrong-lease", cmdSeq: 2, cmdId: "cmd-lease", ref: "p-lease" }));
			const staleLease = (await client.waitForMessage(
				message => message.kind === "control_rejected" && message.cmdId === "cmd-lease",
			)) as Extract<AttachMessage, { kind: "control_rejected" }>;
			expect(staleLease).toMatchObject({ code: "stale_lease", cmdId: "cmd-lease" });

			// Foreign proof.
			client.send(frame({ proof: PROOF, cmdSeq: 3, cmdId: "cmd-proof", ref: "p-proof" }));
			const foreign = (await client.waitForMessage(
				message => message.kind === "control_rejected" && message.cmdId === "cmd-proof",
			)) as Extract<AttachMessage, { kind: "control_rejected" }>;
			expect(foreign).toMatchObject({ code: "foreign_client", cmdId: "cmd-proof" });

			// Stale generation.
			client.send(frame({ generation: 0, cmdSeq: 4, cmdId: "cmd-gen", ref: "p-gen" }));
			const staleGen = (await client.waitForMessage(
				message => message.kind === "control_rejected" && message.cmdId === "cmd-gen",
			)) as Extract<AttachMessage, { kind: "control_rejected" }>;
			expect(staleGen).toMatchObject({ code: "stale_generation", cmdId: "cmd-gen" });
			client.close();
		});

		it("rejects a prompt on a connection with no open view", async () => {
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({
				kind: "prompt",
				key: KEY,
				leaseId: "none",
				proof: PROOF,
				generation: 1,
				cmdSeq: 1,
				cmdId: "cmd-1",
				ref: "p1",
				text: "go",
			});
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected).toMatchObject({ code: "lease_required", cmdId: "cmd-1" });
			client.close();
		});

		it("joins the shared outcome when a reconnected client replays the in-flight cmdId", async () => {
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const calls: string[] = [];
			const serverRegistry = new AttachRegistry({
				runPrompt: async (_key, text) => {
					calls.push(text);
					await gate;
					return { ok: true, payload: "deferred-done" };
				},
			});
			await server.stop();
			server = new AttachServer({
				runtimeDir,
				ownerScope: "scope-a",
				registry: serverRegistry,
				helloTimeoutMs: 500,
			});
			await server.start();
			registry = serverRegistry;
			token = (await fs.readFile(server.tokenFile, "utf8")).trim();
			registry.register(KEY, null);

			// Connection A starts a DEFERRED prompt: accepted, run in flight.
			const first = await openPaneView();
			const lease = await grantedLease(first);
			const replayFrame = {
				kind: "prompt" as const,
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "same-cmd",
				ref: "p1",
				text: "run me",
			};
			first.send(replayFrame);
			await first.waitForMessage(message => message.kind === "prompt_accepted");
			expect(calls).toEqual(["run me"]);

			// A drops mid-run (socket death); the run keeps going.
			first.close();
			await first.waitForClose();

			// B (same client instance) resumes the lease and replays the SAME
			// cmdId while the original is still running: it must JOIN the
			// shared outcome — accepted then result — never busy, never re-run.
			const second = await TestClient.connect(server.socketFile);
			second.send(hello(token));
			await second.waitForMessage(message => message.kind === "hello_ok");
			second.send({
				kind: "view_open",
				key: KEY,
				resume: { leaseId: lease.leaseId, proof: lease.proof, generation: lease.generation },
			});
			const ok = (await second.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			expect(ok.lease.generation).toBe(2);
			second.send({
				...replayFrame,
				leaseId: ok.lease.leaseId,
				proof: ok.lease.proof,
				generation: ok.lease.generation,
			});
			const accepted = (await second.waitForMessage(message => message.kind === "prompt_accepted")) as Extract<
				AttachMessage,
				{ kind: "prompt_accepted" }
			>;
			expect(accepted).toMatchObject({ ref: "p1", cmdId: "same-cmd" });

			// A DIFFERENT command while the original is still running: busy.
			second.send({
				kind: "prompt",
				key: KEY,
				leaseId: ok.lease.leaseId,
				proof: ok.lease.proof,
				generation: ok.lease.generation,
				cmdSeq: 2,
				cmdId: "other-cmd",
				ref: "p2",
				text: "different",
			});
			const rejected = (await second.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected).toMatchObject({ code: "busy", cmdId: "other-cmd", ref: "p2" });

			// The deferred run settles: the JOINED connection receives the
			// result (the destroyed original connection is harmless).
			release();
			const result = (await second.waitForMessage(message => message.kind === "prompt_result")) as Extract<
				AttachMessage,
				{ kind: "prompt_result" }
			>;
			expect(result).toMatchObject({ ref: "p1", cmdId: "same-cmd", ok: true, payload: "deferred-done" });
			// The underlying run executed exactly once across both connections.
			expect(calls).toEqual(["run me"]);
			second.close();
		});
	});

	describe("abort_turn and detach", () => {
		it("aborts the in-flight turn and broadcasts abort_accepted", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			const lease = await grantedLease(client);
			client.send({
				kind: "abort_turn",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "abort-1",
			});
			const event = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "abort_accepted",
			)) as Extract<AttachMessage, { kind: "event" }>;
			expect(event.event).toMatchObject({ type: "abort_accepted", key: KEY });
			client.close();
		});

		it("normalizes an empty ownerScope on abort_turn before resolving the registry entry", async () => {
			// Regression: the abort path must resolve the client's empty
			// ownerScope to the server scope BEFORE the registry lookup.
			// The pane client derives only the worker id, so an un-normalized
			// key misses the registered entry and abort() returns false — no
			// abort_accepted is emitted and the abort silently never fires.
			registry.register(KEY, null);
			const client = await openPaneView();
			const lease = await grantedLease(client);
			client.send({
				kind: "abort_turn",
				key: { workerId: "w1", ownerScope: "" },
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				cmdSeq: 1,
				cmdId: "abort-empty-scope",
			});
			// The event must carry the RESOLVED key (real owner scope), proving
			// the registry entry was found and the abort actually fired.
			const event = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "abort_accepted",
			)) as Extract<AttachMessage, { kind: "event" }>;
			expect(event.event).toMatchObject({ type: "abort_accepted", key: KEY });
			client.close();
		});

		it("rejects abort_turn with an invalid lease", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			client.send({
				kind: "abort_turn",
				key: KEY,
				leaseId: "wrong",
				proof: PROOF,
				generation: 1,
				cmdSeq: 1,
				cmdId: "abort-1",
			});
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected).toMatchObject({ code: "stale_lease", cmdId: "abort-1" });
			client.close();
		});

		it("detach releases the lease, replies bye, and never kills the worker", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			const lease = await grantedLease(client);

			client.send({
				kind: "detach",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: lease.generation,
				reason: "user",
			});
			const bye = await client.waitForMessage(message => message.kind === "bye");
			expect(bye).toMatchObject({ kind: "bye", reason: "user" });
			await client.waitForClose();

			// The lease is released: a fresh pane client can take the view.
			expect(registry.has(KEY)).toBe(true); // worker survives
			const next = await TestClient.connect(server.socketFile);
			next.send(hello(token));
			await next.waitForMessage(message => message.kind === "hello_ok");
			next.send({ kind: "view_open", key: KEY });
			const ok = (await next.waitForMessage(message => message.kind === "view_open_ok")) as Extract<
				AttachMessage,
				{ kind: "view_open_ok" }
			>;
			expect(ok.lease.generation).toBe(1);
			next.close();
		});

		it("rejects detach with a stale generation", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			const lease = await grantedLease(client);
			client.send({
				kind: "detach",
				key: KEY,
				leaseId: lease.leaseId,
				proof: lease.proof,
				generation: 99,
				reason: "user",
			});
			const rejected = (await client.waitForMessage(message => message.kind === "control_rejected")) as Extract<
				AttachMessage,
				{ kind: "control_rejected" }
			>;
			expect(rejected).toMatchObject({ code: "stale_generation" });
			client.close();
		});
	});

	describe("worker removal and teardown", () => {
		it("tears down the view and streams removed to the pane client", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();

			registry.unregister(KEY, "killed");
			const event = (await client.waitForMessage(
				message =>
					message.kind === "event" &&
					(message as Extract<AttachMessage, { kind: "event" }>).event.type === "removed",
			)) as Extract<AttachMessage, { kind: "event" }>;
			expect(event.event).toMatchObject({ type: "removed", key: KEY, reason: "killed" });
			client.close();
		});

		it("detach on disconnect never unregisters the worker", async () => {
			registry.register(KEY, null);
			const client = await openPaneView();
			expect(registry.snapshot().sessions[0].attachedClients).toBe(1);
			client.close();
			await client.waitForClose();
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && registry.snapshot().sessions[0].attachedClients !== 0) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			expect(registry.snapshot().sessions[0].attachedClients).toBe(0);
			expect(registry.has(KEY)).toBe(true); // worker survives the client
			expect(server.clientCount).toBe(0);
		});

		it("bye closes politely and removes the client without killing workers", async () => {
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			await client.waitForMessage(message => message.kind === "hello_ok");
			client.send({ kind: "bye" as const });
			const bye = await client.waitForMessage(message => message.kind === "bye");
			expect(bye).toMatchObject({ kind: "bye" });
			await client.waitForClose();
			expect(registry.has(KEY)).toBe(true);
			expect(server.clientCount).toBe(0);
		});

		it("stop() removes socket + token files and rejects new connections", async () => {
			await server.stop();
			await expect(fs.stat(server.socketFile)).rejects.toThrow();
			await expect(fs.stat(server.tokenFile)).rejects.toThrow();
			await expect(TestClient.connect(server.socketFile)).rejects.toThrow();
		});

		it("server.stop() never unregisters workers (kill is the bridge's job)", async () => {
			registry.register(KEY, null);
			await server.stop();
			expect(registry.size).toBe(1);
			expect(registry.has(KEY)).toBe(true);
		});
	});
});
