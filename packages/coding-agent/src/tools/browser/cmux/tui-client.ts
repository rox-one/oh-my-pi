import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { ToolError } from "../../tool-errors";

// Small browser-only wire subsets of cmux-sdk's public resource transports.
// Raw identify selects one version before any resource operation; connections
// then accept exactly that version's envelopes and semantics.
const PROTOCOLS = {
	1: "cmux.protocol/1",
	2: "cmux.protocol/2",
} as const;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type CmuxTuiProtocolVersion = keyof typeof PROTOCOLS;

export type CmuxSocketProtocol =
	| { kind: "gui"; version: 2 }
	| { kind: "tui"; version: 1; raw: CmuxTuiRawIdentityV1 }
	| { kind: "tui"; version: 2; raw: CmuxTuiRawIdentityV2 };

interface CmuxTuiRawIdentityBase {
	app: "cmux-tui";
	version: string;
	capabilities: string[];
	session: string;
	pid: number;
	registry_id?: string;
	generation?: string;
}

export interface CmuxTuiRawIdentityV1 extends CmuxTuiRawIdentityBase {
	protocol: 10;
}

export interface CmuxTuiRawIdentityV2 extends CmuxTuiRawIdentityBase {
	protocol: 12;
}

export type CmuxTuiRawIdentity = CmuxTuiRawIdentityV1 | CmuxTuiRawIdentityV2;

export interface CmuxTuiRoute {
	machineId: string;
	sessionId: string;
}

export interface CmuxTuiBrowserSnapshot {
	id: string;
	tab_id: string;
	url: string;
	title: string;
	loading: boolean;
	source: "external" | "launched";
	status: "starting" | "live" | "failed";
	error: string | null;
	frames_stalled: boolean;
	size: { cols: number; rows: number };
}

export interface CmuxTuiCreatedBrowserPath {
	kind: "browser";
	workspace_id: string;
	screen_id: string;
	pane_id: string;
	tab_id: string;
	browser_id: string;
}

export interface CmuxTuiMutationResult<T> {
	value: T;
	generation: string;
	revision: string;
	replayed: boolean;
}

export type CmuxTuiBrowserAttachItem =
	| {
			kind: "snapshot";
			browser: CmuxTuiBrowserSnapshot;
			size: { width_px: number; height_px: number };
	  }
	| {
			kind: "frame";
			mime_type: "image/png" | "image/jpeg";
			data_base64: string;
			width_px: number;
			height_px: number;
			pointer_frame_seq: string | null;
	  }
	| { kind: "state"; url: string; title: string; loading: boolean }
	| { kind: string; [key: string]: unknown };

export interface CmuxTuiStreamEnd {
	reason: "completed" | "canceled" | "closed" | "gap" | "error";
	cursor?: { generation: string; revision: string };
	recovery?: string;
	error?: { code: string; message: string; details?: unknown; retryable: boolean };
}

export class CmuxTuiProtocolError extends ToolError {
	readonly code: string;
	readonly details: unknown;
	readonly retryable: boolean;

	constructor(error: { code?: unknown; message?: unknown; details?: unknown; retryable?: unknown }) {
		const code = typeof error.code === "string" && error.code.length > 0 ? error.code : "operation.failed";
		const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "cmux-tui error";
		super(`${code}: ${message}`);
		this.code = code;
		this.details = error.details;
		this.retryable = error.retryable === true;
	}
}

class CmuxTuiTransportError extends ToolError {}

export function isCmuxTuiUncertainMutationError(error: unknown): boolean {
	return (
		error instanceof CmuxTuiTransportError ||
		(error instanceof CmuxTuiProtocolError && error.code === "mutation.indeterminate")
	);
}

export class CmuxTuiStreamValidationError extends ToolError {}

export class CmuxTuiAttachmentEndedError extends ToolError {
	readonly end: CmuxTuiStreamEnd;

	constructor(end: CmuxTuiStreamEnd) {
		super(`cmux-tui browser stream ended during attachment: ${end.error?.message ?? end.reason}`);
		this.end = end;
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	abort?: () => void;
}

interface StreamSink {
	onItem(sequence: string, item: unknown): void;
	onEnd(end: CmuxTuiStreamEnd): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new ToolError(fallback);
}

function throwIfSignalAborted(signal: AbortSignal | undefined, fallback: string): void {
	if (signal?.aborted) throw abortError(signal, fallback);
}

async function sleepWithSignal(milliseconds: number, signal: AbortSignal | undefined, label: string): Promise<void> {
	throwIfSignalAborted(signal, label);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: NodeJS.Timeout;
	const cleanup = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	};
	const abort = (): void => {
		cleanup();
		reject(signal ? abortError(signal, label) : new ToolError(label));
	};
	timer = setTimeout(() => {
		cleanup();
		resolve();
	}, milliseconds);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	await promise;
}

