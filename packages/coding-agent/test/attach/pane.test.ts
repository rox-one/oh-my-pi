import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type Container, ProcessTerminal, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { AttachPane } from "../../src/attach/pane";
import {
	type AttachClientMessage,
	type AttachEvent,
	AttachFrameAccumulator,
	type AttachLease,
	type AttachMessage,
	type AttachSessionEntry,
	type AttachWorkerKey,
	decodeAttachLine,
	encodeAttachMessage,
} from "../../src/attach/protocol";
import { Settings } from "../../src/config/settings";
import { initTheme } from "../../src/modes/theme/theme";
import type { SessionMessageEntry } from "../../src/session/session-entries";

const KEY: AttachWorkerKey = { workerId: "w1", ownerScope: "scope-a" };

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

function messageEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function progress(
	overrides: Partial<Extract<AttachEvent, { type: "progress" }>> = {},
): Extract<AttachEvent, { type: "progress" }> {
	return { type: "progress", key: KEY, at: 1, outputTail: [], ...overrides };
}

/** Poll `produce` until it yields a non-undefined value.
 * Integration exception: these tests drive real Unix-socket I/O, where the
 * delivery of a frame is an OS-level event that cannot be advanced by fake
 * timers — the 5ms tick only re-checks a condition that the socket event
 * itself satisfies, so it never "waits long enough", it waits for the event. */
async function poll<T>(produce: () => T | undefined, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = produce();
		if (value !== undefined) return value;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 5);
		await promise;
	}
	throw new Error(`timed out after ${timeoutMs}ms`);
}

const TOKEN = "a".repeat(64);

/** Test seam: scripted handling for the client's `view_open` frame. */
type ViewOpenHandler = (socket: net.Socket, message: Extract<AttachClientMessage, { kind: "view_open" }>) => void;

/**
 * Minimal attach server: auth, view_open grants (with an optional transcript
 * epoch), prompt accepted, detach bye. Result and error frames are injected by
 * the test through {@link FakeServer.send} so the state machine is driven
 * deterministically with no timer races.
 */
class FakeServer {
	readonly socketFile: string;
	readonly received: AttachClientMessage[] = [];
	lastGrantedLease: AttachLease | null = null;
	readonly #server: net.Server;
	readonly #accumulator = new AttachFrameAccumulator();
	#sockets = new Set<net.Socket>();
	#epoch = 0;
	readonly #autoTranscript: boolean;
	readonly #onViewOpen: ViewOpenHandler | undefined;

	private constructor(socketFile: string, options: { autoTranscript?: boolean; onViewOpen?: ViewOpenHandler } = {}) {
		this.socketFile = socketFile;
		this.#autoTranscript = options.autoTranscript ?? true;
		this.#onViewOpen = options.onViewOpen;
		this.#server = net.createServer(socket => {
			this.#sockets.add(socket);
			socket.on("data", chunk => {
				for (const frame of this.#accumulator.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
					const message = decodeAttachLine(frame) as AttachClientMessage;
					this.received.push(message);
					this.#handle(socket, message);
				}
			});
			socket.on("error", () => {});
			socket.on("close", () => this.#sockets.delete(socket));
		});
	}

	static async listen(
		socketFile: string,
		options: { autoTranscript?: boolean; onViewOpen?: ViewOpenHandler } = {},
	): Promise<FakeServer> {
		const server = new FakeServer(socketFile, options);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.#server.once("error", reject);
		server.#server.listen(socketFile, () => {
			server.#server.removeListener("error", reject);
			resolve();
		});
		await promise;
		return server;
	}

	async stop(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#server.close(() => resolve());
		await promise;
	}

	/** Inject a server→client frame (results, errors, events, transcript). */
	send(message: AttachMessage): void {
		for (const socket of this.#sockets) socket.write(encodeAttachMessage(message));
	}

	#handle(socket: net.Socket, message: AttachClientMessage): void {
		const send = (reply: AttachMessage): void => {
			socket.write(encodeAttachMessage(reply));
		};
		switch (message.kind) {
			case "hello":
				send({
					kind: "hello_ok",
					version: 2,
					server: { pid: process.pid, startedAt: Date.now() },
					snapshot: { version: 2, generatedAt: Date.now(), sessions: [entry({ state: "idle" })] },
				});
				return;
			case "view_open":
				if (this.#onViewOpen) {
					this.#onViewOpen(socket, message);
					return;
				}
				this.#grantView(socket, message.key, 1);
				return;
			case "prompt":
				send({ kind: "prompt_accepted", key: KEY, ref: message.ref, cmdId: message.cmdId });
				return;
			case "abort_turn":
				return;
			case "detach":
				send({ kind: "bye", reason: message.reason ?? "detached" });
				socket.destroy();
				return;
			case "ping":
				send({ kind: "pong", nonce: message.nonce });
				return;
			case "bye":
				send({ kind: "bye" });
				socket.destroy();
				return;
		}
	}

	#grantView(socket: net.Socket, key: AttachWorkerKey, generation: number): void {
		const lease: AttachLease = {
			leaseId: randomUUID(),
			proof: "f".repeat(64),
			generation,
			graceMs: 30_000,
		};
		this.lastGrantedLease = lease;
		this.#epoch += 1;
		const epoch = this.#epoch;
		const send = (reply: AttachMessage): void => {
			socket.write(encodeAttachMessage(reply));
		};
		send({
			kind: "view_open_ok",
			key,
			lease,
			epoch,
			entry: entry({ state: "idle" }),
			cwd: "/cwd",
		});
		if (this.#autoTranscript) {
			send({ kind: "transcript_begin", key: KEY, epoch, seq: 1 });
			send({ kind: "transcript_items", key: KEY, epoch, seq: 2, items: [] });
			send({ kind: "transcript_end", key: KEY, epoch, seq: 3, watermark: 0 });
		}
	}
}

