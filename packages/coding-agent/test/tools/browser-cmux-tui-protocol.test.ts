import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserParams, BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxTuiClient, detectCmuxSocketProtocol } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/tui-client";
import { CmuxTuiTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/tui-tab";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, getTabsMapForTest, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const MACHINE_ID = `machine_${"1".repeat(32)}`;
const SESSION_ID = `session_${"2".repeat(32)}`;
const WORKSPACE_ID = `ws_${"3".repeat(32)}`;
const SCREEN_ID = `screen_${"4".repeat(32)}`;
const PANE_ID = `pane_${"5".repeat(32)}`;
const TAB_ID = `tab_${"6".repeat(32)}`;
const BROWSER_ID = `browser_${"7".repeat(32)}`;
const ATTACHMENT_LEASE = "attachment-dkt239";
const OTHER_BROWSER_ID = `browser_${"8".repeat(32)}`;
const OWNED_BROWSER_ID = `browser_${"9".repeat(32)}`;
const MISSING_BROWSER_ID = `browser_${"a".repeat(32)}`;

type ProtocolVersion = 1 | 2;

interface RequestEnvelope extends Record<string, unknown> {
	id?: unknown;
	cmd?: unknown;
	protocol?: unknown;
	type?: unknown;
	operation?: unknown;
	params?: unknown;
	idempotency_key?: unknown;
}

interface TestServer {
	socketPath: string;
	version: ProtocolVersion;
	requests: RequestEnvelope[];
	waitForOpenSocketCount(count: number): Promise<void>;
	writeResponse(socket: net.Socket, request: RequestEnvelope, result: unknown): void;
	writeStreamItem(socket: net.Socket, streamId: string, sequence: number, item: unknown): void;
	writeStreamEnd(socket: net.Socket, streamId: string, reason: string): void;
}

function readSocketLines(socket: net.Socket, handleLine: (line: string, socket: net.Socket) => void): void {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", chunk => {
		buffer += String(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) handleLine(line, socket);
		}
	});
}

async function withSocketServer(
	handle: (request: RequestEnvelope, socket: net.Socket, server: TestServer) => void,
	run: (server: TestServer) => Promise<void>,
	version: ProtocolVersion = 2,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-tui-browser-test-"));
	const socketPath = path.join(dir, "cmux.sock");
	const socketWaiters: Array<{ count: number; resolve: () => void }> = [];
	const sockets = new Set<net.Socket>();
	const requests: RequestEnvelope[] = [];
	let testServer: TestServer;
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
			for (const waiter of [...socketWaiters]) {
				if (sockets.size !== waiter.count) continue;
				socketWaiters.splice(socketWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		});
		readSocketLines(socket, (line, activeSocket) => {
			const request = JSON.parse(line) as RequestEnvelope;
			requests.push(request);
			handle(request, activeSocket, testServer);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	testServer = {
		socketPath,
		version,
		requests,
		waitForOpenSocketCount(count) {
			if (sockets.size === count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			socketWaiters.push({ count, resolve });
			return promise;
		},
		writeResponse(socket, request, result) {
			socket.write(
				`${JSON.stringify({ protocol: `cmux.protocol/${version}`, type: "response", id: request.id, ok: true, result })}\n`,
			);
		},
		writeStreamItem(socket, streamId, sequence, item) {
			socket.write(
				`${JSON.stringify({ protocol: `cmux.protocol/${version}`, type: "stream_item", stream_id: streamId, sequence: String(sequence), item })}\n`,
			);
		},
		writeStreamEnd(socket, streamId, reason) {
			socket.write(
				`${JSON.stringify({ protocol: `cmux.protocol/${version}`, type: "stream_end", stream_id: streamId, reason })}\n`,
			);
		},
	};
	try {
		await run(testServer);
	} finally {
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function rawIdentity(request: RequestEnvelope, version: ProtocolVersion = 2): Record<string, unknown> {
	return {
		id: request.id,
		ok: true,
		data: {
			app: "cmux-tui",
			version: "0.9.11",
			protocol: version === 1 ? 10 : 12,
			capabilities: ["browser-pointer-frame-guard-v1"],
			session: "dkt239",
			pid: 42,
			registry_id: "registry",
			generation: "generation",
		},
	};
}

function browserSnapshot(url = "https://example.com"): Record<string, unknown> {
	return {
		id: BROWSER_ID,
		tab_id: TAB_ID,
		url,
		title: "Example Domain",
		loading: false,
		source: "launched",
		status: "live",
		error: null,
		frames_stalled: false,
		size: { cols: 80, rows: 24 },
	};
}

function browserToolSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: {
			get: (key: string) => (key === "browser.cmux" ? true : key === "tools.maxTimeout" ? 0 : undefined),
		},
		getSessionId: () => "dkt239-browser-tool",
	} as unknown as ToolSession;
}

function handleRouteNegotiation(request: RequestEnvelope, socket: net.Socket, server: TestServer): boolean {
	if (request.operation === "machine.list") {
		server.writeResponse(socket, request, [{ id: MACHINE_ID, name: "local" }]);
		return true;
	}
	if (request.operation === "session.list") {
		server.writeResponse(socket, request, [{ id: SESSION_ID, machine_id: MACHINE_ID, name: "dkt239" }]);
		return true;
	}
	if (request.operation === "session.get") {
		server.writeResponse(socket, request, { id: SESSION_ID, machine_id: MACHINE_ID, name: "dkt239" });
		return true;
	}
	return false;
}

async function drainTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) await releaseTab(name, { kill: false }).catch(() => undefined);
}

afterEach(async () => {
	await drainTabs();
});

describe("cmux socket protocol detection", () => {
	it("detects cmux-tui with only the read-only raw identify request", async () => {
		await withSocketServer(
			(request, socket) => socket.write(`${JSON.stringify(rawIdentity(request))}\n`),
			async server => {
				const detected = await detectCmuxSocketProtocol({ socketPath: server.socketPath });
				expect(detected).toMatchObject({ kind: "tui", version: 2, raw: { protocol: 12, session: "dkt239" } });
				expect(server.requests).toHaveLength(1);
				expect(server.requests[0]).toMatchObject({ cmd: "identify" });
				expect(server.requests[0]).not.toHaveProperty("method");
				expect(server.requests[0]).not.toHaveProperty("operation");
			},
		);
	});

	it("detects installed cmux-tui raw v10 as public protocol/1 without mutation", async () => {
		await withSocketServer(
			(request, socket) => socket.write(`${JSON.stringify(rawIdentity(request, 1))}\n`),
			async server => {
				const detected = await detectCmuxSocketProtocol({ socketPath: server.socketPath });
				expect(detected).toMatchObject({ kind: "tui", version: 1, raw: { protocol: 10, session: "dkt239" } });
				expect(server.requests).toEqual([expect.objectContaining({ cmd: "identify" })]);
				expect(server.requests[0]).not.toHaveProperty("operation");
			},
			1,
		);
	});

	it("routes a GUI v2 error envelope to the unchanged GUI backend", async () => {
		await withSocketServer(
			(request, socket) => {
				socket.write(
					`${JSON.stringify({ id: request.id, ok: false, error: { code: "invalid_request", message: "missing method" } })}\n`,
				);
			},
			async server => {
				expect(await detectCmuxSocketProtocol({ socketPath: server.socketPath })).toEqual({
					kind: "gui",
					version: 2,
				});
				expect(server.requests).toEqual([expect.objectContaining({ cmd: "identify" })]);
			},
		);
	});

	it("rejects an unsupported raw protocol instead of cross-routing it to GUI", async () => {
		await withSocketServer(
			(request, socket) => {
				const response = rawIdentity(request);
				(response.data as Record<string, unknown>).protocol = 11;
				socket.write(`${JSON.stringify(response)}\n`);
			},
			async server => {
				await expect(detectCmuxSocketProtocol({ socketPath: server.socketPath })).rejects.toThrow(
					"Unsupported cmux-tui raw protocol 11",
				);
			},
		);
	});

	it("rejects cmux.protocol/1 on an explicitly typed TUI route", async () => {
		await withSocketServer(
			(request, socket) => {
				socket.write(
					`${JSON.stringify({ protocol: "cmux.protocol/1", type: "response", id: request.id, ok: true, result: [] })}\n`,
				);
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await expect(client.connect()).rejects.toThrow("non-cmux.protocol/2 envelope");
				client.close();
			},
		);
	});

	it("rejects cmux.protocol/2 on an explicitly typed protocol/1 route", async () => {
		await withSocketServer(
			(request, socket) => {
				socket.write(
					`${JSON.stringify({ protocol: "cmux.protocol/2", type: "response", id: request.id, ok: true, result: [] })}\n`,
				);
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 1 });
				await expect(client.connect()).rejects.toThrow("non-cmux.protocol/1 envelope");
				client.close();
			},
			1,
		);
	});
});

