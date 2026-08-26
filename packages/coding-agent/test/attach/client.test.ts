import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import Attach, { readAttachToken, resolveAttachPaths } from "../../src/attach/cli";
import { AttachClient, type AttachView } from "../../src/attach/client";
import {
	type AttachClientMessage,
	AttachFrameAccumulator,
	type AttachLease,
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
	return { version: 2, generatedAt: Date.now(), sessions };
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
		// destroy() matches the real AttachServer's connection close; end()
		// leaves the server socket half-open after a peer destroy, which
		// would hang server.close() in teardown. Writes issued just before
		// close() still flush to the kernel before the handle closes.
		this.#socket.destroy();
	}
}

interface FakeServerOptions {
	/** Capability the fake server expects in `hello`. */
	readonly token: string;
	/** Snapshot sent in `hello_ok` and pushed on `subscribe` by default. */
	readonly snapshot: AttachSnapshot;
	/** Entry delivered in `view_open_ok`. */
	readonly viewEntry?: AttachSessionEntry;
	/**
	 * Called for every authenticated client message. `next` runs the default
	 * scripted flow; call it to keep default handling (e.g. view_open grants)
	 * and layer extra behavior on top.
	 */
	readonly onMessage?: (
		connection: FakeConnection,
		message: AttachClientMessage,
		next: (connection: FakeConnection, message: AttachClientMessage) => void,
	) => void;
}

/**
 * Minimal attach server for tests: hello/auth, view_open (grant/resume leases
 * and stream a transcript snapshot epoch), prompt/abort_turn/detach handling,
 * and scripted messages. Leases are remembered per worker so a reconnecting
 * client can resume its own lease within the grace window.
 */
class FakeServer {
	readonly socketFile: string;
	readonly received: AttachClientMessage[] = [];
	readonly connections: FakeConnection[] = [];
	/** Last lease granted in a view_open_ok (test seam). */
	lastGrantedLease: AttachLease | null = null;
	readonly #server: net.Server;
	readonly #options: FakeServerOptions;
	readonly #leases = new Map<string, AttachLease>();
	#epoch = 0;

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