/** Fake TUI surface the pane needs (components never render through it in
 *  these tests; the presenter only reads terminal columns + imageBudget). */
function fakeTui(listeners: Array<(data: string) => { consume?: boolean } | undefined>, columns = 120) {
	return {
		addInputListener: vi.fn((listener: (data: string) => { consume?: boolean } | undefined) => {
			listeners.push(listener);
			return () => {};
		}),
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		resetDisplay: vi.fn(),
		showOverlay: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { rows: 24, columns },
		imageBudget: undefined,
	} as unknown as TUI;
}

describe("attach pane constructor and keys (thin host)", () => {
	let listeners: Array<(data: string) => { consume?: boolean } | undefined>;
	let exits: number[];
	let ui: ReturnType<typeof fakeTui>;

	beforeEach(async () => {
		await initTheme();
		await Settings.init();
		listeners = [];
		exits = [];
		ui = fakeTui(listeners);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makePane(): AttachPane {
		const pane = new AttachPane("/tmp/attach.sock", TOKEN, "w1", {
			ui,
			onExit: code => {
				exits.push(code);
			},
		});
		expect(listeners).toHaveLength(1);
		return pane;
	}

	it("wires the input listener and exposes the composer and initial status", () => {
		const pane = makePane();
		expect(pane.getEditor()).toBeDefined();
		const status = pane.getStatus();
		expect(status.connection).toBe("connecting");
		expect(status.state).toBeNull();
		expect(status.model).toBeUndefined();
		expect(status.summary).toBeNull();
		expect(status.currentTool).toBeNull();
		expect(status.queued).toBe(0);
		expect(status.inFlight).toBe(false);
		expect(status.lastResult).toBeNull();
	});

	it("Escape clears the draft without exiting", () => {
		const pane = makePane();
		pane.getEditor().setText("draft");
		const result = listeners[0]!("\x1b");
		expect(result).toEqual({ consume: true });
		expect(pane.getEditor().textEquals("")).toBe(true);
		expect(exits).toEqual([]);
	});

	it("Escape on an empty draft is a no-op", () => {
		makePane();
		const result = listeners[0]!("\x1b");
		expect(result).toEqual({ consume: true });
		expect(exits).toEqual([]);
	});

	it("Ctrl-C clears a non-empty draft without exiting", () => {
		const pane = makePane();
		pane.getEditor().setText("half-typed");
		const result = listeners[0]!("\x03");
		expect(result).toEqual({ consume: true });
		expect(pane.getEditor().textEquals("")).toBe(true);
		expect(exits).toEqual([]);
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("ignores unrelated keys so the editor receives them", () => {
		makePane();
		expect(listeners[0]!("x")).toBeUndefined();
		expect(listeners[0]!("enter")).toBeUndefined();
		expect(exits).toEqual([]);
	});
});

describe("attach pane fullscreen host", () => {
	let dir: string;
	let listeners: Array<(data: string) => { consume?: boolean } | undefined>;
	let exits: number[];
	let ui: ReturnType<typeof fakeTui>;
	let server: FakeServer;
	let pane: AttachPane;

	beforeEach(async () => {
		await initTheme();
		await Settings.init();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-pane-e2e-"));
		listeners = [];
		exits = [];
		ui = fakeTui(listeners);
	});

	afterEach(async () => {
		pane?.stop();
		await server?.stop().catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function startPane(
		options: { autoTranscript?: boolean; onViewOpen?: ViewOpenHandler } = {},
	): Promise<AttachPane> {
		server = await FakeServer.listen(path.join(dir, "attach.sock"), options);
		const created = new AttachPane(server.socketFile, TOKEN, "w1", {
			ui,
			pingIntervalMs: 60_000,
			onExit: code => {
				exits.push(code);
			},
		});
		pane = created;
		await pane.start();
		return created;
	}

	function submit(text: string): void {
		pane.getEditor().setText(text);
		pane.getEditor().submit();
	}

	it("shows the fullscreen overlay, focuses the composer, and connects", async () => {
		await startPane();
		expect(ui.showOverlay).toHaveBeenCalledTimes(1);
		const [root, overlayOptions] = (ui.showOverlay as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(root).toBeDefined();
		expect(overlayOptions).toMatchObject({ fullscreen: true, width: "100%", maxHeight: "100%" });
		expect(ui.setFocus).toHaveBeenCalledWith(pane.getEditor());
		expect(ui.start).toHaveBeenCalled();
		expect(pane.getStatus().connection).toBe("connected");
	});

	it("submits the composer text as a leased prompt with cmdSeq and ref", async () => {
		await startPane();
		submit("continue the task");

		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({
			kind: "prompt",
			text: "continue the task",
			leaseId: server.lastGrantedLease!.leaseId,
			proof: server.lastGrantedLease!.proof,
			generation: server.lastGrantedLease!.generation,
			cmdSeq: 1,
			ref: "p1",
		});
		const status = pane.getStatus();
		expect(status.queued).toBe(1);
		expect(status.inFlight).toBe(true);
	});

	it("rejects owner-only slash commands without sending a prompt", async () => {
		await startPane();
		submit("/new");

		// The draft is cleared and no control leaves the wire.
		expect(pane.getEditor().textEquals("")).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(server.received.some(message => message.kind === "prompt")).toBe(false);
		expect(ui.requestRender).toHaveBeenCalled();
	});

	/** Concatenated render of every overlay child at `width`. */
	function renderedOverlay(width = 120): string {
		const [root] = (ui.showOverlay as ReturnType<typeof vi.fn>).mock.calls[0]! as [Container];
		return root.children.flatMap(child => [...child.render(width)]).join("\n");
	}

	it("renders the notice row for a rejected slash command and clears it on submit", async () => {
		await startPane();
		expect(renderedOverlay()).not.toContain("owner-only session commands");

		// A leading-`/` submission is rejected with a visible notice row.
		submit("/model gpt-5");
		expect(renderedOverlay()).toContain("owner-only session commands are not supported in a worker pane");

		// A successful submission clears the notice.
		submit("continue");
		expect(renderedOverlay()).not.toContain("owner-only session commands");
	});

	it("renders the abort feedback notice on Ctrl-C with an empty draft", async () => {
		await startPane();
		listeners[0]!("\x03");
		expect(renderedOverlay()).toContain("aborting current turn…");
	});

	it("keeps the notice row to a single width-capped line on narrow terminals", async () => {
		await startPane();
		submit("/model gpt-5");

		// The overlay children are header, notice row, transcript, editor.
		const [root] = (ui.showOverlay as ReturnType<typeof vi.fn>).mock.calls[0]! as [Container];
		expect(root.children).toHaveLength(4);
		const noticeLines = [...root.children[1]!.render(24)];
		expect(noticeLines).toHaveLength(1);
		expect(visibleWidth(noticeLines[0]!)).toBeLessThanOrEqual(24);
	});

	it("tracks queued/in-flight through prompt_accepted and results", async () => {
		await startPane();

		submit("first");
		submit("second");
		await poll(() => (pane.getStatus().queued === 2 ? pane.getStatus() : undefined));
		expect(pane.getStatus().inFlight).toBe(true);

		server.send({ kind: "prompt_accepted", key: KEY, ref: "p1", cmdId: "c1" });
		expect(pane.getStatus().inFlight).toBe(true);

		// The first result settles one outstanding; the transport flushes the
		// second prompt synchronously, so the slot must stay busy.
		server.send({ kind: "prompt_result", key: KEY, ref: "p1", cmdId: "c1", ok: true, payload: "first-done" });
		const middle = await poll(() => (pane.getStatus().queued === 1 ? pane.getStatus() : undefined));
		expect(middle.inFlight).toBe(true);

		// The second prompt reached the wire; settling it drains the queue.
		await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p2"));
		server.send({ kind: "prompt_result", key: KEY, ref: "p2", cmdId: "c2", ok: true, payload: "second-done" });
		const done = await poll(() => (pane.getStatus().queued === 0 ? pane.getStatus() : undefined));
		expect(done.inFlight).toBe(false);
		expect(done.lastResult).toBe("second-done");
	});

	it("a ref-carrying rejection settles one outstanding and keeps the next in flight", async () => {
		await startPane();

		submit("first");
		submit("second");
		await poll(() => (pane.getStatus().queued === 2 ? pane.getStatus() : undefined));

		server.send({
			kind: "control_rejected",
			key: KEY,
			cmdId: "c1",
			ref: "p1",
			code: "busy",
			message: "external client busy",
		});
		const middle = await poll(() => (pane.getStatus().queued === 1 ? pane.getStatus() : undefined));
		expect(middle.inFlight).toBe(true);

		await poll(() => server.received.find(message => message.kind === "prompt" && message.ref === "p2"));
		server.send({ kind: "prompt_result", key: KEY, ref: "p2", cmdId: "c2", ok: true, payload: "done" });
		const done = await poll(() => (pane.getStatus().queued === 0 ? pane.getStatus() : undefined));
		expect(done.inFlight).toBe(false);
	});

	it("Ctrl-C on an empty draft aborts the turn without exiting", async () => {
		await startPane();
		const result = listeners[0]!("\x03");
		expect(result).toEqual({ consume: true });
		const frame = await poll(() => server.received.find(message => message.kind === "abort_turn"));
		expect(frame).toMatchObject({
			kind: "abort_turn",
			leaseId: server.lastGrantedLease!.leaseId,
			proof: server.lastGrantedLease!.proof,
			generation: server.lastGrantedLease!.generation,
			cmdSeq: 1,
		});
		expect(exits).toEqual([]); // abort never exits
	});

	it("Ctrl-D detaches: sends detach, exits 0, and restores the terminal", async () => {
		await startPane();
		const result = listeners[0]!("\x04");
		expect(result).toEqual({ consume: true });

		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		const frame = await poll(() => server.received.find(message => message.kind === "detach"));
		expect(frame).toMatchObject({
			kind: "detach",
			leaseId: server.lastGrantedLease!.leaseId,
			reason: "user",
		});
		await poll(() => ((ui.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0 ? true : undefined));
	});

	it("renders a live line from progress events", async () => {
		await startPane();
		server.send({ kind: "event", event: progress({ currentTool: "bash", currentToolArgs: "ls -la" }) });
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("bash") ? rendered : undefined;
		});
		expect(text).toContain("⚙ bash ls -la");
	});

	it("sanitizes progress tool/args: tabs, escapes, and control chars", async () => {
		await startPane();
		server.send({
			kind: "event",
			event: progress({ currentTool: "bash", currentToolArgs: "\tls -la\x1b[31m\x07" }),
		});
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("bash") ? rendered : undefined;
		});
		// Tabs are expanded; ANSI/control sequences never reach the rendered row.
		expect(text).toContain("⚙ bash ls -la");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\x07");
	});

	it("shortens absolute home paths in progress candidates", async () => {
		await startPane();
		server.send({
			kind: "event",
			event: progress({ lastIntent: path.join(os.homedir(), "notes.md") }),
		});
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("notes.md") ? rendered : undefined;
		});
		expect(text).toContain("~/notes.md");
		expect(text).not.toContain(os.homedir());

		server.send({
			kind: "event",
			event: progress({ outputTail: ["", path.join(os.homedir(), "repo", "src", "main.ts")] }),
		});
		const tailText = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("main.ts") ? rendered : undefined;
		});
		expect(tailText).toContain("~/repo/src/main.ts");
		expect(tailText).not.toContain(os.homedir());
	});

	it("sanitizes progress lastIntent and outputTail escape/control candidates", async () => {
		await startPane();
		server.send({
			kind: "event",
			event: progress({ lastIntent: "read\t/home/notes\x1b[0m" }),
		});
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("read") ? rendered : undefined;
		});
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\x1b");

		server.send({
			kind: "event",
			event: progress({ outputTail: ["", "done\x1b[32m at \x07/home/x"] }),
		});
		const tailText = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("done") ? rendered : undefined;
		});
		expect(tailText).toContain("done at /home/x");
		expect(tailText).not.toContain("\x1b");
		expect(tailText).not.toContain("\x07");
	});

	it("truncates the live progress line to the terminal width at event time", async () => {
		ui = fakeTui(listeners, 24); // narrow terminal: live line capped at 23
		await startPane();
		server.send({ kind: "event", event: progress({ outputTail: ["x".repeat(200)] }) });
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("x") ? rendered : undefined;
		});
		const line = text.split("\n").find(l => l.includes("x"))!;
		expect(visibleWidth(line)).toBeLessThanOrEqual(23);
		expect(line.length).toBeLessThan(200);
	});

	it("keeps live lines that fit the terminal width (no fixed ad-hoc cap)", async () => {
		await startPane(); // fake terminal columns: 120 → live line width 119
		const line = "y".repeat(100);
		server.send({ kind: "event", event: progress({ outputTail: [line] }) });
		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("y") ? rendered : undefined;
		});
		expect(text).toContain(line);
	});

	it("renders transcript snapshot frames through the shared presenter", async () => {
		await startPane({ autoTranscript: false });
		const epoch = 1;
		server.send({ kind: "transcript_begin", key: KEY, epoch, seq: 1 });
		server.send({
			kind: "transcript_items",
			key: KEY,
			epoch,
			seq: 2,
			items: [messageEntry("m1", "hello worker pane")],
		});
		server.send({ kind: "transcript_end", key: KEY, epoch, seq: 3, watermark: 1, model: "deepseek/ds" });

		const text = await poll(() => {
			const rendered = pane.getTranscriptText();
			return rendered.includes("hello worker pane") ? rendered : undefined;
		});
		expect(text).toContain("hello worker pane");
	});

	it("keeps status.model unset after transcript_end (the presenter owns the model label)", async () => {
		await startPane({ autoTranscript: false });
		server.send({ kind: "transcript_begin", key: KEY, epoch: 1, seq: 1 });
		server.send({ kind: "transcript_items", key: KEY, epoch: 1, seq: 2, items: [] });
		server.send({ kind: "transcript_end", key: KEY, epoch: 1, seq: 3, watermark: 0, model: "deepseek/ds" });
		await poll(() => {
			const status = pane.getStatus();
			return status.connection === "connected" && status.queued === 0 ? status : undefined;
		});
		// The pane's status descriptor is fed by entry/state/prompt events only;
		// transcript_end model metadata goes to the shared presenter.
		expect(pane.getStatus().model).toBeUndefined();
	});

	it("exits 0 and restores the terminal when the worker is removed", async () => {
		await startPane();
		server.send({ kind: "event", event: { type: "removed", key: KEY, reason: "killed by user" } });
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(0);
		await poll(() => ((ui.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0 ? true : undefined));
	});

	it("exits 1 when view_open is rejected with lease_busy", async () => {
		await startPane({
			onViewOpen: (socket, message) => {
				socket.write(
					encodeAttachMessage({
						kind: "view_open_rejected",
						key: message.key,
						code: "lease_busy",
						message: "controlled by another pane client",
						holder: { generation: 1, expiresInMs: 30_000 },
					}),
				);
			},
		});
		await poll(() => (exits.length > 0 ? exits[0] : undefined));
		expect(exits[0]).toBe(1);
		await poll(() => ((ui.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0 ? true : undefined));
	});
});

