import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ProcessTerminal, ScrollView, TUI } from "@oh-my-pi/pi-tui";
import { AttachPane, AttachPaneModel, AttachPaneView } from "../../src/attach/pane";
import {
	type AttachClientMessage,
	type AttachEvent,
	AttachFrameAccumulator,
	type AttachMessage,
	type AttachSessionEntry,
	type AttachWorkerKey,
	decodeAttachLine,
	encodeAttachMessage,
} from "../../src/attach/protocol";
import { initTheme } from "../../src/modes/theme/theme";

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

function progress(
	overrides: Partial<Extract<AttachEvent, { type: "progress" }>> = {},
): Extract<AttachEvent, { type: "progress" }> {
	return { type: "progress", key: KEY, at: 1, outputTail: [], ...overrides };
}

function result(
	overrides: Partial<Extract<AttachEvent, { type: "follow_up_result" }>> = {},
): Extract<AttachEvent, { type: "follow_up_result" }> {
	return { type: "follow_up_result", key: KEY, ref: "f1", ok: true, payload: "turn-done", ...overrides };
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

/**
 * Minimal attach server: auth, snapshot, and scripted follow-up replies.
 * Replies are fully event-driven: the server only ever auto-replies with
 * `hello_ok`/`snapshot`/`pong`/`bye` and `follow_up_accepted`; result and
 * error frames are injected by the test through {@link FakeServer.send} so
 * the state machine is driven deterministically with no timer races.
 */
class FakeServer {
	readonly socketFile: string;
	readonly received: AttachClientMessage[] = [];
	#socket: net.Socket | null = null;
	readonly #server: net.Server;
	readonly #accumulator = new AttachFrameAccumulator();
	readonly #onFollowUp: (socket: net.Socket, message: Extract<AttachClientMessage, { kind: "follow_up" }>) => void;

	private constructor(
		socketFile: string,
		onFollowUp: (socket: net.Socket, message: Extract<AttachClientMessage, { kind: "follow_up" }>) => void,
	) {
		this.socketFile = socketFile;
		this.#onFollowUp = onFollowUp;
		this.#server = net.createServer(socket => {
			this.#socket = socket;
			socket.on("data", chunk => {
				for (const frame of this.#accumulator.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
					const message = decodeAttachLine(frame) as AttachClientMessage;
					this.received.push(message);
					this.#handle(socket, message);
				}
			});
			socket.on("error", () => {});
		});
	}

	static async listen(
		socketFile: string,
		onFollowUp: (socket: net.Socket, message: Extract<AttachClientMessage, { kind: "follow_up" }>) => void,
	): Promise<FakeServer> {
		const server = new FakeServer(socketFile, onFollowUp);
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
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#server.close(() => resolve());
		await promise;
	}

	/** Inject a server→client frame (results and errors). */
	send(message: AttachMessage): void {
		this.#socket?.write(encodeAttachMessage(message));
	}

	#handle(socket: net.Socket, message: AttachClientMessage): void {
		const send = (reply: AttachMessage): void => {
			socket.write(encodeAttachMessage(reply));
		};
		switch (message.kind) {
			case "hello":
				send({
					kind: "hello_ok",
					version: 1,
					server: { pid: process.pid, startedAt: Date.now() },
					snapshot: { version: 1, generatedAt: Date.now(), sessions: [entry({ state: "idle" })] },
				});
				return;
			case "subscribe":
				send({
					kind: "snapshot",
					snapshot: { version: 1, generatedAt: Date.now(), sessions: [entry({ state: "idle" })] },
				});
				return;
			case "follow_up":
				send({ kind: "event", event: { type: "follow_up_accepted", key: KEY, ref: message.ref } });
				this.#onFollowUp(socket, message);
				return;
			case "ping":
				send({ kind: "pong", nonce: message.nonce });
				return;
			case "bye":
				send({ kind: "bye" });
				socket.end();
				return;
			case "abort":
				return;
		}
	}
}