	/** Drop every live connection (simulates a socket-level disconnect). */
	dropConnections(): void {
		for (const connection of this.connections) connection.close();
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
				version: 2,
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
		const handler = this.#options.onMessage ?? ((_conn, _msg, next) => next(_conn, _msg));
		handler(connection, message, (conn, msg) => this.#defaultOnMessage(conn, msg));
	}

	#defaultOnMessage(connection: FakeConnection, message: AttachClientMessage): void {
		switch (message.kind) {
			case "view_open":
				this.#handleViewOpen(connection, message);
				return;
			case "prompt":
				connection.send({
					kind: "prompt_accepted",
					key: KEY,
					ref: message.ref,
					cmdId: message.cmdId,
				});
				return;
			case "abort_turn":
				return;
			case "detach":
				connection.send({ kind: "bye", reason: message.reason ?? "detached" });
				connection.close();
				return;
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

	/** Grant (or resume) a view: view_open_ok + a transcript snapshot epoch. */
	#handleViewOpen(connection: FakeConnection, message: Extract<AttachClientMessage, { kind: "view_open" }>): void {
		const workerId = message.key.workerId;
		const held = this.#leases.get(workerId);
		if (message.resume) {
			if (
				held &&
				held.leaseId === message.resume.leaseId &&
				held.proof === message.resume.proof &&
				held.generation === message.resume.generation
			) {
				const resumed: AttachLease = { ...held, generation: held.generation + 1 };
				this.#leases.set(workerId, resumed);
				this.#grantView(connection, workerId, resumed);
				return;
			}
			connection.send({
				kind: "view_open_rejected",
				key: message.key,
				code: "stale_resume",
				message: "no lease to resume (grace expired?)",
			});
			return;
		}
		if (held) {
			connection.send({
				kind: "view_open_rejected",
				key: message.key,
				code: "lease_busy",
				message: "controlled by another pane client",
				holder: { generation: held.generation, expiresInMs: 30_000 },
			});
			return;
		}
		const lease: AttachLease = {
			leaseId: randomUUID(),
			proof: "f".repeat(64),
			generation: 1,
			graceMs: 30_000,
		};
		this.#leases.set(workerId, lease);
		this.#grantView(connection, workerId, lease);
	}

	#grantView(connection: FakeConnection, workerId: string, lease: AttachLease): void {
		this.lastGrantedLease = lease;
		this.#epoch += 1;
		const epoch = this.#epoch;
		connection.send({
			kind: "view_open_ok",
			key: { workerId, ownerScope: KEY.ownerScope },
			lease,
			epoch,
			entry: this.#options.viewEntry ?? entry(),
			cwd: "/cwd",
		});
		// Complete the snapshot epoch so the client clears its snapshot
		// pending flag and flushes queued prompts.
		connection.send({ kind: "transcript_begin", key: KEY, epoch, seq: 1 });
		connection.send({ kind: "transcript_items", key: KEY, epoch, seq: 2, items: [] });
		connection.send({ kind: "transcript_end", key: KEY, epoch, seq: 3, watermark: 0 });
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
			readonly detachTimeoutMs?: number;
			readonly view?: AttachView;
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
				detachTimeoutMs: overrides.detachTimeoutMs,
				view: overrides.view,
				onExit: code => {
					exits.push(code);
					overrides.onExit?.(code);
				},
			},
		);
		clients.push(client);
		return { client, stdout, stdin, exits };
	}

	async function listenServer(
		options: Omit<FakeServerOptions, "token" | "snapshot"> & Partial<FakeServerOptions> = {},
	) {
		const server = await FakeServer.listen(path.join(dir, "attach.sock"), {
			token: TOKEN,
			snapshot: snapshot([entry()]),
			...options,
		});
		servers.push(server);
		return server;
	}

	it("exits 1 on auth_failed and does not reconnect", async () => {
		const server = await listenServer();

		const { client, exits } = startClient({ token: "b".repeat(64) });
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(1);

		// Longer than the whole backoff sequence: a live client would have
		// reconnected by now, an exited one must not.
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(server.connections.length).toBe(1);
	});

	it("opens a view after hello and renders the worker entry from view_open_ok", async () => {
		const server = await listenServer({ viewEntry: entry({ state: "running", summary: "turn 1" }) });

		const { client, stdout } = startClient();
		await client.start();

		const status = await poll(() => lineWith(stdout, "[running]"));
		expect(status).toContain("turn 1");

		const viewOpen = await poll(() => server.received.find(message => message.kind === "view_open"));
		expect(viewOpen).toMatchObject({ kind: "view_open", key: { workerId: "w1", ownerScope: "" } });
		// First connect has no lease: the decoded frame carries no resume.
		expect((viewOpen as Extract<AttachClientMessage, { kind: "view_open" }>).resume).toBeUndefined();
	});

	it("renders progress output and prints a trim marker once past maxRenderedLines", async () => {
		const server = await listenServer({
			viewEntry: entry({ state: "running", summary: "working" }),
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				connection.send({
					kind: "view_open_ok",
					key: KEY,
					lease: { leaseId: "lease-1", proof: "f".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 1,
					entry: entry({ state: "running", summary: "working" }),
					cwd: "/cwd",
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

		const { client, stdout } = startClient({ maxRenderedLines: 5 });
		await client.start();

		await poll(() => lineWith(stdout, "out-7"));
		expect(lineWith(stdout, "tool: bash")).toContain("ls -la");
		expect(lineWith(stdout, "intent: check the files")).toBeDefined();

		// The trim marker is emitted exactly once, and rendering keeps flowing.
		expect(stdout.lines().filter(line => line.includes("[trimmed")).length).toBe(1);
	});

	it("sends a prompt per stdin line and renders the result", async () => {
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				next(connection, message); // default view_open grant + transcript epoch
				if (message.kind === "prompt") {
					connection.send({ kind: "prompt_accepted", key: KEY, ref: message.ref, cmdId: message.cmdId });
					connection.send({
						kind: "prompt_result",
						key: KEY,
						ref: message.ref,
						cmdId: message.cmdId,
						ok: true,
						payload: "turn-done",
					});
				}
			},
		});

		const { client, stdout, stdin } = startClient();
		await client.start();

		stdin.write("continue please\n");
		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({
			kind: "prompt",
			ref: "p1",
			text: "continue please",
			cmdSeq: 1,
		});
		const result = await poll(() => lineWith(stdout, "[result]"));
		expect(result).toContain("turn-done");
	});

	it("stores the granted lease and sends it on every prompt frame", async () => {
		const server = await listenServer();
		const { client } = startClient();
		await client.start();

		client.sendPrompt("hi there");
		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({
			kind: "prompt",
			leaseId: server.lastGrantedLease!.leaseId,
			proof: server.lastGrantedLease!.proof,
			generation: server.lastGrantedLease!.generation,
			cmdSeq: 1,
		});
		expect((prompt as Extract<AttachClientMessage, { kind: "prompt" }>).cmdId.length).toBeGreaterThan(0);
		expect((prompt as Extract<AttachClientMessage, { kind: "prompt" }>).ref).toBe("p1");
	});

	it("queues prompts while one is in flight and flushes them in order", async () => {
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				next(connection, message); // default view_open grant + transcript epoch
				if (message.kind !== "prompt") return;
				connection.send({ kind: "prompt_accepted", key: KEY, ref: message.ref, cmdId: message.cmdId });
				if (message.ref === "p1") {
					// Leave the first prompt in flight until the hold assertion
					// has observed that nothing else leaves the wire.
					setTimeout(() => {
						connection.send({
							kind: "prompt_result",
							key: KEY,
							ref: message.ref,
							cmdId: message.cmdId,
							ok: true,
							payload: "first-done",
						});
					}, 400);
					return;
				}
				connection.send({
					kind: "prompt_result",
					key: KEY,
					ref: message.ref,
					cmdId: message.cmdId,
					ok: true,
					payload: "turn-done",
				});
			},
		});

		const { client, stdout } = startClient();
		await client.start();

		client.sendPrompt("first");
		await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p1"));
		client.sendPrompt("second");
		client.sendPrompt("third");

		// While p1 is in flight the prompts are held client-side: nothing
		// else leaves the wire until the in-flight prompt settles.
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(server.received.filter(message => message.kind === "prompt")).toHaveLength(1);

		// p1 settles → the queue flushes in order (p2, then p3).
		await poll(() => lineWith(stdout, "first-done"));
		const p2 = await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p2"));
		expect(p2).toMatchObject({ kind: "prompt", ref: "p2", text: "second", cmdSeq: 2 });
		const p3 = await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p3"));
		expect(p3).toMatchObject({ kind: "prompt", ref: "p3", text: "third", cmdSeq: 3 });
	});

	it("prints the removal reason and exits 0 on removed", async () => {
		const server = await listenServer({
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				connection.send({
					kind: "view_open_ok",
					key: KEY,
					lease: { leaseId: "lease-1", proof: "f".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 1,
					entry: entry(),
					cwd: "/cwd",
				});
				connection.send({ kind: "event", event: { type: "removed", key: KEY, reason: "killed by user" } });
			},
		});

		const { client, stdout, exits } = startClient();
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		expect(lineWith(stdout, "[removed]")).toContain("killed by user");
	});

	it("exits 0 on a server bye", async () => {
		const server = await listenServer({
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				connection.send({
					kind: "view_open_ok",
					key: KEY,
					lease: { leaseId: "lease-1", proof: "f".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 1,
					entry: entry(),
					cwd: "/cwd",
				});
				connection.send({ kind: "bye", reason: "shutting down" });
			},
		});

		const { client, stdout, exits } = startClient();
		await client.start();

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		// The protocol decoder drops the bye `reason` field, so the client can
		// only render the bare marker.
		expect(lineWith(stdout, "[bye]")).toBe("[bye]");
	});

	it("reconnects with backoff after the server restarts and resumes the lease", async () => {
		const socketFile = path.join(dir, "attach.sock");
		const first = await FakeServer.listen(socketFile, { token: TOKEN, snapshot: snapshot([entry()]) });
		servers.push(first);

		const { client, exits } = startClient({ socketFile });
		await client.start();
		expect(first.lastGrantedLease).not.toBeNull();

		// Simulate a server restart: drop the connection and the socket file.
		await first.stop();
		await fs.rm(socketFile, { force: true });

		const second = await FakeServer.listen(socketFile, { token: TOKEN, snapshot: snapshot([entry()]) });
		servers.push(second);

		// The client re-authenticates and opens a view on the new server.
		const hello = await poll(() => second.received.find(message => message.kind === "hello"));
		expect(hello).toMatchObject({ kind: "hello", capability: TOKEN });
		const viewOpen = await poll(() => second.received.find(message => message.kind === "view_open"));
		expect(viewOpen).toMatchObject({ kind: "view_open" });
		expect(exits).toEqual([]);
	});

	it("reconnects and presents the held lease as resume on the same server", async () => {
		const server = await listenServer();
		const { client, exits } = startClient();
		await client.start();
		// Capture values, not the live lease object: the server mutates its
		// generation in place when it re-grants on resume.
		const grantedLeaseId = server.lastGrantedLease!.leaseId;
		const grantedProof = server.lastGrantedLease!.proof;
		const grantedGeneration = server.lastGrantedLease!.generation;

		// Drop the socket; the client reconnects within its grace window.
		server.dropConnections();
		const resumed = await poll(() =>
			server.received.find(message => message.kind === "view_open" && message.resume !== undefined),
		);
		expect(resumed).toMatchObject({
			kind: "view_open",
			resume: {
				leaseId: grantedLeaseId,
				proof: grantedProof,
				generation: grantedGeneration,
			},
		});
		expect(exits).toEqual([]);
	});

	it("retries without resume after a stale_resume rejection and keeps the new lease", async () => {
		const server = await listenServer({
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				if (message.resume) {
					connection.send({
						kind: "view_open_rejected",
						key: message.key,
						code: "stale_resume",
						message: "grace expired",
					});
					return;
				}
				connection.send({
					kind: "view_open_ok",
					key: message.key,
					lease: { leaseId: "fresh-lease", proof: "e".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 1,
					entry: entry(),
					cwd: "/cwd",
				});
				connection.send({ kind: "transcript_begin", key: KEY, epoch: 1, seq: 1 });
				connection.send({ kind: "transcript_end", key: KEY, epoch: 1, seq: 2, watermark: 0 });
			},
		});

		const { client } = startClient();
		// First connection grants a lease via the default flow.
		await client.start();

		// Reconnect: the server now rejects the resume as stale.
		server.dropConnections();
		await poll(() => server.received.find(message => message.kind === "view_open" && message.resume !== undefined));

		// The client re-views without resume and keeps the fresh lease.
		const retry = await poll(
			() =>
				server.received.filter(message => message.kind === "view_open").at(-1) as
					| Extract<AttachClientMessage, { kind: "view_open" }>
					| undefined,
		);
		expect(retry.resume).toBeUndefined();
	});

	it("exits 1 when view_open is rejected with lease_busy", async () => {
		const server = await listenServer({
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				connection.send({
					kind: "view_open_rejected",
					key: message.key,
					code: "lease_busy",
					message: "controlled by another pane client",
					holder: { generation: 1, expiresInMs: 30_000 },
				});
			},
		});

		const { client, exits } = startClient();
		await client.start();
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(1);
	});

	it("abortTurn sends abort_turn with the current cmdSeq and lease", async () => {
		const server = await listenServer();
		const { client } = startClient();
		await client.start();

		client.abortTurn();
		const frame = await poll(() => server.received.find(message => message.kind === "abort_turn"));
		expect(frame).toMatchObject({
			kind: "abort_turn",
			leaseId: server.lastGrantedLease!.leaseId,
			proof: server.lastGrantedLease!.proof,
			generation: server.lastGrantedLease!.generation,
			cmdSeq: 1,
		});
	});

	it("detach sends detach with the lease and exits 0", async () => {
		const server = await listenServer();
		const { client, exits } = startClient();
		await client.start();

		client.detach("user");
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		const frame = await poll(() => server.received.find(message => message.kind === "detach"));
		expect(frame).toMatchObject({
			kind: "detach",
			leaseId: server.lastGrantedLease!.leaseId,
			proof: server.lastGrantedLease!.proof,
			generation: server.lastGrantedLease!.generation,
			reason: "user",
		});
	});

	it("queues a prompt submitted during reconnect backoff and delivers it after the view reopens", async () => {
		const server = await listenServer();
		const connections: string[] = [];
		const { client } = startClient({
			backoffMs: [250],
			view: { onConnection: connection => connections.push(connection) },
		});
		await client.start();
		expect(connections).toEqual(["connecting", "connected"]);

		// Drop the socket; the client clears its live send state and enters
		// backoff (the next attempt is 250ms away).
		server.dropConnections();
		// Give the close handler a beat to run before submitting, so the
		// submission lands squarely inside the backoff window.
		await new Promise(resolve => setTimeout(resolve, 50));

		// While the socket is down, a submission must be queued, not lost.
		client.sendPrompt("typed while offline");
		// Still inside the backoff window (reconnect starts at ~250ms):
		// nothing may have left the wire yet.
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(server.received.filter(message => message.kind === "prompt")).toHaveLength(0);
		expect(connections.includes("reconnecting")).toBe(false);

		// After the reconnect + view reopen + snapshot epoch, the queued
		// prompt flushes.
		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({ kind: "prompt", ref: "p1", text: "typed while offline", cmdSeq: 1 });
	});

	it("replays an accepted-then-disconnected prompt unchanged after reconnect and settles it", async () => {
		let first: Extract<AttachClientMessage, { kind: "prompt" }> | null = null;
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				next(connection, message);
				if (message.kind !== "prompt" || first !== null) return;
				first = message;
				connection.send({ kind: "prompt_accepted", key: KEY, ref: message.ref, cmdId: message.cmdId });
				// Accepted, then the connection dies before any prompt_result.
				connection.close();
			},
		});

		const { client, stdout } = startClient();
		await client.start();

		client.sendPrompt("run exactly once");
		await poll(() => server.received.find(message => message.kind === "prompt"));

		// The reconnecting client resends the SAME command identity.
		const replay = await poll(() => {
			const prompts = server.received.filter(
				(message): message is Extract<AttachClientMessage, { kind: "prompt" }> => message.kind === "prompt",
			);
			return prompts.length >= 2 ? prompts.at(-1) : undefined;
		});
		expect(replay.ref).toBe(first!.ref);
		expect(replay.text).toBe(first!.text);
		expect(replay.cmdSeq).toBe(first!.cmdSeq);
		expect(replay.cmdId).toBe(first!.cmdId);
		expect(replay.leaseId).toBe(first!.leaseId);
		expect(replay.proof).toBe(first!.proof);
		// The resumed lease bumps the generation; the replay presents it so
		// the server's generation validation accepts the command.
		expect(replay.generation).toBe(first!.generation + 1);

		// Settle the replayed command with its result.
		server.connections.at(-1)!.send({
			kind: "prompt_result",
			key: KEY,
			ref: replay.ref,
			cmdId: replay.cmdId,
			ok: true,
			payload: "recovered",
		});
		const result = await poll(() => lineWith(stdout, "[result]"));
		expect(result).toContain("recovered");

		// The slot settled: the next submission flows immediately.
		client.sendPrompt("next");
		const next = await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p2"));
		expect(next).toMatchObject({ kind: "prompt", ref: "p2", text: "next" });
	});

	it("holds prompts submitted during the snapshot replay until transcript_end, then flushes", async () => {
		let viewOpens = 0;
		let sentEnd = false;
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				if (message.kind !== "view_open") {
					next(connection, message);
					return;
				}
				viewOpens += 1;
				if (viewOpens === 1) {
					next(connection, message); // default grant + snapshot epoch
					return;
				}
				// Reconnect: open the view but DELAY the transcript snapshot so
				// there is a window where the view is open while the snapshot
				// is still pending.
				connection.send({
					kind: "view_open_ok",
					key: message.key,
					lease: { leaseId: "lease-2", proof: "e".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 2,
					entry: entry(),
					cwd: "/cwd",
				});
				setTimeout(() => {
					connection.send({ kind: "transcript_begin", key: KEY, epoch: 2, seq: 1 });
					connection.send({ kind: "transcript_items", key: KEY, epoch: 2, seq: 2, items: [] });
					connection.send({ kind: "transcript_end", key: KEY, epoch: 2, seq: 3, watermark: 0 });
					sentEnd = true;
				}, 300);
			},
		});

		const viewOpened: boolean[] = [];
		const { client } = startClient({
			backoffMs: [10, 20, 40],
			view: { onViewOpen: () => viewOpened.push(true) },
		});
		await client.start();
		expect(viewOpened).toHaveLength(1);

		// Drop the connection; the client reconnects and reopens the view with
		// a delayed snapshot.
		server.dropConnections();
		await poll(() => (viewOpened.length >= 2 ? true : undefined));

		// The view is open but the snapshot has not completed: a submission
		// must stay queued rather than leave the wire.
		client.sendPrompt("wait for the snapshot");
		await new Promise(resolve => setTimeout(resolve, 120));
		expect(server.received.filter(message => message.kind === "prompt")).toHaveLength(0);
		expect(sentEnd).toBe(false);

		// transcript_end arrives → the queued prompt flushes, after the end.
		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({ kind: "prompt", ref: "p1", text: "wait for the snapshot" });
		expect(sentEnd).toBe(true);
	});

	it("detach waits for the server bye before exiting, even when bye is delayed", async () => {
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				if (message.kind === "detach") {
					// Delay the bye: an immediate-exit implementation would
					// tear the socket down before the server processed the
					// detach frame.
					setTimeout(() => {
						connection.send({ kind: "bye", reason: "detached" });
						connection.close();
					}, 150);
					return;
				}
				next(connection, message);
			},
		});

		const { client, exits } = startClient({ detachTimeoutMs: 5000 });
		await client.start();

		client.detach("user");
		// The server observes the detach frame while the client is still alive.
		await poll(() => server.received.find(message => message.kind === "detach"));
		await new Promise(resolve => setTimeout(resolve, 80));
		expect(exits).toEqual([]);

		// bye arrives → the client exits 0 only then.
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
	});

	it("detach exits via the bounded fallback timer when the server never sends bye", async () => {
		const server = await listenServer({
			onMessage: (connection, message, next) => {
				if (message.kind === "detach") return; // never reply
				next(connection, message);
			},
		});

		const { client, exits } = startClient({ detachTimeoutMs: 60 });
		await client.start();

		client.detach("user");
		// The detach frame reached the server before the client gave up.
		await poll(() => server.received.find(message => message.kind === "detach"));
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
	});

	it("treats an out-of-order transcript frame as a protocol violation and reconnects", async () => {
		const server = await listenServer({
			onMessage: (connection, message) => {
				if (message.kind !== "view_open") return;
				connection.send({
					kind: "view_open_ok",
					key: message.key,
					lease: { leaseId: "lease-1", proof: "f".repeat(64), generation: 1, graceMs: 30_000 },
					epoch: 1,
					entry: entry(),
					cwd: "/cwd",
				});
				// Deliberately out of order: seq must start at 1.
				connection.send({ kind: "transcript_begin", key: KEY, epoch: 1, seq: 99 });
			},
		});

		const { client } = startClient();
		await client.start();

		// The violation schedules a reconnect; a fresh hello + view_open
		// (with the held lease as resume) arrive after the backoff.
		const hello = await poll(() =>
			server.received.filter(message => message.kind === "hello").length >= 2 ? true : undefined,
		);
		expect(hello).toBe(true);
		const resume = await poll(() =>
			server.received.find(message => message.kind === "view_open" && message.resume !== undefined),
		);
		expect(resume).toMatchObject({ kind: "view_open", resume: { leaseId: "lease-1" } });
		client.stop();
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