describe("attach pane focus (real TUI)", () => {
	let dir: string;
	let server: FakeServer;
	let pane: AttachPane;
	let ui: TUI;

	beforeEach(async () => {
		await initTheme();
		await Settings.init();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-pane-focus-"));
		ui = new TUI(new ProcessTerminal());
	});

	afterEach(async () => {
		pane?.stop();
		await server?.stop().catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("focuses the composer inside the fullscreen overlay and typing reaches the wire", async () => {
		server = await FakeServer.listen(path.join(dir, "attach.sock"));
		pane = new AttachPane(server.socketFile, TOKEN, "w1", {
			ui,
			pingIntervalMs: 60_000,
			onExit: () => {},
		});
		await pane.start();

		// Regression: with a plain Container overlay, tui.ts setFocus()
		// rejects the composer via isOverlayFocusTarget and re-owns focus on
		// the root, which has no handleInput — every keystroke is dropped
		// while rendering still looks perfect. The pane root must own the
		// composer as its focus target.
		expect(ui.getFocused()).toBe(pane.getEditor());
		expect(pane.getEditor().focused).toBe(true);

		// Typing through the TUI dispatch path lands in the composer.
		const focused = ui.getFocused()!;
		focused.handleInput!("x");
		focused.handleInput!("y");
		expect(pane.getEditor().getText()).toBe("xy");

		// Submitting through the editor reaches the worker wire as a prompt.
		focused.handleInput!("\r");
		const prompt = await poll(() => server.received.find(message => message.kind === "prompt"));
		expect(prompt).toMatchObject({ kind: "prompt", text: "xy" });
	});
});