describe("cmux-tui browser resources", () => {
	it("uses raw v10/public1 recovery and connection-owned viewer semantics", async () => {
		const pointerRequests: RequestEnvelope[] = [];
		let creates = 0;
		let resolves = 0;
		let releases = 0;
		let closes = 0;
		let attachCount = 0;
		const firstFrame = Buffer.from("v1-frame").toString("base64");
		const resizedFrame = Buffer.from("v1-resized").toString("base64");
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request, 1))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					creates++;
					const params = request.params as Record<string, unknown>;
					expect(params.correlation_key).toEqual(expect.any(String));
					socket.destroy();
					return;
				}
				if (request.operation === "session.creation.resolve") {
					resolves++;
					const correlationKey = (request.params as Record<string, unknown>).correlation_key;
					server.writeResponse(socket, request, {
						correlation_key: correlationKey,
						state: "created",
						recovery: "none",
						operation: "tab.create_browser",
						created_path: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: BROWSER_ID,
						},
						generation: "g",
						revision: "1",
					});
					return;
				}
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.navigate") {
					server.writeResponse(socket, request, {
						value: browserSnapshot("https://example.com/next"),
						generation: "g",
						revision: "2",
						replayed: false,
					});
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					const afterNavigation = attachCount > 2;
					const afterResize = attachCount > 3;
					server.writeResponse(socket, request, { stream_id: streamId });
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(afterNavigation ? "https://example.com/next" : "https://example.com"),
						size: afterResize ? { width_px: 1024, height_px: 768 } : { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: afterResize
							? resizedFrame
							: afterNavigation
								? Buffer.from("v1-navigation").toString("base64")
								: firstFrame,
						width_px: afterResize ? 1024 : 800,
						height_px: afterResize ? 768 : 600,
						pointer_frame_seq: afterResize ? "8" : afterNavigation ? "9" : "7",
					});
					return;
				}
				if (request.operation === "browser.viewer.resize") {
					const params = request.params as Record<string, unknown>;
					expect(params).not.toHaveProperty("attachment_lease");
					server.writeResponse(socket, request, { accepted: true, size: { width_px: 1024, height_px: 768 } });
					return;
				}
				if (request.operation === "browser.input.mouse") {
					pointerRequests.push(request);
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "3", replayed: false });
					return;
				}
				if (request.operation === "browser.viewer.release") {
					releases++;
					expect(request.params as Record<string, unknown>).not.toHaveProperty("attachment_lease");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "tab.close") {
					expect((request.params as Record<string, unknown>).tab).toBe(TAB_ID);
					closes++;
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "4", replayed: false });
					return;
				}
				throw new Error(`Unexpected protocol/1 operation ${String(request.operation)}`);
			},
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "auto", socketPath: server.socketPath };
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				await acquireTab("v1-owned", browser, {
					url: "https://example.com",
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				const session = getTabsMapForTest().get("v1-owned");
				if (!session || !("cmuxBackend" in session) || session.cmuxBackend !== "tui") {
					throw new Error("Expected a cmux-tui tab session");
				}
				expect(await session.cmuxTab.pageScreenshot({ encoding: "base64" })).toBe(firstFrame);
				await session.cmuxTab.page.mouse.move(10, 10);
				await session.cmuxTab.page.mouse.down({ button: "left" });
				await session.cmuxTab.page.mouse.move(20, 20);
				await session.cmuxTab.page.mouse.up({ button: "left" });
				await session.cmuxTab.goto("https://example.com/next");
				await session.cmuxTab.setViewport({ width: 1024, height: 768 });
				expect(await session.cmuxTab.pageScreenshot({ encoding: "base64" })).toBe(resizedFrame);
				await releaseTab("v1-owned", { timeoutMs: 2_000 });
				await releaseBrowser(browser, { kill: false });

				expect({ creates, resolves, releases, closes, attachCount }).toEqual({
					creates: 1,
					resolves: 1,
					releases: 4,
					closes: 1,
					attachCount: 4,
				});
				expect(server.requests.some(request => request.operation === "session.creation.resolve")).toBe(true);
				expect(pointerRequests).toHaveLength(4);
				expect(
					pointerRequests.map(request => (request.params as Record<string, unknown>).pointer_frame_seq),
				).toEqual(["7", "7", "7", "7"]);
				for (const move of pointerRequests.filter(
					request => (request.params as Record<string, unknown>).kind === "move",
				)) {
					expect(move.params).not.toHaveProperty("button");
					expect(move.params).not.toHaveProperty("click_count");
				}
				expect(
					server.requests
						.filter(request => typeof request.operation === "string")
						.every(request => request.protocol === "cmux.protocol/1" && request.type === "request"),
				).toBe(true);
			},
			1,
		);
	});

	it("preserves raw-v10 ownership across fresh mounted BrowserTool calls and closes the parent tab", async () => {
		const resources = new Set([BROWSER_ID, OTHER_BROWSER_ID]);
		const attached: string[] = [];
		const viewerReleases: string[] = [];
		const closes: string[] = [];
		let creates = 0;
		let ownedTabExists = false;
		let tabCloseProbes = 0;
		await withSocketServer(
			(request, socket, server) => {
				const writeError = (code: string, message: string): void => {
					socket.write(
						`${JSON.stringify({
							protocol: "cmux.protocol/1",
							type: "response",
							id: request.id,
							ok: false,
							error: { code, message, retryable: false, details: {} },
						})}\n`,
					);
				};
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request, 1))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					creates++;
					ownedTabExists = true;
					resources.add(OWNED_BROWSER_ID);
					server.writeResponse(socket, request, {
						value: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: OWNED_BROWSER_ID,
						},
						generation: "g",
						revision: "1",
						replayed: false,
					});
					return;
				}
				if (request.operation === "tab.get") {
					tabCloseProbes++;
					expect((request.params as Record<string, unknown>).tab).toBe(TAB_ID);
					if (!ownedTabExists) {
						writeError("selector.not_found", `no tab matches ${TAB_ID}`);
						return;
					}
					server.writeResponse(socket, request, { id: TAB_ID });
					return;
				}
				if (request.operation === "browser.get") {
					const browserId = String((request.params as Record<string, unknown>).browser);
					if (!resources.has(browserId)) {
						writeError("selector.not_found", `no browser matches ${browserId}`);
						return;
					}
					server.writeResponse(socket, request, {
						...browserSnapshot(browserId === OWNED_BROWSER_ID ? "https://dwarf.dkta.dev/" : "about:blank"),
						id: browserId,
					});
					return;
				}
				if (request.operation === "browser.attach") {
					const params = request.params as Record<string, unknown>;
					const browserId = String(params.browser);
					if (!resources.has(browserId)) {
						writeError("selector.not_found", `no browser matches ${browserId}`);
						return;
					}
					attached.push(browserId);
					const streamId = String(params.stream_id);
					const snapshot = {
						...browserSnapshot(browserId === OWNED_BROWSER_ID ? "https://dwarf.dkta.dev/" : "about:blank"),
						id: browserId,
					};
					server.writeResponse(socket, request, { stream_id: streamId });
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: snapshot,
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from(`frame-${browserId}`).toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
				if (request.operation === "browser.viewer.release") {
					viewerReleases.push(String((request.params as Record<string, unknown>).browser));
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "tab.close") {
					expect((request.params as Record<string, unknown>).tab).toBe(TAB_ID);
					closes.push(OWNED_BROWSER_ID);
					ownedTabExists = false;
					resources.delete(OWNED_BROWSER_ID);
					writeError("mutation.indeterminate", "tab close took effect before its response");
					return;
				}
			},
			async server => {
				const previousSocket = process.env.CMUX_SOCKET_PATH;
				const previousFlag = process.env.PI_BROWSER_CMUX;
				process.env.CMUX_SOCKET_PATH = server.socketPath;
				delete process.env.PI_BROWSER_CMUX;
				try {
					// xd://browser constructs a fresh BrowserTool for each write while the
					// module-global tab registry owns the persisted resource lifecycle.
					const execute = (callId: string, params: BrowserParams) =>
						new BrowserTool(browserToolSession()).execute(callId, params);
					await execute("borrowed-open", {
						action: "open",
						name: "public-borrowed",
						app: { cmux: true, surface: BROWSER_ID },
						viewport: { width: 800, height: 600 },
						wait_until: "load",
						timeout: 2,
					});
					expect({ attached: attached.at(-1), creates }).toEqual({ attached: BROWSER_ID, creates: 0 });
					expect(attached).not.toContain(OTHER_BROWSER_ID);

					await execute("owned-open", {
						action: "open",
						name: "public-owned",
						url: "https://dwarf.dkta.dev/",
						viewport: { width: 800, height: 600 },
						wait_until: "load",
						timeout: 2,
					});
					expect({ creates, closes, owned: resources.has(OWNED_BROWSER_ID) }).toEqual({
						creates: 1,
						closes: [],
						owned: true,
					});
					await execute("owned-reuse", {
						action: "open",
						name: "public-owned",
						timeout: 2,
					});
					expect({ creates, closes }).toEqual({ creates: 1, closes: [] });
					await execute("owned-explicit-reuse", {
						action: "open",
						name: "public-owned",
						app: { cmux: true, surface: OWNED_BROWSER_ID },
						timeout: 2,
					});
					expect({ creates, closes }).toEqual({ creates: 1, closes: [] });
					await execute("owned-close", { action: "close", name: "public-owned", timeout: 2 });
					expect(closes).toEqual([OWNED_BROWSER_ID]);
					expect(resources.has(OWNED_BROWSER_ID)).toBe(false);
					expect(viewerReleases.filter(id => id === OWNED_BROWSER_ID)).toHaveLength(2);
					expect(tabCloseProbes).toBe(1);

					await execute("borrowed-close", { action: "close", name: "public-borrowed", timeout: 2 });
					expect(viewerReleases.filter(id => id === BROWSER_ID)).toHaveLength(1);
					expect(viewerReleases).not.toContain(OTHER_BROWSER_ID);
					expect(closes).toEqual([OWNED_BROWSER_ID]);
					expect(resources.has(BROWSER_ID)).toBe(true);
					expect(resources.has(OTHER_BROWSER_ID)).toBe(true);

					await expect(
						execute("empty-id", {
							action: "open",
							name: "public-empty-id",
							app: { cmux: true, surface: "" },
							timeout: 2,
						}),
					).rejects.toThrow("app.surface must not be empty");
					await expect(
						execute("wrong-id", {
							action: "open",
							name: "public-wrong-id",
							app: { cmux: true, surface: "browser_not-stable" },
							timeout: 2,
						}),
					).rejects.toThrow("stable cmux-tui browser ID");
					await expect(
						execute("missing-id", {
							action: "open",
							name: "public-missing-id",
							app: { cmux: true, surface: MISSING_BROWSER_ID },
							timeout: 2,
						}),
					).rejects.toThrow("selector.not_found");
					expect({ creates, closes, tabCloseProbes }).toEqual({
						creates: 1,
						closes: [OWNED_BROWSER_ID],
						tabCloseProbes: 1,
					});
				} finally {
					if (previousSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
					else process.env.CMUX_SOCKET_PATH = previousSocket;
					if (previousFlag === undefined) delete process.env.PI_BROWSER_CMUX;
					else process.env.PI_BROWSER_CMUX = previousFlag;
				}
			},
			1,
		);
	});

	it("uses stable route/resource IDs, guarded input, navigation, resize, screenshots, and clean stream cancellation", async () => {
		const pointerRequests: RequestEnvelope[] = [];
		const frames = [Buffer.from("frame-one").toString("base64"), Buffer.from("frame-two").toString("base64")];
		let attachCount = 0;
		let attachmentSocket: net.Socket | undefined;
		let attachmentStreamId: string | undefined;
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.navigate") {
					if (!attachmentSocket || !attachmentStreamId) throw new Error("missing browser attachment");
					server.writeStreamItem(attachmentSocket, attachmentStreamId, 3, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("stale-navigation-race").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "stale-navigation",
					});
					server.writeResponse(socket, request, {
						value: browserSnapshot("https://example.com/next"),
						generation: "g",
						revision: "10",
						replayed: false,
					});
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					attachmentSocket = socket;
					attachmentStreamId = String((request.params as Record<string, unknown>).stream_id);
					const afterNavigation = attachCount > 1;
					const afterResize = attachCount > 2;
					server.writeResponse(socket, request, {
						stream_id: attachmentStreamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, attachmentStreamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(afterNavigation ? "https://example.com/next" : "https://example.com"),
						size: afterResize ? { width_px: 1024, height_px: 768 } : { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, attachmentStreamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: afterResize
							? frames[1]
							: afterNavigation
								? Buffer.from("navigation-frame").toString("base64")
								: frames[0],
						width_px: afterResize ? 1024 : 800,
						height_px: afterResize ? 768 : 600,
						pointer_frame_seq: afterResize ? "8" : afterNavigation ? "9" : "7",
					});
					return;
				}
				if (request.operation === "browser.viewer.resize") {
					const params = request.params as Record<string, unknown>;
					expect(params.attachment_lease).toBe(ATTACHMENT_LEASE);
					if (!attachmentStreamId) throw new Error("missing browser attachment");
					server.writeStreamItem(socket, attachmentStreamId, 3, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("stale-resize-race").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "stale-resize",
					});
					server.writeResponse(socket, request, { accepted: true, size: { width_px: 1024, height_px: 768 } });
					expect(params).toBeDefined();
					return;
				}
				if (request.operation === "browser.input.mouse") {
					pointerRequests.push(request);
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "11", replayed: false });
					return;
				}
				if (request.operation === "browser.viewer.release") {
					expect((request.params as Record<string, unknown>).attachment_lease).toBe(ATTACHMENT_LEASE);
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				throw new Error(`Unexpected operation ${String(request.operation)}`);
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				expect(client.route).toEqual({ machineId: MACHINE_ID, sessionId: SESSION_ID });
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				expect(await tab.readyInfo()).toMatchObject({ url: "https://example.com", title: "Example Domain" });
				expect(await tab.pageScreenshot({ encoding: "base64" })).toBe(frames[0]);
				await tab.page.mouse.move(10, 10);
				await tab.page.mouse.down({ button: "left" });
				await tab.page.mouse.move(20, 20);
				await tab.page.mouse.up({ button: "left" });
				await tab.page.mouse.click(20, 30);
				await tab.goto("https://example.com/next");
				expect(tab.url()).toBe("https://example.com/next");
				expect(await tab.pageScreenshot({ encoding: "base64" })).toBe(
					Buffer.from("navigation-frame").toString("base64"),
				);
				await tab.page.mouse.click(30, 35);
				await tab.setViewport({ width: 1024, height: 768 });
				expect(await tab.pageScreenshot({ encoding: "base64" })).toBe(frames[1]);
				await tab.page.mouse.click(40, 50);
				await tab.closeAttachment();
				client.close();
				expect(
					pointerRequests.map(request => (request.params as Record<string, unknown>).pointer_frame_seq),
				).toEqual(["7", "7", "7", "7", "7", "7", "9", "9", "8", "8"]);
				expect(attachCount).toBe(3);
				for (const move of pointerRequests.filter(
					request => (request.params as Record<string, unknown>).kind === "move",
				)) {
					expect(move.params).not.toHaveProperty("button");
					expect(move.params).not.toHaveProperty("click_count");
				}
				const mutations = server.requests.filter(request => request.operation === "browser.input.mouse");
				expect(mutations.every(request => typeof request.idempotency_key === "string")).toBe(true);
				expect(
					server.requests
						.filter(request => typeof request.operation === "string")
						.every(request => request.protocol === "cmux.protocol/2" && request.type === "request"),
				).toBe(true);
			},
		);
	});

	it("completes URL, navigation, and resize contracts when frames are stalled", async () => {
		let browserReads = 0;
		let attachCount = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					browserReads++;
					server.writeResponse(socket, request, {
						...browserSnapshot(browserReads >= 3 ? "https://example.com/next" : "https://example.com"),
						frames_stalled: true,
					});
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, { stream_id: streamId, attachment_lease: ATTACHMENT_LEASE });
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: { ...browserSnapshot("https://example.com"), frames_stalled: true },
						size: { width_px: 800, height_px: 600 },
					});
					if (attachCount === 1) {
						server.writeStreamItem(socket, streamId, 2, {
							kind: "frame",
							mime_type: "image/png",
							data_base64: Buffer.from("initial-frame").toString("base64"),
							width_px: 800,
							height_px: 600,
							pointer_frame_seq: "1",
						});
					}
					return;
				}
				if (request.operation === "browser.navigate") {
					server.writeResponse(socket, request, {
						value: { ...browserSnapshot("https://example.com/final"), frames_stalled: true },
						generation: "g",
						revision: "20",
						replayed: false,
					});
					return;
				}
				if (request.operation === "browser.viewer.resize") {
					server.writeResponse(socket, request, { accepted: true, size: { width_px: 1024, height_px: 768 } });
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				await tab.readyInfo({ width: 800, height: 600 }, { timeoutMs: 2_000 });
				await expect(tab.waitForUrl("example.com", { timeout: 2_000 })).resolves.toBe("https://example.com");
				expect(attachCount).toBe(1);
				await expect(tab.waitForNavigation({ timeout: 2_000 })).resolves.toBeNull();
				expect(attachCount).toBe(1);
				await expect(tab.goto("https://example.com/final", { timeoutMs: 2_000 })).resolves.toBeUndefined();
				expect(attachCount).toBe(2);
				await expect(tab.setViewport({ width: 1024, height: 768 })).resolves.toBeUndefined();
				expect(attachCount).toBe(3);
				client.close();
			},
		);
	});

	it("bounds navigation polling by one deadline", async () => {
		let browserReads = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					browserReads++;
					if (browserReads === 1) server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.attach") {
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("initial").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
				if (request.operation === "browser.navigate") {
					server.writeResponse(socket, request, {
						value: { ...browserSnapshot("https://example.com/slow"), loading: true },
						generation: "g",
						revision: "2",
						replayed: false,
					});
					const attach = server.requests.find(candidate => candidate.operation === "browser.attach");
					if (!attach) throw new Error("missing browser.attach request");
					server.writeStreamItem(socket, String((attach.params as Record<string, unknown>).stream_id), 3, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("slow-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "2",
					});
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				await tab.readyInfo({ width: 800, height: 600 }, { timeoutMs: 2_000 });
				await expect(tab.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60 })).rejects.toThrow(
					/supports waitUntil "load"/,
				);
				expect(browserReads).toBe(1);
				const started = Date.now();
				await expect(tab.goto("https://example.com/slow", { timeoutMs: 60 })).rejects.toThrow(
					/Timed out|timed out/,
				);
				expect(Date.now() - started).toBeLessThan(500);
				expect(browserReads).toBe(2);
				const waitStarted = Date.now();
				await expect(tab.waitForUrl("never", { timeout: 60 })).rejects.toThrow(/Timed out|timed out/);
				expect(Date.now() - waitStarted).toBeLessThan(500);
				expect(browserReads).toBe(3);
				await tab.closeAttachment();
				client.close();
			},
		);
	});

	it("reconnects a dropped read on the same stable route", async () => {
		let browserReads = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					browserReads++;
					if (browserReads === 1) socket.destroy();
					else server.writeResponse(socket, request, browserSnapshot());
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });

				await client.connect();
				const result = await client.request<Record<string, unknown>>("browser.get", {
					machine: MACHINE_ID,
					session: SESSION_ID,
					browser: BROWSER_ID,
				});
				expect(result.id).toBe(BROWSER_ID);
				expect(browserReads).toBe(2);
				expect(server.requests.filter(request => request.operation === "machine.list")).toHaveLength(2);
				client.close();
			},
		);
	});

	it("bounds reconnect negotiation by the original request deadline", async () => {
		let machineLists = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (request.operation === "machine.list") {
					machineLists++;
					if (machineLists === 1) server.writeResponse(socket, request, [{ id: MACHINE_ID }]);
					return;
				}
				if (request.operation === "session.list") {
					server.writeResponse(socket, request, [{ id: SESSION_ID }]);
					return;
				}
				if (request.operation === "browser.get") {
					socket.destroy();
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const started = Date.now();
				await expect(
					client.request(
						"browser.get",
						{ machine: MACHINE_ID, session: SESSION_ID, browser: BROWSER_ID },
						{ timeoutMs: 80 },
					),
				).rejects.toThrow(/Timed out|timed out/);
				expect(Date.now() - started).toBeLessThan(500);
				expect(machineLists).toBe(2);
				client.close();
			},
		);
	});

	it("aborts one tab mutation without failing another request on the shared connection", async () => {
		const controller = new AbortController();
		const firstWritten = Promise.withResolvers<void>();
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.input.text") {
					const text = (request.params as Record<string, unknown>).text;
					if (text === "cancel-me") {
						firstWritten.resolve();
						return;
					}
					if (text === "survive") {
						const canceled = server.requests.find(
							candidate =>
								candidate.operation === "browser.input.text" &&
								(candidate.params as Record<string, unknown>).text === "cancel-me",
						);
						if (!canceled) throw new Error("missing canceled request");
						controller.abort(new ToolError("cancel only tab A"));
						server.writeResponse(socket, canceled, { value: "late-a" });
						server.writeResponse(socket, request, { value: "tab-b" });
						return;
					}
				}
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const canceled = client.request(
					"browser.input.text",
					{ machine: MACHINE_ID, session: SESSION_ID, browser: BROWSER_ID, text: "cancel-me" },
					{ mutation: true, signal: controller.signal, timeoutMs: 2_000 },
				);
				await firstWritten.promise;
				const survivor = client.request<{ value: string }>(
					"browser.input.text",
					{ machine: MACHINE_ID, session: SESSION_ID, browser: BROWSER_ID, text: "survive" },
					{ mutation: true, timeoutMs: 2_000 },
				);
				await expect(canceled).rejects.toThrow("cancel only tab A");
				await expect(survivor).resolves.toEqual({ value: "tab-b" });
				await expect(
					client.request("browser.get", {
						machine: MACHINE_ID,
						session: SESSION_ID,
						browser: BROWSER_ID,
					}),
				).resolves.toMatchObject({ id: BROWSER_ID });
				client.close();
			},
		);
	});

	it("reattaches after a stream gap and never reuses the stale frame", async () => {
		let attachCount = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: `${ATTACHMENT_LEASE}-${attachCount}`,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from(attachCount === 1 ? "stale" : "recovered").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: String(attachCount),
					});
					if (attachCount === 1) server.writeStreamEnd(socket, streamId, "gap");
					return;
				}
				if (request.operation === "browser.viewer.release") {
					expect((request.params as Record<string, unknown>).attachment_lease).toBe(`${ATTACHMENT_LEASE}-2`);
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				const frame = await tab.pageScreenshot({ encoding: "base64" });
				expect(frame).toBe(Buffer.from("recovered").toString("base64"));
				expect(attachCount).toBe(2);
				await server.waitForOpenSocketCount(2);
				await tab.closeAttachment();
				client.close();
			},
		);
	});

	it("reattaches when the attachment socket drops before its response", async () => {
		let attachCount = 0;
		const freshFrame = Buffer.from("fresh-after-disconnect").toString("base64");
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation !== "browser.attach") return;
				attachCount++;
				if (attachCount === 1) {
					socket.destroy();
					return;
				}
				const streamId = String((request.params as Record<string, unknown>).stream_id);
				server.writeResponse(socket, request, {
					stream_id: streamId,
					attachment_lease: ATTACHMENT_LEASE,
				});
				server.writeStreamItem(socket, streamId, 1, {
					kind: "snapshot",
					browser: browserSnapshot(),
					size: { width_px: 800, height_px: 600 },
				});
				server.writeStreamItem(socket, streamId, 2, {
					kind: "frame",
					mime_type: "image/png",
					data_base64: freshFrame,
					width_px: 800,
					height_px: 600,
					pointer_frame_seq: "1",
				});
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				await expect(tab.readyInfo({ width: 800, height: 600 }, { timeoutMs: 2_000 })).resolves.toMatchObject({
					url: "https://example.com",
				});
				await expect(tab.page.screenshot({ encoding: "base64" })).resolves.toBe(freshFrame);
				expect(attachCount).toBe(2);
				await tab.closeAttachment();
				client.close();
			},
		);
	});

	it("reattaches when an attach response and recoverable gap arrive in the same read", async () => {
		let attachCount = 0;
		const freshFrame = Buffer.from("fresh-after-gap").toString("base64");
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation !== "browser.attach") return;
				attachCount++;
				const streamId = String((request.params as Record<string, unknown>).stream_id);
				if (attachCount === 1) {
					socket.write(
						`${JSON.stringify({
							protocol: "cmux.protocol/2",
							type: "response",
							id: request.id,
							ok: true,
							result: { stream_id: streamId, attachment_lease: ATTACHMENT_LEASE },
						})}\n${JSON.stringify({
							protocol: "cmux.protocol/2",
							type: "stream_end",
							stream_id: streamId,
							reason: "gap",
						})}\n`,
					);
					return;
				}
				server.writeResponse(socket, request, {
					stream_id: streamId,
					attachment_lease: ATTACHMENT_LEASE,
				});
				server.writeStreamItem(socket, streamId, 1, {
					kind: "snapshot",
					browser: browserSnapshot(),
					size: { width_px: 800, height_px: 600 },
				});
				server.writeStreamItem(socket, streamId, 2, {
					kind: "frame",
					mime_type: "image/png",
					data_base64: freshFrame,
					width_px: 800,
					height_px: 600,
					pointer_frame_seq: "1",
				});
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				await expect(tab.readyInfo({ width: 800, height: 600 }, { timeoutMs: 2_000 })).resolves.toMatchObject({
					url: "https://example.com",
				});
				await expect(tab.page.screenshot({ encoding: "base64" })).resolves.toBe(freshFrame);
				expect(attachCount).toBe(2);
				await tab.closeAttachment();
				client.close();
			},
		);
	});

	it("fails promptly on malformed recognized browser stream items", async () => {
		await withSocketServer(
			(request, socket, server) => {
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.attach") {
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
			},
			async server => {
				const client = new CmuxTuiClient({ socketPath: server.socketPath, version: 2 });
				await client.connect();
				const tab = new CmuxTuiTab({ client, browserId: BROWSER_ID, viewport: { width: 800, height: 600 } });
				await expect(tab.readyInfo({ width: 800, height: 600 }, { timeoutMs: 2_000 })).rejects.toThrow(
					"stream ended",
				);
				client.close();
			},
		);
	});

	it("treats a closed browser stream as terminal instead of reattaching a stale handle", async () => {
		let attachCount = 0;
		let attachmentSocket: net.Socket | undefined;
		let attachmentStreamId: string | undefined;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					attachmentSocket = socket;
					attachmentStreamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: attachmentStreamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, attachmentStreamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, attachmentStreamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("last-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
			},
			async server => {
				const kind: CmuxKind = {
					kind: "cmux",
					backend: "tui",
					socketPath: server.socketPath,
					surface: BROWSER_ID,
				};
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				const acquired = await acquireTab("closed-stream", browser, {
					cmuxSurface: BROWSER_ID,
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				if (acquired.tab.backend !== "cmux" || acquired.tab.cmuxBackend !== "tui") {
					throw new Error("expected cmux-tui tab");
				}
				const tab = acquired.tab.cmuxTab;
				if (!attachmentSocket || !attachmentStreamId) throw new Error("missing browser attachment");
				server.writeStreamEnd(attachmentSocket, attachmentStreamId, "closed");
				await Bun.sleep(10);
				await expect(tab.pageScreenshot({ encoding: "base64" })).rejects.toThrow("resource is closed");
				expect(acquired.tab.state).toBe("dead");
				expect(attachCount).toBe(1);
				await releaseTab("closed-stream", { timeoutMs: 2_000 });
			},
		);
	});

	it("does not reuse a same-name tab after its browser resource disappears", async () => {
		let gone = false;
		let browserReads = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "browser.get") {
					browserReads++;
					if (gone) {
						socket.write(
							`${JSON.stringify({
								protocol: "cmux.protocol/2",
								type: "response",
								id: request.id,
								ok: false,
								error: {
									code: "selector.not_found",
									message: "browser resource is gone",
									retryable: false,
									details: { selector: BROWSER_ID },
								},
							})}\n`,
						);
					} else {
						server.writeResponse(socket, request, browserSnapshot());
					}
					return;
				}
				if (request.operation === "browser.attach") {
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, { stream_id: streamId, attachment_lease: ATTACHMENT_LEASE });
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("live-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
			},
			async server => {
				const kind: CmuxKind = {
					kind: "cmux",
					backend: "tui",
					socketPath: server.socketPath,
					surface: BROWSER_ID,
				};
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				await acquireTab("stale-selector", browser, {
					cmuxSurface: BROWSER_ID,
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				gone = true;
				await expect(
					acquireTab("stale-selector", browser, {
						cmuxSurface: BROWSER_ID,
						timeoutMs: 2_000,
						viewport: { width: 800, height: 600 },
					}),
				).rejects.toThrow("selector.not_found");
				expect(browserReads).toBeGreaterThanOrEqual(3);
				expect(getTabsMapForTest().has("stale-selector")).toBe(false);
				await releaseBrowser(browser, { kill: false });
			},
		);
	});

	it("publishes a newly created URL only after load and an initial frame", async () => {
		let creates = 0;
		let browserReads = 0;
		let attachCount = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					creates++;
					server.writeResponse(socket, request, {
						value: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: BROWSER_ID,
						},
						generation: "g",
						revision: "1",
						replayed: false,
					});
					return;
				}
				if (request.operation === "browser.get") {
					browserReads++;
					server.writeResponse(socket, request, {
						...browserSnapshot("https://example.com/created"),
						loading: browserReads === 1,
					});
					return;
				}
				if (request.operation === "browser.attach") {
					attachCount++;
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: { ...browserSnapshot("https://example.com/created"), loading: attachCount === 1 },
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from(attachCount === 1 ? "loading-frame" : "created-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					if (attachCount === 1) {
						server.writeStreamItem(socket, streamId, 3, {
							kind: "state",
							url: "https://example.com/created",
							title: "Example Domain",
							loading: false,
						});
					}
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "browser.close") {
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "2", replayed: false });
					return;
				}
			},
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "tui", socketPath: server.socketPath };
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				const acquired = await acquireTab("created-url", browser, {
					url: "https://example.com/created",
					waitUntil: "load",
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				expect(acquired.tab.state).toBe("alive");
				expect(acquired.tab.info.url).toBe("https://example.com/created");
				expect(browserReads).toBeGreaterThanOrEqual(2);
				expect(server.requests.some(request => request.operation === "browser.navigate")).toBe(false);
				if (acquired.tab.backend !== "cmux" || acquired.tab.cmuxBackend !== "tui") {
					throw new Error("expected cmux-tui tab");
				}
				expect(await acquired.tab.cmuxTab.pageScreenshot({ encoding: "base64" })).toBe(
					Buffer.from("created-frame").toString("base64"),
				);
				expect(attachCount).toBe(2);
				await releaseTab("created-url", { timeoutMs: 2_000 });

				const unsupportedBrowser = await acquireBrowser(kind, { cwd: "/tmp" });
				await expect(
					acquireTab("unsupported-wait", unsupportedBrowser, {
						url: "https://example.com",
						waitUntil: "domcontentloaded",
						timeoutMs: 2_000,
					}),
				).rejects.toThrow('supports wait_until "load"');

				const abortedBrowser = await acquireBrowser(kind, { cwd: "/tmp" });
				const controller = new AbortController();
				controller.abort(new ToolError("operator canceled browser open"));
				await expect(
					acquireTab("aborted-open", abortedBrowser, {
						url: "https://example.com",
						timeoutMs: 2_000,
						signal: controller.signal,
					}),
				).rejects.toThrow("Browser tab open aborted");
				expect(creates).toBe(1);
				await releaseBrowser(abortedBrowser, { kill: false });
				expect(creates).toBe(1);
				await releaseBrowser(unsupportedBrowser, { kill: false });
			},
		);
	});

	it("resolves an abort-after-write before closing an owned browser", async () => {
		const controller = new AbortController();
		let creates = 0;
		let resolves = 0;
		let closes = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					creates++;
					controller.abort(new ToolError("operator canceled after create write"));
					return;
				}
				if (request.operation === "session.creation.resolve") {
					resolves++;
					const correlationKey = (request.params as Record<string, unknown>).correlation_key;
					server.writeResponse(socket, request, {
						correlation_key: correlationKey,
						state: "created",
						recovery: "none",
						operation: "tab.create_browser",
						created_path: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: BROWSER_ID,
						},
						generation: "g",
						revision: "1",
					});
					return;
				}
				if (request.operation === "browser.close") {
					closes++;
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "2", replayed: false });
					return;
				}
			},
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "tui", socketPath: server.socketPath };
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				await expect(
					acquireTab("abort-after-write", browser, {
						url: "https://example.com",
						timeoutMs: 2_000,
						signal: controller.signal,
					}),
				).rejects.toThrow("operator canceled after create write");
				expect({ creates, resolves, closes }).toEqual({ creates: 1, resolves: 1, closes: 1 });
				expect(getTabsMapForTest().has("abort-after-write")).toBe(false);
				await releaseBrowser(browser, { kill: false });
			},
		);
	});

	it("reconciles production-shaped raw-v10 viewer and transport-close ambiguity", async () => {
		for (const firstCloseOutcome of ["absent", "present"] as const) {
			let viewerReleases = 0;
			let closeAttempts = 0;
			let closeProbes = 0;
			let tabExists = true;
			await withSocketServer(
				(request, socket, server) => {
					const writeError = (code: string, message: string): void => {
						socket.write(
							`${JSON.stringify({
								protocol: "cmux.protocol/1",
								type: "response",
								id: request.id,
								ok: false,
								error: { code, message, retryable: false, details: {} },
							})}\n`,
						);
					};
					if (request.cmd === "identify") {
						socket.write(`${JSON.stringify(rawIdentity(request, 1))}\n`);
						return;
					}
					if (handleRouteNegotiation(request, socket, server)) return;
					if (request.operation === "tab.create_browser") {
						server.writeResponse(socket, request, {
							value: {
								kind: "browser",
								workspace_id: WORKSPACE_ID,
								screen_id: SCREEN_ID,
								pane_id: PANE_ID,
								tab_id: TAB_ID,
								browser_id: BROWSER_ID,
							},
							generation: "g",
							revision: "1",
							replayed: false,
						});
						return;
					}
					if (request.operation === "browser.get") {
						server.writeResponse(socket, request, browserSnapshot("https://dwarf.dkta.dev/"));
						return;
					}
					if (request.operation === "tab.get") {
						closeProbes++;
						if (!tabExists) {
							writeError("selector.not_found", "owned parent tab is absent");
							return;
						}
						server.writeResponse(socket, request, { id: TAB_ID });
						return;
					}
					if (request.operation === "browser.attach") {
						const streamId = String((request.params as Record<string, unknown>).stream_id);
						server.writeResponse(socket, request, { stream_id: streamId });
						server.writeStreamItem(socket, streamId, 1, {
							kind: "snapshot",
							browser: browserSnapshot("https://dwarf.dkta.dev/"),
							size: { width_px: 750, height_px: 528 },
						});
						server.writeStreamItem(socket, streamId, 2, {
							kind: "frame",
							mime_type: "image/png",
							data_base64: Buffer.from("production-close-frame").toString("base64"),
							width_px: 750,
							height_px: 528,
							pointer_frame_seq: "1",
						});
						return;
					}
					if (request.operation === "browser.viewer.release") {
						viewerReleases++;
						if (viewerReleases === 1) server.writeResponse(socket, request, {});
						else writeError("mutation.indeterminate", "viewer release outcome was not recorded");
						return;
					}
					if (request.operation === "stream.cancel") {
						const streamId = String((request.params as Record<string, unknown>).stream);
						server.writeStreamEnd(socket, streamId, "canceled");
						server.writeResponse(socket, request, {});
						return;
					}
					if (request.operation === "tab.close") {
						expect((request.params as Record<string, unknown>).tab).toBe(TAB_ID);
						closeAttempts++;
						if (closeAttempts === 1) {
							tabExists = firstCloseOutcome === "present";
							socket.destroy();
							return;
						}
						tabExists = false;
						server.writeResponse(socket, request, {
							value: {},
							generation: "g",
							revision: "2",
							replayed: false,
						});
					}
				},
				async server => {
					const kind: CmuxKind = { kind: "cmux", backend: "auto", socketPath: server.socketPath };
					const browser = await acquireBrowser(kind, { cwd: "/tmp" });
					const name = `production-shaped-close-${firstCloseOutcome}`;
					await acquireTab(name, browser, {
						url: "https://dwarf.dkta.dev/",
						timeoutMs: 2_000,
						viewport: { width: 750, height: 528 },
					});
					await expect(releaseTab(name, { timeoutMs: 2_000 })).resolves.toBe(true);
					expect({ viewerReleases, closeAttempts, closeProbes, tabExists }).toEqual({
						viewerReleases: 2,
						closeAttempts: firstCloseOutcome === "present" ? 2 : 1,
						closeProbes: 1,
						tabExists: false,
					});
					const verifier = new CmuxTuiClient({ socketPath: server.socketPath, version: 1 });
					try {
						await expect(
							verifier.request(
								"tab.get",
								{ machine: MACHINE_ID, session: SESSION_ID, tab: TAB_ID },
								{ timeoutMs: 2_000 },
							),
						).rejects.toMatchObject({ code: "selector.not_found" });
					} finally {
						verifier.close();
					}
					await releaseBrowser(browser, { kill: false });
				},
				1,
			);
		}
	});

	it("accepts already-absent and reconciled indeterminate owned closes without retrying", async () => {
		let closes = 0;
		let closeProbes = 0;
		let closed = false;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					closed = false;
					server.writeResponse(socket, request, {
						value: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: BROWSER_ID,
						},
						generation: "g",
						revision: "1",
						replayed: false,
					});
					return;
				}
				if (request.operation === "browser.get") {
					if (closed) {
						closeProbes++;
						socket.write(
							`${JSON.stringify({
								protocol: "cmux.protocol/2",
								type: "response",
								id: request.id,
								ok: false,
								error: {
									code: "selector.not_found",
									message: "browser close took effect",
									retryable: false,
									details: {},
								},
							})}\n`,
						);
					} else {
						server.writeResponse(socket, request, browserSnapshot());
					}
					return;
				}
				if (request.operation === "browser.attach") {
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("close-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
				if (request.operation === "browser.viewer.release") {
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "browser.close") {
					closes++;
					closed = true;
					socket.write(
						`${JSON.stringify({
							protocol: "cmux.protocol/2",
							type: "response",
							id: request.id,
							ok: false,
							error: {
								code: closes === 1 ? "mutation.indeterminate" : "selector.not_found",
								message: closes === 1 ? "the external effect may have run" : "browser is already absent",
								retryable: false,
								details: {},
							},
						})}\n`,
					);
				}
			},
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "tui", socketPath: server.socketPath };
				const browser = await acquireBrowser(kind, { cwd: "/tmp" });
				await acquireTab("owned-indeterminate-close", browser, {
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				await expect(releaseTab("owned-indeterminate-close", { timeoutMs: 2_000 })).resolves.toBe(true);
				expect({ closes, closeProbes }).toEqual({ closes: 1, closeProbes: 1 });
				await releaseBrowser(browser, { kill: false });
				const alreadyAbsentBrowser = await acquireBrowser(kind, { cwd: "/tmp" });
				await acquireTab("owned-already-absent-close", alreadyAbsentBrowser, {
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				await expect(releaseTab("owned-already-absent-close", { timeoutMs: 2_000 })).resolves.toBe(true);
				expect({ closes, closeProbes }).toEqual({ closes: 2, closeProbes: 1 });
				await releaseBrowser(alreadyAbsentBrowser, { kill: false });
			},
		);
	});

	it("recovers uncertain creation and closes only browser resources created by OMP", async () => {
		let creates = 0;
		let resolves = 0;
		let closes = 0;
		let releases = 0;
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				if (handleRouteNegotiation(request, socket, server)) return;
				if (request.operation === "tab.create_browser") {
					creates++;
					socket.write(
						`${JSON.stringify({
							protocol: "cmux.protocol/2",
							type: "response",
							id: request.id,
							ok: false,
							error: {
								code: "mutation.indeterminate",
								message: "creation outcome requires resolution",
								retryable: false,
								details: {},
							},
						})}\n`,
					);
					return;
				}
				if (request.operation === "session.creation.resolve") {
					resolves++;
					if (resolves === 1) {
						socket.write(
							`${JSON.stringify({
								protocol: "cmux.protocol/2",
								type: "response",
								id: request.id,
								ok: false,
								error: {
									code: "operation.failed",
									message: "resolution temporarily unavailable",
									retryable: true,
									details: {},
								},
							})}\n`,
						);
						return;
					}
					if (resolves === 2) {
						socket.destroy();
						return;
					}
					const correlationKey = (request.params as Record<string, unknown>).correlation_key;
					server.writeResponse(socket, request, {
						correlation_key: correlationKey,
						state: "created",
						recovery: "none",
						operation: "tab.create_browser",
						idempotency_key: server.requests.find(candidate => candidate.operation === "tab.create_browser")
							?.idempotency_key,
						created_path: {
							kind: "browser",
							workspace_id: WORKSPACE_ID,
							screen_id: SCREEN_ID,
							pane_id: PANE_ID,
							tab_id: TAB_ID,
							browser_id: BROWSER_ID,
						},
						generation: "g",
						revision: "20",
					});
					return;
				}
				if (request.operation === "browser.get") {
					server.writeResponse(socket, request, browserSnapshot());
					return;
				}
				if (request.operation === "browser.attach") {
					const streamId = String((request.params as Record<string, unknown>).stream_id);
					server.writeResponse(socket, request, {
						stream_id: streamId,
						attachment_lease: ATTACHMENT_LEASE,
					});
					server.writeStreamItem(socket, streamId, 1, {
						kind: "snapshot",
						browser: browserSnapshot(),
						size: { width_px: 800, height_px: 600 },
					});
					server.writeStreamItem(socket, streamId, 2, {
						kind: "frame",
						mime_type: "image/png",
						data_base64: Buffer.from("owned-frame").toString("base64"),
						width_px: 800,
						height_px: 600,
						pointer_frame_seq: "1",
					});
					return;
				}
				if (request.operation === "browser.viewer.release") {
					releases++;
					expect((request.params as Record<string, unknown>).attachment_lease).toBe(ATTACHMENT_LEASE);
					if (releases === 1) {
						socket.write(
							`${JSON.stringify({
								protocol: "cmux.protocol/2",
								type: "response",
								id: request.id,
								ok: false,
								error: {
									code: "operation.failed",
									message: "viewer release failed",
									retryable: false,
									details: {},
								},
							})}\n`,
						);
					} else {
						server.writeResponse(socket, request, {});
					}
					return;
				}
				if (request.operation === "stream.cancel") {
					const streamId = String((request.params as Record<string, unknown>).stream);
					server.writeStreamEnd(socket, streamId, "canceled");
					server.writeResponse(socket, request, {});
					return;
				}
				if (request.operation === "browser.close") {
					closes++;
					server.writeResponse(socket, request, { value: {}, generation: "g", revision: "21", replayed: false });
					return;
				}
			},
			async server => {
				const ownedKind: CmuxKind = { kind: "cmux", backend: "tui", socketPath: server.socketPath };
				const ownedBrowser = await acquireBrowser(ownedKind, { cwd: "/tmp" });
				await acquireTab("owned-tui", ownedBrowser, { timeoutMs: 2_000, viewport: { width: 800, height: 600 } });
				await expect(releaseTab("owned-tui", { timeoutMs: 2_000 })).resolves.toBe(true);
				expect({ creates, resolves, releases, closes }).toEqual({
					creates: 1,
					resolves: 3,
					releases: 1,
					closes: 1,
				});
				const createRequest = server.requests.find(request => request.operation === "tab.create_browser");
				const resolveRequest = server.requests.find(request => request.operation === "session.creation.resolve");
				if (!createRequest || !resolveRequest) throw new Error("Expected creation and resolution requests");
				expect(createRequest.idempotency_key).toEqual(expect.any(String));
				const createParams = createRequest.params as Record<string, unknown>;
				const resolveParams = resolveRequest.params as Record<string, unknown>;
				expect(createParams.correlation_key).toEqual(expect.any(String));
				expect(resolveParams.correlation_key).toBe(createParams.correlation_key);

				const borrowedKind: CmuxKind = {
					kind: "cmux",
					backend: "tui",
					socketPath: server.socketPath,
					surface: BROWSER_ID,
				};
				const borrowedBrowser = await acquireBrowser(borrowedKind, { cwd: "/tmp" });
				await acquireTab("borrowed-tui", borrowedBrowser, {
					cmuxSurface: BROWSER_ID,
					timeoutMs: 2_000,
					viewport: { width: 800, height: 600 },
				});
				await releaseTab("borrowed-tui", { timeoutMs: 2_000 });
				expect({ creates, resolves, releases, closes }).toEqual({
					creates: 1,
					resolves: 3,
					releases: 2,
					closes: 1,
				});
			},
		);
	});
});

