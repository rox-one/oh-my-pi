import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import Attach, { readAttachToken, resolveAttachPaths } from "../../src/attach/cli";
import { AttachClient } from "../../src/attach/client";
import {
	type AttachClientMessage,
	AttachFrameAccumulator,
	type AttachMessage,
	type AttachSessionEntry,
	type AttachSnapshot,
	type AttachWorkerKey,
	decodeAttachLine,
	encodeAttachMessage,
} from "../../src/attach/protocol";

const KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-a" };
const TOKEN = "a".repeat(64);

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
	return { version: 1, generatedAt: Date.now(), sessions };
}

/** Writable stream that captures everything written to it as text. */
class CollectingStream extends Writable {
	text = "";

	override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.text += chunk.toString();
		callback();
	}

	lines(): string[] {
		return this.text.split("\n").filter(line => line.length > 0);
	}
}

function lineWith(stream: CollectingStream, needle: string): string | undefined {
	return stream.lines().find(line => line.includes(needle));
}

/** Poll `produce` until it yields a non-undefined value (deterministic waits). */
async function poll<T>(produce: () => T | undefined, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = produce();
		if (value !== undefined) return value;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`timed out after ${timeoutMs}ms`);
}

/** One server-side connection: decodes frames and can push messages. */
class FakeConnection {
	readonly messages: AttachClientMessage[] = [];
	readonly #accumulator = new AttachFrameAccumulator();
	readonly #socket: net.Socket;
	readonly #onMessage: (message: AttachClientMessage) => void;
	#helloOk = false;

	constructor(socket: net.Socket, onMessage: (message: AttachClientMessage) => void) {
		this.#socket = socket;
		this.#onMessage = onMessage;
		socket.on("data", chunk => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			for (const frame of this.#accumulator.push(buffer)) {
				const message = decodeAttachLine(frame) as AttachClientMessage;
				this.messages.push(message);
				this.#onMessage(message);
			}
		});
		socket.on("error", () => {
			// Closure is observed via the close event; nothing to do here.
		});
	}

	get authenticated(): boolean {
		return this.#helloOk;
	}

	markAuthenticated(): void {
		this.#helloOk = true;
	}

	send(message: AttachMessage): void {
		this.#socket.write(encodeAttachMessage(message));
	}

	close(): void {
		// Graceful FIN so pending writes (error frames, bye) are flushed to the
		// client before the socket closes; destroy() would drop them.
		this.#socket.end();
	}
}

interface FakeServerOptions {
	/** Capability the fake server expects in `hello`. */
	readonly token: string;
	/** Snapshot sent in `hello_ok` and pushed on `subscribe` by default. */
	readonly snapshot: AttachSnapshot;
	/** Called for every authenticated client message; defaults to a scripted echo. */
	readonly onMessage?: (connection: FakeConnection, message: AttachClientMessage) => void;
}

/** Minimal attach server for tests: hello/auth, snapshots, and scripted messages. */
class FakeServer {
	readonly socketFile: string;
	readonly received: AttachClientMessage[] = [];
	readonly connections: FakeConnection[] = [];
	readonly #server: net.Server;
	readonly #options: FakeServerOptions;