async function waitWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	abortLabel: string,
	timeoutMs: number,
	timeoutLabel: string,
): Promise<T> {
	throwIfSignalAborted(signal, abortLabel);
	return await new Promise<T>((resolve, reject) => {
		let timer: NodeJS.Timeout;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(signal ? abortError(signal, abortLabel) : new ToolError(abortLabel));
		};
		timer = setTimeout(() => {
			cleanup();
			reject(new CmuxTuiTransportError(timeoutLabel));
		}, timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		promise.then(
			value => {
				cleanup();
				resolve(value);
			},
			error => {
				cleanup();
				reject(error);
			},
		);
	});
}

function resourceId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function requestId(): string {
	return randomUUID();
}

function assertResourceId(value: unknown, prefix: string, label: string): string {
	if (typeof value !== "string" || !new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value)) {
		throw new ToolError(`Invalid cmux-tui ${label}`);
	}
	return value;
}

function parseJsonLine(line: string, label: string): Record<string, unknown> {
	let payload: unknown;
	try {
		payload = JSON.parse(line);
	} catch (error) {
		throw new CmuxTuiTransportError(
			`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isObject(payload)) throw new CmuxTuiTransportError(`${label} returned a non-object response`);
	return payload;
}

async function openSocket(socketPath: string, timeoutMs: number, signal?: AbortSignal): Promise<net.Socket> {
	throwIfSignalAborted(signal, "cmux-tui connection aborted");
	const socket = net.createConnection({ path: socketPath });
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	let timer: NodeJS.Timeout;
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.off("error", onError);
		signal?.removeEventListener("abort", onAbort);
	};
	const onConnect = (): void => {
		cleanup();
		socket.setEncoding("utf8");
		resolve(socket);
	};
	const onError = (error: Error): void => {
		cleanup();
		reject(new CmuxTuiTransportError(`Failed to connect to cmux socket at ${socketPath}: ${error.message}`));
	};
	const onAbort = (): void => {
		cleanup();
		socket.destroy();
		reject(signal ? abortError(signal, "cmux-tui connection aborted") : new ToolError("cmux-tui connection aborted"));
	};
	timer = setTimeout(() => {
		cleanup();
		socket.destroy();
		reject(new CmuxTuiTransportError(`Failed to connect to cmux socket at ${socketPath}: timed out`));
	}, timeoutMs);
	socket.once("connect", onConnect);
	socket.once("error", onError);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return await promise;
}

function readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	const timer = setTimeout(() => {
		cleanup();
		socket.destroy();
		reject(new CmuxTuiTransportError("Timed out waiting for cmux socket response"));
	}, timeoutMs);
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("data", onData);
		socket.off("error", onError);
		socket.off("close", onClose);
	};
	const onData = (chunk: string | Buffer): void => {
		buffer += String(chunk);
		if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
			cleanup();
			socket.destroy();
			reject(new CmuxTuiTransportError("cmux socket response exceeded 16 MiB"));
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		cleanup();
		resolve(buffer.slice(0, newline).replace(/\r$/, ""));
	};
	const onError = (error: Error): void => {
		cleanup();
		reject(new CmuxTuiTransportError(`cmux socket error: ${error.message}`));
	};
	const onClose = (): void => {
		cleanup();
		reject(new CmuxTuiTransportError("cmux socket closed"));
	};
	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("close", onClose);
	return promise;
}

/**
 * Probe CMUX_SOCKET_PATH with raw `identify`, a read-only operation. Raw v10
 * selects public protocol/1 and raw v12 selects public protocol/2 before any
 * browser resource is opened or mutated. GUI cmux-socket v2 keeps its existing
 * result/error envelope.
 */
export async function detectCmuxSocketProtocol(opts: {
	socketPath: string;
	password?: string;
	timeoutMs?: number;
}): Promise<CmuxSocketProtocol> {
	const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
	const socket = await openSocket(opts.socketPath, timeoutMs);
	try {
		if (opts.password) {
			socket.write(`auth ${opts.password}\n`);
			const auth = await readLine(socket, timeoutMs);
			if (auth.startsWith("ERROR:") && !auth.includes("Unknown command 'auth'")) throw new ToolError(auth);
		}
		const id = requestId();
		socket.write(`${JSON.stringify({ id, cmd: "identify" })}\n`);
		const payload = parseJsonLine(await readLine(socket, timeoutMs), "cmux protocol probe");
		if (payload.id === id && payload.ok === true && isObject(payload.data) && payload.data.app === "cmux-tui") {
			const raw = payload.data;
			if (raw.protocol !== 10 && raw.protocol !== 12) {
				throw new ToolError(`Unsupported cmux-tui raw protocol ${String(raw.protocol)}; expected 10 or 12`);
			}
			if (
				typeof raw.version !== "string" ||
				typeof raw.session !== "string" ||
				typeof raw.pid !== "number" ||
				!Array.isArray(raw.capabilities) ||
				!raw.capabilities.every(capability => typeof capability === "string")
			) {
				throw new ToolError("Invalid cmux-tui identify response");
			}
			if (raw.protocol === 10) {
				return { kind: "tui", version: 1, raw: raw as unknown as CmuxTuiRawIdentityV1 };
			}
			return { kind: "tui", version: 2, raw: raw as unknown as CmuxTuiRawIdentityV2 };
		}
		if (
			typeof payload.ok === "boolean" &&
			((payload.ok === true && "result" in payload) || (payload.ok === false && isObject(payload.error)))
		) {
			return { kind: "gui", version: 2 };
		}
		throw new ToolError("CMUX_SOCKET_PATH did not identify as cmux-socket v2 or cmux-tui raw protocol 10/12");
	} finally {
		socket.end();
		socket.destroy();
	}
}

const STREAM_END_REASONS = ["completed", "canceled", "closed", "gap", "error"] as const;

function decodeStreamEndFields(value: Record<string, unknown>): CmuxTuiStreamEnd {
	if (!STREAM_END_REASONS.includes(value.reason as (typeof STREAM_END_REASONS)[number])) {
		throw new CmuxTuiTransportError("Malformed cmux-tui stream end envelope");
	}
	const cursor =
		isObject(value.cursor) && typeof value.cursor.generation === "string" && typeof value.cursor.revision === "string"
			? { generation: value.cursor.generation, revision: value.cursor.revision }
			: undefined;
	const streamError =
		isObject(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string" &&
		typeof value.error.retryable === "boolean"
			? {
					code: value.error.code,
					message: value.error.message,
					retryable: value.error.retryable,
					...("details" in value.error ? { details: value.error.details } : {}),
				}
			: undefined;
	if (
		(value.cursor !== undefined && cursor === undefined) ||
		(value.recovery !== undefined && typeof value.recovery !== "string") ||
		(value.error !== undefined && streamError === undefined) ||
		(value.reason === "error") !== (streamError !== undefined)
	) {
		throw new CmuxTuiTransportError("Malformed cmux-tui stream end envelope");
	}
	return {
		reason: value.reason as CmuxTuiStreamEnd["reason"],
		...(cursor ? { cursor } : {}),
		...(typeof value.recovery === "string" ? { recovery: value.recovery } : {}),
		...(streamError ? { error: streamError } : {}),
	};
}

function decodeStreamEndEnvelope(_version: CmuxTuiProtocolVersion, payload: Record<string, unknown>): CmuxTuiStreamEnd {
	if (Object.hasOwn(payload, "end")) {
		throw new CmuxTuiTransportError("Malformed cmux-tui stream end envelope");
	}
	return decodeStreamEndFields(payload);
}

class JsonLineConnection {
	readonly #socketPath: string;
	readonly #version: CmuxTuiProtocolVersion;
	readonly #protocol: (typeof PROTOCOLS)[CmuxTuiProtocolVersion];
	readonly #onClosed: (connection: JsonLineConnection) => void;
	#socket: net.Socket | null = null;
	#buffer = "";
	#closed = false;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #streams = new Map<string, StreamSink>();

	constructor(opts: {
		socketPath: string;
		version: CmuxTuiProtocolVersion;
		onClosed?: (connection: JsonLineConnection) => void;
	}) {
		this.#socketPath = opts.socketPath;
		this.#version = opts.version;
		this.#protocol = PROTOCOLS[opts.version];
		this.#onClosed = opts.onClosed ?? (() => undefined);
	}

	get alive(): boolean {
		return !this.#closed && this.#socket !== null && !this.#socket.destroyed;
	}

	registerStream(streamId: string, sink: StreamSink): void {
		if (this.#streams.has(streamId)) throw new ToolError(`cmux-tui stream already registered: ${streamId}`);
		this.#streams.set(streamId, sink);
	}

	unregisterStream(streamId: string): void {
		this.#streams.delete(streamId);
	}

	async connect(timeoutMs = CONNECT_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
		if (this.alive) return;
		if (this.#closed) throw new CmuxTuiTransportError("cmux-tui connection closed");
		const socket = await openSocket(this.#socketPath, timeoutMs, signal);
		this.#socket = socket;
		socket.on("data", chunk => this.#onData(String(chunk)));
		socket.on("error", error => this.#fail(new CmuxTuiTransportError(`cmux socket error: ${error.message}`)));
		socket.on("close", () => this.#fail(new CmuxTuiTransportError("cmux socket closed")));
	}

	async request(
		operation: string,
		params: Record<string, unknown>,
		opts: { timeoutMs?: number; idempotencyKey?: string; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
		throwIfSignalAborted(opts.signal, `cmux-tui ${operation} aborted`);
		await this.connect(timeoutMs, opts.signal);
		throwIfSignalAborted(opts.signal, `cmux-tui ${operation} aborted`);
		if (!this.#socket || this.#socket.destroyed) throw new CmuxTuiTransportError("cmux-tui connection closed");
		const id = requestId();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		let timer: NodeJS.Timeout;
		let abort: (() => void) | undefined;
		const cleanup = (): void => {
			clearTimeout(timer);
			if (abort) opts.signal?.removeEventListener("abort", abort);
		};
		timer = setTimeout(() => {
			if (!this.#pending.delete(id)) return;
			cleanup();
			reject(new CmuxTuiTransportError(`Timed out waiting for cmux-tui ${operation} response`));
		}, timeoutMs);
		abort = () => {
			if (!this.#pending.delete(id)) return;
			cleanup();
			reject(
				opts.signal
					? abortError(opts.signal, `cmux-tui ${operation} aborted`)
					: new ToolError(`cmux-tui ${operation} aborted`),
			);
		};
		this.#pending.set(id, { resolve, reject, timer, signal: opts.signal, abort });
		opts.signal?.addEventListener("abort", abort, { once: true });
		if (opts.signal?.aborted) {
			abort();
			return await promise;
		}
		const request: Record<string, unknown> = {
			protocol: this.#protocol,
			type: "request",
			id,
			operation,
			params,
		};
		if (opts.idempotencyKey) request.idempotency_key = opts.idempotencyKey;
		this.#socket.write(`${JSON.stringify(request)}\n`, error => {
			if (error) this.#fail(new CmuxTuiTransportError(`Failed to write cmux-tui request: ${error.message}`));
		});
		return await promise;
	}

	close(): void {
		this.#fail(new CmuxTuiTransportError("cmux-tui connection closed"));
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		if (Buffer.byteLength(this.#buffer) > MAX_LINE_BYTES) {
			this.#fail(new CmuxTuiTransportError("cmux-tui response exceeded 16 MiB"));
			return;
		}
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				this.#route(parseJsonLine(line, "cmux-tui"));
			} catch (error) {
				this.#fail(error instanceof Error ? error : new CmuxTuiTransportError(String(error)));
				return;
			}
		}
	}

	#route(payload: Record<string, unknown>): void {
		if (payload.protocol !== this.#protocol || typeof payload.type !== "string") {
			throw new CmuxTuiTransportError(`Received a non-${this.#protocol} envelope on the cmux-tui route`);
		}
		if (payload.type === "response") {
			if (typeof payload.id !== "string")
				throw new CmuxTuiTransportError("cmux-tui response omitted its request id");
			const pending = this.#pending.get(payload.id);
			if (!pending) return;
			this.#pending.delete(payload.id);
			clearTimeout(pending.timer);
			if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
			if (payload.ok === true) pending.resolve(payload.result);
			else if (payload.ok === false && isObject(payload.error))
				pending.reject(new CmuxTuiProtocolError(payload.error));
			else pending.reject(new CmuxTuiTransportError("Malformed cmux-tui response envelope"));
			return;
		}
		if (payload.type === "stream_item") {
			if (typeof payload.stream_id !== "string" || typeof payload.sequence !== "string") {
				throw new CmuxTuiTransportError("Malformed cmux-tui stream item envelope");
			}
			const sink = this.#streams.get(payload.stream_id);
			if (!sink) throw new CmuxTuiTransportError(`Unexpected cmux-tui stream ${payload.stream_id}`);
			sink.onItem(payload.sequence, payload.item);
			return;
		}
		if (payload.type === "stream_end") {
			if (typeof payload.stream_id !== "string") {
				throw new CmuxTuiTransportError("Malformed cmux-tui stream end envelope");
			}
			const sink = this.#streams.get(payload.stream_id);
			if (!sink) throw new CmuxTuiTransportError(`Unexpected cmux-tui stream ${payload.stream_id}`);
			const end = decodeStreamEndEnvelope(this.#version, payload);
			this.#streams.delete(payload.stream_id);
			sink.onEnd(end);
			return;
		}
		throw new CmuxTuiTransportError(`Unknown cmux-tui envelope type ${payload.type}`);
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
			pending.reject(error);
		}
		this.#pending.clear();
		const retryable = !(error instanceof CmuxTuiStreamValidationError);
		for (const sink of this.#streams.values()) {
			sink.onEnd({
				reason: "error",
				error: {
					code: retryable ? "transport.closed" : "validation.invalid",
					message: error.message,
					retryable,
				},
			});
		}
		this.#streams.clear();
		this.#socket?.destroy();
		this.#socket = null;
		this.#onClosed(this);
	}
}

function assertSingleSnapshot(result: unknown, prefix: string, label: string): Record<string, unknown> {
	if (!Array.isArray(result) || result.length !== 1 || !isObject(result[0])) {
		throw new ToolError(`cmux-tui ${label} must return exactly one local resource`);
	}
	assertResourceId(result[0].id, prefix, `${label} id`);
	return result[0];
}

export class CmuxTuiClient {
	readonly #socketPath: string;
	readonly #version: CmuxTuiProtocolVersion;
	#connection: JsonLineConnection | null = null;
	#connectPromise: Promise<void> | null = null;
	#route: CmuxTuiRoute | null = null;
	#disposed = false;

	constructor(opts: { socketPath: string; version: CmuxTuiProtocolVersion }) {
		this.#socketPath = opts.socketPath;
		this.#version = opts.version;
	}

	get version(): CmuxTuiProtocolVersion {
		return this.#version;
	}

	get route(): CmuxTuiRoute {
		if (!this.#route) throw new ToolError("cmux-tui client is not connected");
		return this.#route;
	}

	async connect(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
		if (this.#disposed) throw new ToolError("cmux-tui client closed");
		throwIfSignalAborted(opts.signal, "cmux-tui connection aborted");
		if (this.#connection?.alive && this.#route) return;
		const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
		if (!this.#connectPromise) {
			this.#connectPromise = this.#openAndNegotiate(timeoutMs).finally(() => {
				this.#connectPromise = null;
			});
		}
		await waitWithSignal(
			this.#connectPromise,
			opts.signal,
			"cmux-tui connection aborted",
			timeoutMs,
			"Timed out negotiating cmux-tui route",
		);
	}

	async request<T>(
		operation: string,
		params: Record<string, unknown>,
		opts: { mutation?: boolean; timeoutMs?: number; idempotencyKey?: string; signal?: AbortSignal } = {},
	): Promise<T> {
		const deadline = Date.now() + (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
		const execute = async (): Promise<T> => {
			throwIfSignalAborted(opts.signal, `cmux-tui ${operation} aborted`);
			const beforeConnect = deadline - Date.now();
			if (beforeConnect <= 0) {
				throw new CmuxTuiTransportError(`Timed out waiting for cmux-tui ${operation} response`);
			}
			await this.connect({ timeoutMs: beforeConnect, signal: opts.signal });
			throwIfSignalAborted(opts.signal, `cmux-tui ${operation} aborted`);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new CmuxTuiTransportError(`Timed out waiting for cmux-tui ${operation} response`);
			const connection = this.#connection;
			if (!connection) throw new CmuxTuiTransportError("cmux-tui connection unavailable");
			return (await connection.request(operation, params, {
				timeoutMs: remaining,
				idempotencyKey: opts.mutation ? (opts.idempotencyKey ?? requestId()) : undefined,
				signal: opts.signal,
			})) as T;
		};
		try {
			return await execute();
		} catch (error) {
			if (opts.mutation || !(error instanceof CmuxTuiTransportError) || this.#disposed || Date.now() >= deadline) {
				throw error;
			}
			return await execute();
		}
	}

	async createBrowserResource(
		create: { url: string; name: string; width: number; height: number },
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<CmuxTuiMutationResult<CmuxTuiCreatedBrowserPath>> {
		const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		const timeoutError = (): CmuxTuiTransportError =>
			new CmuxTuiTransportError("Timed out resolving uncertain cmux-tui browser creation");
		const remaining = (): number => {
			const value = deadline - Date.now();
			if (value <= 0) throw timeoutError();
			return value;
		};
		await this.connect({ timeoutMs: remaining(), signal: opts.signal });
		throwIfSignalAborted(opts.signal, "cmux-tui browser creation aborted");
		const route = this.route;
		const correlationKey = requestId();
		let idempotencyKey = requestId();

		for (;;) {
			throwIfSignalAborted(opts.signal, "cmux-tui browser creation aborted");
			const createRemaining = remaining();
			try {
				return await this.request<CmuxTuiMutationResult<CmuxTuiCreatedBrowserPath>>(
					"tab.create_browser",
					{
						machine: route.machineId,
						session: route.sessionId,
						url: create.url,
						name: create.name,
						width_px: create.width,
						height_px: create.height,
						correlation_key: correlationKey,
					},
					{
						mutation: true,
						timeoutMs: Math.max(1, Math.floor(createRemaining / 2)),
						idempotencyKey,
						signal: opts.signal,
					},
				);
			} catch (error) {
				const isIndeterminate = isCmuxTuiUncertainMutationError(error) || opts.signal?.aborted === true;
				if (!isIndeterminate) throw error;
			}

			for (;;) {
				const resolveRemaining = remaining();
				const recoverySignal = AbortSignal.timeout(resolveRemaining);
				let resolution: Record<string, unknown>;
				try {
					resolution = await this.request<Record<string, unknown>>(
						"session.creation.resolve",
						{ machine: route.machineId, session: route.sessionId, correlation_key: correlationKey },
						{ timeoutMs: resolveRemaining, signal: recoverySignal },
					);
				} catch (error) {
					if (recoverySignal.aborted || Date.now() >= deadline) throw timeoutError();
					if (
						error instanceof CmuxTuiTransportError ||
						(error instanceof CmuxTuiProtocolError && error.retryable)
					) {
						continue;
					}
					throw error;
				}
				if (
					!isObject(resolution) ||
					resolution.correlation_key !== correlationKey ||
					typeof resolution.state !== "string" ||
					typeof resolution.recovery !== "string"
				) {
					throw new CmuxTuiTransportError("Invalid cmux-tui session.creation.resolve response");
				}
				if (resolution.state === "created") {
					if (
						resolution.recovery !== "none" ||
						!isObject(resolution.created_path) ||
						typeof resolution.generation !== "string" ||
						typeof resolution.revision !== "string"
					) {
						throw new CmuxTuiTransportError("Invalid created cmux-tui creation resolution");
					}
					return {
						value: resolution.created_path as unknown as CmuxTuiCreatedBrowserPath,
						generation: resolution.generation,
						revision: resolution.revision,
						replayed: false,
					};
				}
				if (resolution.state === "pending") {
					if (resolution.recovery !== "wait") {
						throw new CmuxTuiTransportError("Invalid pending cmux-tui creation resolution");
					}
					await sleepWithSignal(
						Math.min(50, remaining()),
						AbortSignal.timeout(remaining()),
						"Timed out resolving uncertain cmux-tui browser creation",
					);
					continue;
				}
				if (resolution.state === "not_applied") {
					if (opts.signal?.aborted) throw abortError(opts.signal, "cmux-tui browser creation aborted");
					if (resolution.recovery === "retry_new_idempotency_key") idempotencyKey = requestId();
					else if (resolution.recovery !== "retry_same_idempotency_key") {
						throw new CmuxTuiTransportError("Invalid not_applied cmux-tui creation resolution");
					}
					break;
				}
				if (resolution.state === "indeterminate" && resolution.recovery === "do_not_retry") {
					throw new CmuxTuiTransportError(
						`cmux-tui browser creation ${correlationKey} is indeterminate and must not be retried`,
					);
				}
				throw new CmuxTuiTransportError("Invalid cmux-tui creation resolution state");
			}
		}
	}

	async isAlive(): Promise<boolean> {
		try {
			await this.connect();
			const { machineId, sessionId } = this.route;
			await this.request(
				"session.get",
				{ machine: machineId, session: sessionId },
				{ timeoutMs: CONNECT_TIMEOUT_MS },
			);
			return true;
		} catch {
			return false;
		}
	}

	async openBrowserAttachment(opts: {
		browserId: string;
		width: number;
		height: number;
		timeoutMs?: number;
		signal?: AbortSignal;
		onItem(item: CmuxTuiBrowserAttachItem): void;
		onEnd(end: CmuxTuiStreamEnd): void;
	}): Promise<CmuxTuiBrowserAttachment> {
		await this.connect({ timeoutMs: opts.timeoutMs, signal: opts.signal });
		assertResourceId(opts.browserId, "browser", "browser id");
		return await CmuxTuiBrowserAttachment.open({
			socketPath: this.#socketPath,
			version: this.#version,
			route: this.route,
			...opts,
		});
	}

	close(): void {
		this.#disposed = true;
		this.#connection?.close();
		this.#connection = null;
	}

	async #openAndNegotiate(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const remaining = (): number => {
			const value = deadline - Date.now();
			if (value <= 0) throw new CmuxTuiTransportError("Timed out negotiating cmux-tui route");
			return value;
		};
		const connection = new JsonLineConnection({
			socketPath: this.#socketPath,
			version: this.#version,
			onClosed: closed => {
				if (this.#connection === closed) this.#connection = null;
			},
		});
		await connection.connect(remaining());
		try {
			const machine = assertSingleSnapshot(
				await connection.request("machine.list", {}, { timeoutMs: remaining() }),
				"machine",
				"machine.list",
			);
			const machineId = assertResourceId(machine.id, "machine", "machine id");
			const session = assertSingleSnapshot(
				await connection.request("session.list", { machine: machineId }, { timeoutMs: remaining() }),
				"session",
				"session.list",
			);
			const sessionId = assertResourceId(session.id, "session", "session id");
			if (this.#route && (this.#route.machineId !== machineId || this.#route.sessionId !== sessionId)) {
				throw new ToolError("cmux-tui socket reconnected to a different machine/session route");
			}
			this.#route = { machineId, sessionId };
			this.#connection = connection;
		} catch (error) {
			connection.close();
			throw error;
		}
	}
}

export class CmuxTuiBrowserAttachment {
	readonly #connection: JsonLineConnection;
	readonly #version: CmuxTuiProtocolVersion;
	readonly #route: CmuxTuiRoute;
	readonly #browserId: string;
	readonly #streamId: string;
	#attachmentLease: string | null = null;
	readonly #onItem: (item: CmuxTuiBrowserAttachItem) => void;
	readonly #onEnd: (end: CmuxTuiStreamEnd) => void;
	#lastSequence: bigint | null = null;
	#ended: CmuxTuiStreamEnd | null = null;
	#closed = false;
	readonly #endPromise: Promise<CmuxTuiStreamEnd>;
	readonly #resolveEnd: (end: CmuxTuiStreamEnd) => void;

	constructor(opts: {
		connection: JsonLineConnection;
		version: CmuxTuiProtocolVersion;
		route: CmuxTuiRoute;
		browserId: string;
		streamId: string;
		onItem(item: CmuxTuiBrowserAttachItem): void;
		onEnd(end: CmuxTuiStreamEnd): void;
	}) {
		this.#connection = opts.connection;
		this.#version = opts.version;
		this.#route = opts.route;
		this.#browserId = opts.browserId;
		this.#streamId = opts.streamId;
		this.#onItem = opts.onItem;
		this.#onEnd = opts.onEnd;
		const end = Promise.withResolvers<CmuxTuiStreamEnd>();
		this.#endPromise = end.promise;
		this.#resolveEnd = end.resolve;
	}

	static async open(opts: {
		socketPath: string;
		version: CmuxTuiProtocolVersion;
		route: CmuxTuiRoute;
		browserId: string;
		width: number;
		height: number;
		timeoutMs?: number;
		signal?: AbortSignal;
		onItem(item: CmuxTuiBrowserAttachItem): void;
		onEnd(end: CmuxTuiStreamEnd): void;
	}): Promise<CmuxTuiBrowserAttachment> {
		const deadline = Date.now() + (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
		const remaining = (): number => {
			const value = deadline - Date.now();
			if (value <= 0) throw new CmuxTuiTransportError("Timed out opening cmux-tui browser attachment");
			return value;
		};
		const connection = new JsonLineConnection({ socketPath: opts.socketPath, version: opts.version });
		await connection.connect(remaining(), opts.signal);
		const streamId = resourceId("stream");
		const attachment = new CmuxTuiBrowserAttachment({
			connection,
			version: opts.version,
			route: opts.route,
			browserId: opts.browserId,
			streamId,
			onItem: opts.onItem,
			onEnd: opts.onEnd,
		});
		connection.registerStream(streamId, {
			onItem: (sequence, item) => attachment.#receiveItem(sequence, item),
			onEnd: end => attachment.#receiveEnd(end),
		});
		let responseReceived = false;
		try {
			const result = await connection.request(
				"browser.attach",
				{
					machine: opts.route.machineId,
					session: opts.route.sessionId,
					browser: opts.browserId,
					stream_id: streamId,
					width_px: opts.width,
					height_px: opts.height,
				},
				{ timeoutMs: remaining(), signal: opts.signal },
			);
			responseReceived = true;
			if (!isObject(result) || result.stream_id !== streamId) {
				throw new CmuxTuiTransportError("cmux-tui browser.attach returned the wrong stream id");
			}
			if (opts.version === 1) {
				if (Object.hasOwn(result, "attachment_lease")) {
					throw new CmuxTuiTransportError("cmux-tui protocol/1 browser.attach returned a protocol/2 lease");
				}
			} else {
				if (
					typeof result.attachment_lease !== "string" ||
					Buffer.byteLength(result.attachment_lease, "utf8") < 1 ||
					Buffer.byteLength(result.attachment_lease, "utf8") > 128
				) {
					throw new CmuxTuiTransportError("cmux-tui protocol/2 browser.attach returned an invalid lease");
				}
				attachment.#attachmentLease = result.attachment_lease;
			}
			if (!attachment.alive) {
				throw new CmuxTuiAttachmentEndedError(await attachment.#endPromise);
			}
			return attachment;
		} catch (error) {
			let failure = error;
			if (!responseReceived && error instanceof CmuxTuiTransportError && !attachment.alive) {
				failure = new CmuxTuiAttachmentEndedError(await attachment.#endPromise);
			}
			connection.unregisterStream(streamId);
			connection.close();
			throw failure;
		}
	}

	get alive(): boolean {
		return !this.#closed && this.#ended === null && this.#connection.alive;
	}

	async resize(
		width: number,
		height: number,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<{ accepted: boolean; size: { width_px: number; height_px: number } }> {
		return (await this.#connection.request(
			"browser.viewer.resize",
			{
				machine: this.#route.machineId,
				session: this.#route.sessionId,
				browser: this.#browserId,
				...this.#viewerLeaseParams(),
				width_px: width,
				height_px: height,
			},
			{ timeoutMs, signal },
		)) as { accepted: boolean; size: { width_px: number; height_px: number } };
	}

	async close(timeoutMs = 5_000, signal?: AbortSignal): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const deadline = Date.now() + timeoutMs;
		const remaining = (): number => {
			const value = deadline - Date.now();
			if (value <= 0) throw new CmuxTuiTransportError("Timed out canceling cmux-tui browser stream");
			return value;
		};
		try {
			if (this.#ended === null && this.#connection.alive) {
				await this.#connection.request(
					"browser.viewer.release",
					{
						machine: this.#route.machineId,
						session: this.#route.sessionId,
						browser: this.#browserId,
						...this.#viewerLeaseParams(),
					},
					{ timeoutMs: remaining(), signal },
				);
				const cancel = this.#connection.request(
					"stream.cancel",
					{ machine: this.#route.machineId, session: this.#route.sessionId, stream: this.#streamId },
					{ timeoutMs: remaining(), signal },
				);
				const [end] = await withTimeout(
					Promise.all([this.#endPromise, cancel]),
					remaining(),
					`Timed out after ${timeoutMs}ms canceling cmux-tui browser stream`,
				);
				if (end.reason !== "canceled") {
					throw new CmuxTuiTransportError(`cmux-tui stream ended as ${end.reason} during cancellation`);
				}
			}
		} finally {
			this.#connection.close();
		}
	}

	#viewerLeaseParams(): Record<string, never> | { attachment_lease: string } {
		if (this.#version === 1) return {};
		return { attachment_lease: this.#requireAttachmentLease() };
	}

	#requireAttachmentLease(): string {
		if (this.#attachmentLease === null) {
			throw new CmuxTuiTransportError("cmux-tui browser attachment lease is unavailable");
		}
		return this.#attachmentLease;
	}

	#receiveItem(sequence: string, item: unknown): void {
		let parsed: bigint;
		try {
			parsed = BigInt(sequence);
		} catch {
			this.#receiveEnd({ reason: "gap", recovery: `invalid stream sequence ${sequence}` });
			this.#connection.close();
			return;
		}
		if (this.#lastSequence !== null && parsed !== this.#lastSequence + 1n) {
			this.#receiveEnd({ reason: "gap", recovery: `expected ${this.#lastSequence + 1n}, received ${parsed}` });
			this.#connection.close();
			return;
		}
		this.#lastSequence = parsed;
		if (!isObject(item) || typeof item.kind !== "string") {
			this.#receiveEnd({
				reason: "error",
				error: { code: "validation.invalid", message: "Malformed browser attach item", retryable: false },
			});
			this.#connection.close();
			return;
		}
		this.#onItem(item as CmuxTuiBrowserAttachItem);
	}

	#receiveEnd(end: CmuxTuiStreamEnd): void {
		if (this.#ended) return;
		this.#ended = end;
		this.#resolveEnd(end);
		if (!this.#closed) this.#connection.close();
		this.#onEnd(end);
	}
}
