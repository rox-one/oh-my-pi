import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type AttachMessage, encodeAttachMessage } from "../../src/attach/protocol";
import { AttachRegistry } from "../../src/attach/registry";
import { ATTACH_SOCKET_FILE, ATTACH_TOKEN_FILE, AttachServer } from "../../src/attach/server";

const KEY = { workerId: "w1", ownerScope: "scope-a" };

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

describe("attach server", () => {
	let runtimeDir: string;
	let server: AttachServer;
	let registry: AttachRegistry;
	let token: string;

	beforeEach(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-test-"));
		registry = new AttachRegistry({ followUp: async () => ({ ok: true, payload: "turn-done" }) });
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

	function hello(capability: string, extra: Partial<{ subscribe: boolean; role: "pane" | "director" }> = {}) {
		return {
			kind: "hello" as const,
			version: 1,
			capability,
			client: { role: extra.role ?? "pane", name: "test-client" },
			...(extra.subscribe === undefined ? {} : { subscribe: extra.subscribe }),
		};
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
	});

	describe("authentication and snapshots", () => {
		it("accepts the correct capability and returns hello_ok with a snapshot", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token));
			const ok = await client.waitForMessage(message => message.kind === "hello_ok");
			expect(ok).toMatchObject({ kind: "hello_ok", version: 1 });
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

	describe("subscribe: snapshot + events + entries + state", () => {
		it("streams registered/state/updated/removed events for subscribed workers", async () => {
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { subscribe: true }));
			await client.waitForMessage(message => message.kind === "hello_ok");

			registry.register(KEY, { live: true }, "spawned");
			const registered = await client.waitForMessage(message => message.kind === "event");
			expect((registered as Extract<AttachMessage, { kind: "event" }>).event).toMatchObject({
				type: "registered",
				key: KEY,
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
			client.send(hello(token, { subscribe: true }));
			const helloOk = (await client.waitForMessage(message => message.kind === "hello_ok")) as Extract<
				AttachMessage,
				{ kind: "hello_ok" }
			>;
			expect(helloOk.snapshot.sessions).toHaveLength(1);
			expect(helloOk.snapshot.sessions[0].key).toEqual(KEY);
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
	});

	describe("serialized follow-up over the wire", () => {
		it("runs a follow-up and streams accepted + result with the client ref", async () => {
			const seen: unknown[] = [];
			const serverRegistry = new AttachRegistry({
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
			client.send(hello(token, { subscribe: true }));
			await client.waitForMessage(message => message.kind === "hello_ok");
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

	describe("disconnect, detach, and teardown", () => {
		it("detach on disconnect never unregisters the worker", async () => {
			registry.register(KEY, null);
			const client = await TestClient.connect(server.socketFile);
			client.send(hello(token, { subscribe: true }));
			await client.waitForMessage(message => message.kind === "hello_ok");
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