	private constructor(socketFile: string, options: FakeServerOptions) {
		this.socketFile = socketFile;
		this.#options = options;
		this.#server = net.createServer(socket => {
			const connection = new FakeConnection(socket, message => {
				this.received.push(message);
				this.#handleMessage(connection, message);
			});
			this.connections.push(connection);
		});
	}

	static async listen(socketFile: string, options: FakeServerOptions): Promise<FakeServer> {
		const server = new FakeServer(socketFile, options);
		await new Promise<void>((resolve, reject) => {
			server.#server.once("error", reject);
			server.#server.listen(socketFile, () => {
				server.#server.removeListener("error", reject);
				resolve();
			});
		});
		return server;
	}

	async stop(): Promise<void> {
		for (const connection of this.connections) connection.close();
		await new Promise<void>(resolve => {
			this.#server.close(() => resolve());
		});
	}

	#handleMessage(connection: FakeConnection, message: AttachClientMessage): void {
		if (message.kind === "hello") {
			if (message.capability !== this.#options.token) {
				connection.send({ kind: "error", code: "auth_failed", message: "bad capability" });
				connection.close();
				return;
			}
			connection.markAuthenticated();
			connection.send({
				kind: "hello_ok",
				version: 1,
				server: { pid: process.pid, startedAt: Date.now() },
				snapshot: this.#options.snapshot,
			});
			return;
		}
		if (!connection.authenticated) {
			connection.send({ kind: "error", code: "hello_required", message: "hello first" });
			connection.close();
			return;
		}
		const handler = this.#options.onMessage ?? ((conn, msg) => this.#defaultOnMessage(conn, msg));
		handler(connection, message);
	}

	#defaultOnMessage(connection: FakeConnection, message: AttachClientMessage): void {
		switch (message.kind) {
			case "subscribe":
				connection.send({ kind: "snapshot", snapshot: this.#options.snapshot });
				return;
			case "follow_up":
				connection.send({
					kind: "event",
					event: { type: "follow_up_accepted", key: message.key, ref: message.ref },
				});
				connection.send({
					kind: "event",
					event: {
						type: "follow_up_result",
						key: message.key,
						ref: message.ref,
						ok: true,
						payload: "turn-done",
					},
				});
				return;
			case "ping":
				connection.send({ kind: "pong", nonce: message.nonce });
				return;
			case "bye":
				connection.send({ kind: "bye" });
				connection.close();
				return;
			case "abort":
				return;
			case "hello":
				return;
		}
	}
}