describe("cmux backend registry routing", () => {
	it("keeps GUI sockets on CmuxSocketClient and TUI sockets on CmuxTuiClient", async () => {
		await withSocketServer(
			(request, socket, server) => {
				if (request.cmd === "identify") {
					socket.write(`${JSON.stringify(rawIdentity(request))}\n`);
					return;
				}
				handleRouteNegotiation(request, socket, server);
			},
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "auto", socketPath: server.socketPath };
				const handle = await acquireBrowser(kind, { cwd: "/tmp" });
				expect("backend" in handle && handle.backend).toBe("tui");
				expect("client" in handle && handle.client).toBeInstanceOf(CmuxTuiClient);
				await releaseBrowser(handle, { kill: false });
				expect(server.requests.some(request => request.method !== undefined)).toBe(false);
			},
		);
	});

	it("fails closed when CMUX_SOCKET_PATH is neither supported protocol", async () => {
		await withSocketServer(
			(_request, socket) => socket.write(`${JSON.stringify({ ok: false, error: "bad request" })}\n`),
			async server => {
				const kind: CmuxKind = { kind: "cmux", backend: "auto", socketPath: server.socketPath };
				await expect(acquireBrowser(kind, { cwd: "/tmp" })).rejects.toBeInstanceOf(ToolError);
			},
		);
	});
});