describe("attach pane model", () => {
	let model: AttachPaneModel;

	beforeEach(() => {
		model = new AttachPaneModel();
	});

	it("appends tool/intent/output rows from progress and suppresses empty fields", () => {
		model.appendProgress(
			progress({
				currentTool: "bash",
				currentToolArgs: "ls -la",
				lastIntent: "check the files",
				outputTail: ["out-1"],
			}),
		);
		expect(model.rows.map(row => row.text)).toEqual(["tool: bash ls -la", "intent: check the files", "out-1"]);

		// Empty and whitespace-only fields produce no rows (the rejected
		// `tool: ` / `intent: ` blank lines) and clear the header tool.
		model.appendProgress(progress({ currentTool: "", currentToolArgs: "  ", lastIntent: "   ", outputTail: [] }));
		expect(model.rows).toHaveLength(3);
		expect(model.rows.some(row => /^\s*(tool|intent):\s*$/.test(row.text))).toBe(false);
		expect(model.status.currentTool).toBeNull();

		// Omitted fields behave the same as empty ones.
		model.appendProgress(progress({ outputTail: [] }));
		expect(model.rows).toHaveLength(3);
	});

	it("merges overlapping output tails without duplicating rows", () => {
		model.appendProgress(progress({ outputTail: ["a", "b", "c"] }));
		model.appendProgress(progress({ outputTail: ["b", "c", "d"] }));
		model.appendProgress(progress({ outputTail: ["c", "d", "e"] }));
		const outputRows = model.rows.filter(row => row.kind === "output").map(row => row.text);
		expect(outputRows).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("dedupes consecutive identical tool rows across coalesced ticks", () => {
		model.appendProgress(progress({ currentTool: "bash", currentToolArgs: "ls", outputTail: [] }));
		model.appendProgress(progress({ currentTool: "bash", currentToolArgs: "ls", outputTail: [] }));
		expect(model.rows.filter(row => row.kind === "tool")).toHaveLength(1);
	});

	it("keeps state and entry updates out of the transcript", () => {
		model.appendFollowUp("continue");
		expect(model.rows).toHaveLength(1);

		model.applyEntry(entry({ state: "running", summary: "turn 1" }));
		model.setState("idle");
		model.appendProgress(progress({ outputTail: [] }));

		expect(model.rows).toHaveLength(1);
		expect(model.status.state).toBe("idle");
		expect(model.status.summary).toBe("turn 1");
	});

	it("bounds the transcript and emits the trim marker exactly once", () => {
		const bounded = new AttachPaneModel({ maxRows: 3 });
		for (let i = 0; i < 6; i += 1) bounded.appendFollowUp(`prompt-${i}`);
		// The marker is pinned at the front; content rows stay at maxRows.
		expect(bounded.rows).toHaveLength(4);
		expect(bounded.rows[0]).toEqual({ kind: "output", text: "[trimmed: earlier output dropped]" });
		expect(bounded.rows.slice(1).map(row => row.text)).toEqual(["prompt-3", "prompt-4", "prompt-5"]);
		// Still flowing, marker not repeated.
		bounded.appendFollowUp("prompt-6");
		expect(bounded.rows.filter(row => row.text.includes("[trimmed"))).toHaveLength(1);
		expect(bounded.rows.slice(1).map(row => row.text)).toEqual(["prompt-4", "prompt-5", "prompt-6"]);
	});

	it("tracks follow-up echo, queue, in-flight, and last result in the status", () => {
		model.appendFollowUp("continue");
		expect(model.rows[0]).toEqual({ kind: "followup", text: "continue" });
		model.setQueued(1);
		model.setInFlight(true);
		expect(model.status.queued).toBe(1);
		expect(model.status.inFlight).toBe(true);

		model.appendResult(result());
		expect(model.status.lastResult).toBe("[result] turn-done");
		expect(model.status.currentTool).toBeNull();
		expect(model.rows.at(-1)).toEqual({ kind: "result", text: "[result] turn-done" });
	});

	it("settleOne decrements outstanding and keeps in-flight while prompts remain", () => {
		model.setQueued(2);
		model.setInFlight(true);
		model.settleOne();
		expect(model.status.queued).toBe(1);
		expect(model.status.inFlight).toBe(true);
		model.settleOne();
		expect(model.status.queued).toBe(0);
		expect(model.status.inFlight).toBe(false);
		// Settling below zero is clamped and never re-arms in-flight.
		model.settleOne();
		expect(model.status.queued).toBe(0);
		expect(model.status.inFlight).toBe(false);
	});

	it("renders failed results as error rows and sanitizes payloads", () => {
		model.appendResult(result({ ok: false, error: "worker crashed" }));
		expect(model.rows.at(-1)).toEqual({ kind: "error", text: "[result] error: worker crashed" });

		model.appendProgress(progress({ currentTool: "bash", currentToolArgs: "ls", outputTail: [] }));
		model.appendResult(result({ ok: true, payload: "clean\x1b[31mred\x1b[0m" }));
		expect(model.rows.at(-1)!.text).toBe("[result] cleanred");
	});

	it("appends removed and bye rows", () => {
		model.appendRemoved("killed by user");
		model.appendBye();
		expect(model.rows.at(-2)).toEqual({ kind: "removed", text: "[removed] killed by user" });
		expect(model.rows.at(-1)).toEqual({ kind: "bye", text: "[bye]" });
	});
});

describe("attach pane view", () => {
	let model: AttachPaneModel;
	let ui: { requestRender: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		await initTheme();
		model = new AttachPaneModel();
		ui = { requestRender: vi.fn() };
	});

	function makeView(): AttachPaneView {
		const scroll = new ScrollView([], { height: 10, scrollbar: "auto" });
		return new AttachPaneView({ ui: ui as unknown as TUI, model, scroll });
	}

	it("routes empty progress fields to zero rows and requests renders", () => {
		const view = makeView();
		view.onProgress(progress({ currentTool: "", lastIntent: "  ", outputTail: [] }));
		view.onEntry(entry({ state: "running" }));
		view.onState("idle");
		expect(model.rows).toHaveLength(0);
		expect(model.status.state).toBe("idle");
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("renders the submit echo immediately even while a follow-up is in flight", () => {
		// A prompt queued client-side (another follow-up in flight) produces
		// no server event until it flushes; the echo must still be painted.
		const scroll = new ScrollView([], { height: 10, scrollbar: "never" });
		const view = new AttachPaneView({ ui: ui as unknown as TUI, model, scroll });
		model.setQueued(1);
		model.setInFlight(true);
		view.refresh();
		model.appendFollowUp("continue");
		model.setQueued(2);
		view.refresh();
		const lines = scroll.render(80);
		expect(lines.some(line => line.includes("> continue"))).toBe(true);
	});

	it("keeps in-flight true while prompts remain after a result settles", () => {
		const view = makeView();
		model.setQueued(2);
		model.setInFlight(true);
		view.onFollowUpAccepted("f1");
		expect(model.status.inFlight).toBe(true);

		// The transport flushes the second prompt synchronously after the
		// first result, so the slot stays busy until the count hits zero.
		view.onResult(result({ ref: "f1" }));
		expect(model.status.queued).toBe(1);
		expect(model.status.inFlight).toBe(true);
		expect(model.status.lastResult).toBe("[result] turn-done");

		view.onFollowUpAccepted("f2");
		view.onResult(result({ ref: "f2" }));
		expect(model.status.queued).toBe(0);
		expect(model.status.inFlight).toBe(false);
	});

	it("settles one outstanding on a ref-carrying error and keeps the next in flight", () => {
		const view = makeView();
		model.setQueued(2);
		model.setInFlight(true);
		view.onFollowUpAccepted("f1");

		view.onError({ kind: "error", code: "busy", message: "follow-up already in flight", ref: "f1" });
		expect(model.status.queued).toBe(1);
		expect(model.status.inFlight).toBe(true);

		view.onFollowUpAccepted("f2");
		view.onResult(result({ ref: "f2" }));
		expect(model.status.queued).toBe(0);
		expect(model.status.inFlight).toBe(false);
	});

	it("ignores ref-less errors for settlement but still renders them", () => {
		const view = makeView();
		model.setQueued(1);
		model.setInFlight(true);
		view.onError({ kind: "error", code: "shutdown", message: "server stopping" });
		expect(model.status.queued).toBe(1);
		expect(model.status.inFlight).toBe(true);
		expect(model.rows.at(-1)).toEqual({ kind: "error", text: "[error] shutdown: server stopping" });
	});

	it("appends removed rows before the terminal exit", () => {
		const view = makeView();
		view.onRemoved("killed by user");
		expect(model.rows.at(-1)).toEqual({ kind: "removed", text: "[removed] killed by user" });
		view.onBye();
		expect(model.rows.at(-1)).toEqual({ kind: "bye", text: "[bye]" });
	});
});

describe("attach pane keys", () => {
	let ui: {
		addInputListener: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		setFocus: ReturnType<typeof vi.fn>;
		showOverlay: ReturnType<typeof vi.fn>;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		terminal: { rows: number };
	};
	let listeners: Array<(data: string) => { consume?: boolean } | undefined>;
	let exits: number[];

	beforeEach(async () => {
		await initTheme();
		listeners = [];
		exits = [];
		ui = {
			addInputListener: vi.fn(listener => {
				listeners.push(listener);
				return () => {};
			}),
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			showOverlay: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			terminal: { rows: 24 },
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makePane(): AttachPane {
		const pane = new AttachPane("/tmp/attach.sock", "a".repeat(64), "w1", {
			ui: ui as unknown as TUI,
			onExit: code => {
				exits.push(code);
			},
		});
		expect(listeners).toHaveLength(1);
		return pane;
	}

	it("Ctrl-C clears a non-empty draft without exiting", () => {
		const pane = makePane();
		pane.getEditor().setText("half-typed");
		const result = listeners[0]!("\x03");
		expect(result).toEqual({ consume: true });
		expect(pane.getEditor().textEquals("")).toBe(true);
		expect(exits).toEqual([]);
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("Escape clears the draft without exiting", () => {
		const pane = makePane();
		pane.getEditor().setText("draft");
		const result = listeners[0]!("\x1b");
		expect(result).toEqual({ consume: true });
		expect(pane.getEditor().textEquals("")).toBe(true);
		expect(exits).toEqual([]);
	});

	it("Ctrl-C on an empty draft aborts, sends bye, and exits 0", () => {
		makePane();
		const result = listeners[0]!("\x03");
		expect(result).toEqual({ consume: true });
		expect(exits).toEqual([0]);
	});

	it("Escape on an empty draft is a no-op", () => {
		makePane();
		const result = listeners[0]!("\x1b");
		expect(result).toEqual({ consume: true });
		expect(exits).toEqual([]);
	});

	it("ignores unrelated keys so the editor receives them", () => {
		makePane();
		expect(listeners[0]!("x")).toBeUndefined();
		expect(listeners[0]!("enter")).toBeUndefined();
		expect(exits).toEqual([]);
	});
});

describe("attach pane follow-up status (end-to-end)", () => {
	let dir: string;
	let server: FakeServer;
	let pane: AttachPane;
	let ui: { requestRender: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		await initTheme();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-pane-e2e-"));
		ui = { requestRender: vi.fn() };
	});

	afterEach(async () => {
		pane?.stop();
		await server?.stop().catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function startPane(): Promise<AttachPane> {
		server = await FakeServer.listen(path.join(dir, "attach.sock"), () => {
			// Accepted replies are auto-sent; results/errors are injected by
			// the test through FakeServer.send so every transition is driven
			// deterministically.
		});
		const created = new AttachPane(server.socketFile, TOKEN, "w1", {
			ui: {
				...ui,
				addInputListener: vi.fn(() => () => {}),
				setFocus: vi.fn(),
				showOverlay: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
				terminal: { rows: 24 },
			} as unknown as TUI,
			pingIntervalMs: 60_000,
			onExit: () => {},
		});
		pane = created;
		await pane.start();
		return created;
	}

	function submit(text: string): void {
		pane.getEditor().setText(text);
		pane.getEditor().submit();
	}

	it("two rapid submits settle 2/in-flight → 1/in-flight → 0/idle", async () => {
		await startPane();

		submit("first");
		submit("second");

		const both = await poll(() => (pane.getStatus().queued === 2 ? pane.getStatus() : undefined));
		expect(both.inFlight).toBe(true);

		// First result settles one outstanding; the transport flushes the
		// second prompt synchronously, so the slot must stay busy.
		server.send({ kind: "event", event: result({ ref: "f1" }) });
		const middle = await poll(() => (pane.getStatus().queued === 1 ? pane.getStatus() : undefined));
		expect(middle.inFlight).toBe(true);

		// The second prompt reached the wire; settling it drains the queue.
		await poll(() => server.received.find(message => message.kind === "follow_up" && message.ref === "f2"));
		server.send({ kind: "event", event: result({ ref: "f2" }) });
		const done = await poll(() => (pane.getStatus().queued === 0 ? pane.getStatus() : undefined));
		expect(done.inFlight).toBe(false);
	});

	it("a ref-carrying error settles one outstanding and keeps the next in flight", async () => {
		await startPane();

		submit("first");
		submit("second");
		await poll(() => (pane.getStatus().queued === 2 ? pane.getStatus() : undefined));

		server.send({ kind: "error", code: "busy", message: "external client busy", ref: "f1" });
		const middle = await poll(() => (pane.getStatus().queued === 1 ? pane.getStatus() : undefined));
		expect(middle.inFlight).toBe(true);

		await poll(() => server.received.find(message => message.kind === "follow_up" && message.ref === "f2"));
		server.send({ kind: "event", event: result({ ref: "f2" }) });
		const done = await poll(() => (pane.getStatus().queued === 0 ? pane.getStatus() : undefined));
		expect(done.inFlight).toBe(false);
		expect(pane.getRows().some(row => row.kind === "error")).toBe(true);
	});
});

describe("attach pane focus (real TUI)", () => {
	let dir: string;
	let server: FakeServer;
	let pane: AttachPane;
	let ui: TUI;

	beforeEach(async () => {
		await initTheme();
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
		server = await FakeServer.listen(path.join(dir, "attach.sock"), () => {
			// Accepted replies are auto-sent; results are injected by the test.
		});
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

		// Submitting through the editor reaches the worker wire.
		focused.handleInput!("\r");
		const followUp = await poll(() => server.received.find(message => message.kind === "follow_up"));
		expect(followUp).toMatchObject({ kind: "follow_up", payload: "xy" });
	});
});