describe("attach client", () => {
	let dir: string;
	const clients: AttachClient[] = [];
	const servers: FakeServer[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-client-test-"));
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.stop();
		for (const server of servers.splice(0)) await server.stop().catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	});

	function startClient(
		overrides: {
			readonly socketFile?: string;
			readonly token?: string;
			readonly workerId?: string;
			readonly maxRenderedLines?: number;
			readonly backoffMs?: readonly number[];
			readonly pingIntervalMs?: number;
			readonly onExit?: (code: number) => void;
			readonly stdout?: CollectingStream;
			readonly stdin?: PassThrough;
		} = {},
	): {
		client: AttachClient;
		stdout: CollectingStream;
		stdin: PassThrough;
		exits: number[];
	} {
		const stdout = overrides.stdout ?? new CollectingStream();
		const stdin = overrides.stdin ?? new PassThrough();
		const exits: number[] = [];
		const client = new AttachClient(
			overrides.socketFile ?? path.join(dir, "attach.sock"),
			overrides.token ?? TOKEN,
			overrides.workerId ?? "w1",
			{
				stdout,
				stdin,
				enableSignals: false,
				pingIntervalMs: overrides.pingIntervalMs ?? 60_000,
				backoffMs: overrides.backoffMs ?? [10, 20, 40],
				maxRenderedLines: overrides.maxRenderedLines ?? 500,
				onExit: code => {
					exits.push(code);
					overrides.onExit?.(code);
				},
			},
		);
		clients.push(client);
		return { client, stdout, stdin, exits };
	}

	it("exits 1 on auth_failed and does not reconnect", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot(),
		});
		servers.push(server);

		const { client, exits } = startClient({ token: "b".repeat(64) });
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(1);

		// Longer than the whole backoff sequence: a live client would have
		// reconnected by now, an exited one must not.
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(server.connections.length).toBe(1);
	});

	it("renders the subscribed worker's status and subscribes with the worker id", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry({ state: "running", summary: "turn 1" })]),
		});
		servers.push(server);

		const { client, stdout } = startClient();
		await client.start();

		const status = await poll(() => lineWith(stdout, "[running]"));
		expect(status).toContain("turn 1");

		const subscribe = await poll(() => server.received.find(message => message.kind === "subscribe"));
		expect(subscribe).toMatchObject({ kind: "subscribe", workerIds: ["w1"] });
	});

	it("renders progress output and prints a trim marker once past maxRenderedLines", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry({ state: "running", summary: "working" })]),
			onMessage: (connection, message) => {
				if (message.kind !== "subscribe") return;
				connection.send({
					kind: "snapshot",
					snapshot: snapshot([entry({ state: "running", summary: "working" })]),
				});
				for (let i = 0; i < 8; i += 1) {
					connection.send({
						kind: "event",
						event: {
							type: "progress",
							key: KEY,
							at: Date.now(),
							currentTool: i === 0 ? "bash" : undefined,
							currentToolArgs: i === 0 ? "ls -la" : undefined,
							lastIntent: i === 1 ? "check the files" : undefined,
							outputTail: [`out-${i}`],
						},
					});
				}
			},
		});
		servers.push(server);

		const { client, stdout } = startClient({ maxRenderedLines: 5 });
		await client.start();

		await poll(() => lineWith(stdout, "out-7"));
		expect(lineWith(stdout, "tool: bash")).toContain("ls -la");
		expect(lineWith(stdout, "intent: check the files")).toBeDefined();

		// The trim marker is emitted exactly once, and rendering keeps flowing.
		expect(stdout.lines().filter(line => line.includes("[trimmed")).length).toBe(1);
	});

	it("sends a follow-up per stdin line and renders the result", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry()]),
		});
		servers.push(server);

		const { client, stdout, stdin } = startClient();
		await client.start();

		stdin.write("continue please\n");
		const followUp = await poll(() => server.received.find(message => message.kind === "follow_up"));
		expect(followUp).toMatchObject({ kind: "follow_up", ref: "f1", key: KEY, payload: "continue please" });

		const result = await poll(() => lineWith(stdout, "[result]"));
		expect(result).toContain("turn-done");
	});

	it("queues follow-ups while one is in flight and flushes them in order", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry()]),
			onMessage: (connection, message) => {
				if (message.kind === "subscribe") {
					connection.send({ kind: "snapshot", snapshot: snapshot([entry()]) });
					return;
				}
				if (message.kind !== "follow_up") return;
				if (message.ref === "f1") {
					connection.send({
						kind: "event",
						event: { type: "follow_up_accepted", key: KEY, ref: "f1" },
					});
					// Leave f1 in flight long enough for the hold assertion to
					// observe that nothing else leaves the wire; resolve later.
					setTimeout(() => {
						connection.send({
							kind: "event",
							event: { type: "follow_up_result", key: KEY, ref: "f1", ok: true, payload: "first-done" },
						});
					}, 400);
					return;
				}
				connection.send({
					kind: "error",
					code: "busy",
					message: "follow-up already in flight",
					ref: message.ref,
				});
			},
		});
		servers.push(server);

		const { client, stdout, stdin, exits } = startClient();
		await client.start();

		stdin.write("first\n");
		await poll(() => server.received.find(message => message.kind === "follow_up" && message.ref === "f1"));
		stdin.write("second\n");
		stdin.write("third\n");

		// While f1 is in flight the follow-ups are held client-side: nothing
		// else leaves the wire until the in-flight follow-up settles.
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(server.received.filter(message => message.kind === "follow_up")).toHaveLength(1);

		// f1 settles → the queue flushes in order (f2, then f3 after the busy
		// error frees the slot). The busy display remains for external
		// concurrency; the client stays alive throughout.
		await poll(() => lineWith(stdout, "first-done"));
		const f2 = await poll(() =>
			server.received.find(message => message.kind === "follow_up" && message.ref === "f2"),
		);
		expect(f2).toMatchObject({ kind: "follow_up", ref: "f2", key: KEY, payload: "second" });
		await poll(() => lineWith(stdout, "busy"));
		const f3 = await poll(() =>
			server.received.find(message => message.kind === "follow_up" && message.ref === "f3"),
		);
		expect(f3).toMatchObject({ kind: "follow_up", ref: "f3", key: KEY, payload: "third" });
		await poll(() => (stdout.lines().filter(line => line.includes("busy")).length >= 2 ? true : undefined));
		expect(exits).toEqual([]);
	});

	it("prints the removal reason and exits 0 on removed", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry()]),
			onMessage: (connection, message) => {
				if (message.kind !== "subscribe") return;
				connection.send({ kind: "snapshot", snapshot: snapshot([entry()]) });
				connection.send({ kind: "event", event: { type: "removed", key: KEY, reason: "killed by user" } });
			},
		});
		servers.push(server);

		const { client, stdout, exits } = startClient();
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		expect(lineWith(stdout, "[removed]")).toContain("killed by user");
	});

	it("exits 0 on a server bye", async () => {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry()]),
			onMessage: (connection, message) => {
				if (message.kind !== "subscribe") return;
				connection.send({ kind: "snapshot", snapshot: snapshot([entry()]) });
				connection.send({ kind: "bye", reason: "shutting down" });
			},
		});
		servers.push(server);

		const { client, stdout, exits } = startClient();
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		// The protocol decoder drops the bye `reason` field, so the client can
		// only render the bare marker.
		expect(lineWith(stdout, "[bye]")).toBe("[bye]");
	});

	it("reconnects with backoff after the server restarts", async () => {
		const socketFile = path.join(dir, "attach.sock");
		const first = await FakeServer.listen(socketFile, { token: TOKEN, snapshot: snapshot([entry()]) });
		servers.push(first);

		const { client, exits } = startClient({ socketFile });
		await client.start();

		// Simulate a server restart: drop the connection and the socket file.
		await first.stop();
		await fs.rm(socketFile, { force: true });

		const second = await FakeServer.listen(socketFile, { token: TOKEN, snapshot: snapshot([entry()]) });
		servers.push(second);

		// The client re-authenticates and resubscribes on the new server.
		const hello = await poll(() => second.received.find(message => message.kind === "hello"));
		expect(hello).toMatchObject({ kind: "hello", capability: TOKEN });
		await poll(() => second.received.find(message => message.kind === "subscribe"));
		expect(exits).toEqual([]);
	});
});

describe("attach cli", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-cli-test-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("derives socket and token paths from the session file", () => {
		const sessionFile = path.join("sessions", "abc-123.jsonl");
		expect(resolveAttachPaths(sessionFile)).toEqual({
			socketFile: path.join("sessions", "abc-123", "attach", "attach.sock"),
			tokenFile: path.join("sessions", "abc-123", "attach", "attach.token"),
		});
	});

	it("honors socket and token overrides", () => {
		const paths = resolveAttachPaths("session.jsonl", {
			socket: "/tmp/custom.sock",
			tokenFile: "/tmp/custom.token",
		});
		expect(paths).toEqual({ socketFile: "/tmp/custom.sock", tokenFile: "/tmp/custom.token" });
	});

	it("returns null for a missing or empty token file and trims a valid one", async () => {
		expect(await readAttachToken(path.join(dir, "missing.token"))).toBeNull();

		const emptyFile = path.join(dir, "empty.token");
		await fs.writeFile(emptyFile, "  \n");
		expect(await readAttachToken(emptyFile)).toBeNull();

		const goodFile = path.join(dir, "good.token");
		await fs.writeFile(goodFile, " abcdef \n");
		expect(await readAttachToken(goodFile)).toBe("abcdef");
	});

	it("exits 1 with a stderr message when the token file is missing", async () => {
		const sessionFile = path.join(dir, "session.jsonl");
		const missingToken = path.join(dir, "missing.token");
		const stderr = new CollectingStream();
		const previousExitCode = process.exitCode ?? 0;
		try {
			const command = new Attach(
				["w1", "--session-file", sessionFile, "--token-file", missingToken],
				{ bin: "omp", version: "test", commands: new Map() },
				{ stderr },
			);
			await command.run();
			expect(process.exitCode).toBe(1);
			expect(stderr.text).toContain("cannot read capability token");
		} finally {
			process.exitCode = previousExitCode;
		}
	});
});
