import { untilAborted } from "@oh-my-pi/pi-utils";
import { JsRuntime } from "../../../eval/js/shared/runtime";
import { ToolError, throwIfAborted } from "../../tool-errors";
import { DEFAULT_VIEWPORT } from "../launch";
import type { ReadyInfo, SessionSnapshot } from "../tab-protocol";
import { type CmuxRunContext, type CmuxRunTarget, recordCmuxScreenshot, type ScreenshotOptions } from "./cmux-tab";
import type {
	CmuxTuiBrowserAttachItem,
	CmuxTuiBrowserAttachment,
	CmuxTuiBrowserSnapshot,
	CmuxTuiClient,
	CmuxTuiMutationResult,
	CmuxTuiStreamEnd,
} from "./tui-client";
import { CmuxTuiAttachmentEndedError, CmuxTuiProtocolError, CmuxTuiStreamValidationError } from "./tui-client";

type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type MouseButton = "left" | "middle" | "right" | "back" | "forward";
type MouseKind = "down" | "up" | "move";

interface Frame {
	mimeType: "image/png" | "image/jpeg";
	dataBase64: string;
	width: number;
	height: number;
	pointerFrameSeq: string | null;
	version: number;
}

interface FrameWaiter {
	afterVersion: number;
	resolve(frame: Frame): void;
	reject(error: unknown): void;
	timer: NodeJS.Timeout;
}

class FrameStreamEnded extends Error {}

function finiteCoordinate(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new ToolError(`${label} must be a finite number`);
	return value;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isInteger(value) || value < 1) throw new ToolError(`${label} must be a positive integer`);
	return value;
}

function assertSupportedWaitUntil(waitUntil: WaitUntil | undefined): void {
	if (waitUntil !== undefined && waitUntil !== "load") {
		throw new ToolError(`cmux-tui browser navigation supports waitUntil "load", not ${JSON.stringify(waitUntil)}`);
	}
}

function remainingTimeout(deadline: number, label: string): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new ToolError(label);
	return remaining;
}

function unsupported(operation: string): never {
	throw new ToolError(
		`${operation} is unavailable for cmux-tui browser resources because cmux.protocol/1 and /2 expose frames, navigation, and input but not page JavaScript or DOM handles`,
	);
}

function validateBrowserSnapshot(value: unknown, expectedId: string): CmuxTuiBrowserSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ToolError("Invalid cmux-tui browser snapshot");
	}
	const snapshot = value as Record<string, unknown>;
	if (
		snapshot.id !== expectedId ||
		typeof snapshot.tab_id !== "string" ||
		typeof snapshot.url !== "string" ||
		typeof snapshot.title !== "string" ||
		typeof snapshot.loading !== "boolean" ||
		(snapshot.status !== "starting" && snapshot.status !== "live" && snapshot.status !== "failed") ||
		typeof snapshot.frames_stalled !== "boolean"
	) {
		throw new ToolError("Invalid cmux-tui browser snapshot");
	}
	return snapshot as unknown as CmuxTuiBrowserSnapshot;
}

export class CmuxTuiTab implements CmuxRunTarget {
	readonly #client: CmuxTuiClient;
	readonly #browserId: string;
	#lastUrl = "about:blank";
	#lastTitle: string | undefined;
	#loading = false;
	#viewport: ReadyInfo["viewport"];
	#runContext: CmuxRunContext | undefined;
	#runtime: JsRuntime | undefined;
	#attachment: CmuxTuiBrowserAttachment | null = null;
	#attachmentPromise: Promise<void> | null = null;
	#attachmentGeneration = 0;
	#latestFrame: Frame | null = null;
	#frameVersion = 0;
	readonly #frameWaiters = new Set<FrameWaiter>();
	#pointerCapture: { sequence: string; button: MouseButton } | null = null;
	#pageFacade: CmuxTuiPageFacade | undefined;
	#browserFacade: CmuxTuiBrowserFacade | undefined;
	readonly #onTerminal: (end: CmuxTuiStreamEnd) => void;
	#terminalEnd: CmuxTuiStreamEnd | null = null;

	constructor(opts: {
		client: CmuxTuiClient;
		browserId: string;
		url?: string;
		title?: string;
		viewport?: ReadyInfo["viewport"];
		onTerminal?(end: CmuxTuiStreamEnd): void;
	}) {
		this.#client = opts.client;
		this.#browserId = opts.browserId;
		this.#lastUrl = opts.url ?? this.#lastUrl;
		this.#lastTitle = opts.title;
		this.#viewport = opts.viewport ?? DEFAULT_VIEWPORT;
		this.#onTerminal = opts.onTerminal ?? (() => undefined);
	}

	get surfaceId(): string {
		return this.#browserId;
	}

	get page(): CmuxTuiPageFacade {
		this.#pageFacade ??= new CmuxTuiPageFacade(this);
		return this.#pageFacade;
	}

	get browser(): CmuxTuiBrowserFacade {
		this.#browserFacade ??= new CmuxTuiBrowserFacade(this);
		return this.#browserFacade;
	}

	viewport(): ReadyInfo["viewport"] {
		return this.#viewport;
	}

	url(): string {
		return this.#lastUrl;
	}

	async title(): Promise<string> {
		await this.#refreshSnapshot(this.#runContext?.timeoutMs, this.#runContext?.signal);
		return this.#lastTitle ?? "";
	}

	async resourceAlive(timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
		if (this.#terminalEnd) return false;
		try {
			await this.#refreshSnapshot(timeoutMs, signal);
			return !this.#terminalEnd;
		} catch (error) {
			if (this.#terminalEnd) return false;
			throw error;
		}
	}

	setRunContext(context: CmuxRunContext): void {
		this.#runContext = context;
	}

	clearRunContext(): void {
		this.#runContext = undefined;
	}

	ensureRuntime(session: SessionSnapshot): JsRuntime {
		this.#runtime ??= new JsRuntime({ initialCwd: session.cwd, sessionId: `cmux-tui-browser-${this.#browserId}` });
		return this.#runtime;
	}

	async readyInfo(
		viewport: ReadyInfo["viewport"] = DEFAULT_VIEWPORT,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ReadyInfo> {
		this.#viewport = viewport;
		const timeoutMs = opts.timeoutMs ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = opts.signal ?? this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `cmux-tui browser did not present an initial frame within ${timeoutMs}ms`;
		const previousVersion = this.#frameVersion;
		await this.#refreshSnapshot(remainingTimeout(deadline, timeoutMessage), signal);
		await this.#ensureAttachment(remainingTimeout(deadline, timeoutMessage), signal);
		if (!this.#latestFrame) {
			await this.#waitForFrame(previousVersion, remainingTimeout(deadline, timeoutMessage), signal);
		}
		return {
			url: this.#lastUrl,
			title: this.#lastTitle,
			viewport: this.#viewport,
			targetId: this.#browserId,
		};
	}

	async waitForInitialLoad(
		opts: { waitUntil?: WaitUntil; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		assertSupportedWaitUntil(opts.waitUntil);
		const timeoutMs = opts.timeoutMs ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = opts.signal ?? this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `cmux-tui browser initial navigation timed out after ${timeoutMs}ms`;
		await this.#waitForLoad(deadline, timeoutMs, signal);
		await this.closeAttachment(remainingTimeout(deadline, timeoutMessage), signal);
	}

	async setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void> {
		const width = positiveInteger(viewport.width, "viewport.width");
		const height = positiveInteger(viewport.height, "viewport.height");
		const timeoutMs = this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `cmux-tui browser resize timed out after ${timeoutMs}ms`;
		await this.#ensureAttachment(remainingTimeout(deadline, timeoutMessage), signal);
		const attachment = this.#attachment;
		if (!attachment) throw new ToolError("cmux-tui browser attachment unavailable");
		this.#invalidatePointerAuthority();
		const result = await attachment.resize(width, height, remainingTimeout(deadline, timeoutMessage), signal);
		if (
			!result ||
			typeof result.accepted !== "boolean" ||
			!result.size ||
			!Number.isInteger(result.size.width_px) ||
			!Number.isInteger(result.size.height_px)
		) {
			throw new ToolError("Invalid cmux-tui browser.viewer.resize result");
		}
		this.#viewport = {
			width: result.size.width_px,
			height: result.size.height_px,
			deviceScaleFactor: viewport.deviceScaleFactor,
		};
		if (result.accepted) await this.closeAttachment(remainingTimeout(deadline, timeoutMessage), signal);
	}

	async goto(
		url: string,
		opts: { waitUntil?: WaitUntil; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		if (!url) throw new ToolError("tab.goto() requires a non-empty URL");
		await this.#navigateBrowser("browser.navigate", { url }, opts);
	}

	async back(timeoutMs?: number): Promise<void> {
		await this.#navigateBrowser("browser.back", {}, { timeoutMs });
	}

	async forward(timeoutMs?: number): Promise<void> {
		await this.#navigateBrowser("browser.forward", {}, { timeoutMs });
	}

	async reload(timeoutMs?: number): Promise<void> {
		await this.#navigateBrowser("browser.reload", {}, { timeoutMs });
	}

	async activate(timeoutMs?: number): Promise<void> {
		const result = await this.#mutateBrowser("browser.activate", {}, timeoutMs, this.#runContext?.signal);
		this.#applySnapshot(result.value);
	}

	async press(key: string, opts?: { selector?: string }): Promise<void> {
		if (opts?.selector) unsupported("Selector-focused tab.press()");
		if (!key) throw new ToolError("tab.press() requires a non-empty key");
		await this.#mutation("browser.input.key", { key, kind: "press" });
	}

	async insertText(text: string): Promise<void> {
		await this.#mutation("browser.input.text", { text });
	}

	async mouse(
		kind: MouseKind,
		x: number,
		y: number,
		opts: { button?: MouseButton; clickCount?: number } = {},
	): Promise<void> {
		finiteCoordinate(x, "mouse x");
		finiteCoordinate(y, "mouse y");
		let sequence: string;
		if (kind === "up" && this.#pointerCapture) {
			sequence = this.#pointerCapture.sequence;
		} else if (kind === "move" && this.#pointerCapture) {
			sequence = this.#pointerCapture.sequence;
		} else {
			sequence = await this.#pointerSequence();
		}
		const button = opts.button ?? this.#pointerCapture?.button;
		if ((kind === "down" || kind === "up") && !button) throw new ToolError(`browser mouse ${kind} requires a button`);
		try {
			await this.#mutation("browser.input.mouse", {
				kind,
				x_px: x,
				y_px: y,
				pointer_frame_seq: sequence,
				...(kind === "move"
					? {}
					: {
							button,
							...(opts.clickCount === undefined ? {} : { click_count: opts.clickCount }),
						}),
			});
			if (kind === "down") this.#pointerCapture = { sequence, button: button! };
		} catch (error) {
			if (kind !== "up") this.#invalidatePointerAuthority();
			throw error;
		} finally {
			if (kind === "up") this.#pointerCapture = null;
		}
	}

	async clickPoint(x: number, y: number, opts: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
		const button = opts.button ?? "left";
		await this.mouse("down", x, y, { button, clickCount: opts.clickCount ?? 1 });
		await this.mouse("up", x, y, { button, clickCount: opts.clickCount ?? 1 });
	}

	async wheel(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
		const frame = await this.#captureFrame();
		const sequence = frame.pointerFrameSeq;
		if (!sequence) throw new ToolError("cmux-tui browser frame is not authorized for pointer input");
		const pointerX = finiteCoordinate(x ?? frame.width / 2, "wheel x");
		const pointerY = finiteCoordinate(y ?? frame.height / 2, "wheel y");
		try {
			await this.#mutation("browser.input.wheel", {
				delta_x: finiteCoordinate(deltaX, "wheel deltaX"),
				delta_y: finiteCoordinate(deltaY, "wheel deltaY"),
				x_px: pointerX,
				y_px: pointerY,
				pointer_frame_seq: sequence,
			});
		} catch (error) {
			this.#invalidatePointerAuthority();
			throw error;
		}
	}

	async scroll(dx: number, dy: number): Promise<void> {
		await this.wheel(dx, dy);
	}

	async screenshot(opts: ScreenshotOptions = {}): Promise<string> {
		const context = this.#requireRunContext("tab.screenshot()");
		if (opts.selector) unsupported("Selector screenshots");
		const frame = await this.#captureFrame();
		return await recordCmuxScreenshot({
			context,
			dataBase64: frame.dataBase64,
			mimeType: frame.mimeType,
			silent: opts.silent,
			captureNotes: opts.fullPage
				? ["fullPage is unavailable on this surface — the image is the viewport only"]
				: [],
		});
	}

	async pageScreenshot(opts: ScreenshotOptions = {}): Promise<Buffer | string> {
		if (opts.selector) unsupported("Selector screenshots");
		const frame = await this.#captureFrame();
		return opts.encoding === "base64" ? frame.dataBase64 : Buffer.from(frame.dataBase64, "base64");
	}

	async waitForUrl(pattern: string | RegExp, opts: { timeout?: number } = {}): Promise<string> {
		const timeoutMs = opts.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `tab.waitForUrl() timed out after ${timeoutMs}ms`;
		const initialUrl = this.#lastUrl;
		const initialLoading = this.#loading;
		for (;;) {
			await this.#refreshSnapshot(remainingTimeout(deadline, timeoutMessage), signal);
			if (pattern instanceof RegExp ? pattern.test(this.#lastUrl) : this.#lastUrl.includes(pattern)) {
				if (this.#lastUrl !== initialUrl || this.#loading !== initialLoading) {
					await this.closeAttachment(remainingTimeout(deadline, timeoutMessage), signal);
				}
				return this.#lastUrl;
			}
			const beforeSleep = remainingTimeout(deadline, timeoutMessage);
			await untilAborted(signal, () => Bun.sleep(Math.min(100, beforeSleep)));
		}
	}

	async waitForNavigation(opts: { waitUntil?: WaitUntil; timeout?: number } = {}): Promise<null> {
		assertSupportedWaitUntil(opts.waitUntil);
		const initial = this.#lastUrl;
		const timeoutMs = opts.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `tab.waitForNavigation() timed out after ${timeoutMs}ms`;
		for (;;) {
			await this.#refreshSnapshot(remainingTimeout(deadline, timeoutMessage), signal);
			if (this.#lastUrl !== initial && !this.#loading) {
				await this.closeAttachment(remainingTimeout(deadline, timeoutMessage), signal);
				return null;
			}
			const beforeSleep = remainingTimeout(deadline, timeoutMessage);
			await untilAborted(signal, () => Bun.sleep(Math.min(100, beforeSleep)));
		}
	}

	async closeAttachment(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
		this.#attachmentGeneration++;
		const attachment = this.#attachment;
		this.#attachment = null;
		this.#attachmentPromise = null;
		this.#latestFrame = null;
		this.#invalidatePointerAuthority();
		this.#rejectFrameWaiters(new FrameStreamEnded("cmux-tui browser attachment closed"));
		if (attachment) await attachment.close(timeoutMs, signal);
	}

	observe(): never {
		return unsupported("tab.observe()");
	}

	ariaSnapshot(): never {
		return unsupported("tab.ariaSnapshot()");
	}

	ref(): never {
		return unsupported("tab.ref()");
	}

	id(): never {
		return unsupported("tab.id()");
	}

	evaluate(): never {
		return unsupported("tab.evaluate()");
	}

	click(): never {
		return unsupported("tab.click()");
	}

	dblclick(): never {
		return unsupported("tab.dblclick()");
	}

	hover(): never {
		return unsupported("tab.hover()");
	}

	focus(): never {
		return unsupported("tab.focus()");
	}

	check(): never {
		return unsupported("tab.check()");
	}

	uncheck(): never {
		return unsupported("tab.uncheck()");
	}

	type(): never {
		return unsupported("tab.type()");
	}

	fill(): never {
		return unsupported("tab.fill()");
	}

	waitFor(): never {
		return unsupported("tab.waitFor()");
	}

	waitForSelector(): never {
		return unsupported("tab.waitForSelector()");
	}

	scrollIntoView(): never {
		return unsupported("tab.scrollIntoView()");
	}

	select(): never {
		return unsupported("tab.select()");
	}

	drag(): never {
		return unsupported("tab.drag()");
	}

	uploadFile(): never {
		return unsupported("tab.uploadFile()");
	}

	waitForResponse(): never {
		return unsupported("tab.waitForResponse()");
	}

	extract(): never {
		return unsupported("tab.extract()");
	}

	async #ensureAttachment(timeoutMs = this.#runContext?.timeoutMs, signal = this.#runContext?.signal): Promise<void> {
		if (this.#terminalEnd) {
			throw new ToolError(`cmux-tui browser resource is closed: ${this.#terminalEnd.reason}`);
		}
		if (this.#attachment?.alive) return;
		if (this.#attachmentPromise) return await this.#attachmentPromise;
		const generation = ++this.#attachmentGeneration;
		const timeout = timeoutMs ?? 30_000;
		const deadline = Date.now() + timeout;
		const timeoutMessage = `cmux-tui browser attachment timed out after ${timeout}ms`;
		this.#attachmentPromise = (async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const attachment = await this.#client.openBrowserAttachment({
						browserId: this.#browserId,
						width: this.#viewport.width,
						height: this.#viewport.height,
						timeoutMs: remainingTimeout(deadline, timeoutMessage),
						signal,
						onItem: item => this.#receiveAttachmentItem(generation, item),
						onEnd: end => this.#receiveAttachmentEnd(generation, end),
					});
					if (generation !== this.#attachmentGeneration || !attachment.alive) {
						await attachment.close().catch(() => undefined);
						return;
					}
					this.#attachment = attachment;
					return;
				} catch (error) {
					if (error instanceof CmuxTuiProtocolError && error.code === "selector.not_found") {
						this.#markTerminal({
							reason: "closed",
							error: { code: error.code, message: error.message, retryable: error.retryable },
						});
						throw error;
					}
					if (error instanceof CmuxTuiAttachmentEndedError) {
						if (error.end.reason === "closed") {
							this.#markTerminal(error.end);
							throw error;
						}
						const recoverable =
							error.end.reason === "gap" ||
							(error.end.reason === "error" && error.end.error?.retryable === true);
						if (recoverable && attempt === 0) continue;
					}
					throw error;
				}
			}
		})();
		try {
			await this.#attachmentPromise;
		} finally {
			this.#attachmentPromise = null;
		}
	}

	#receiveAttachmentItem(generation: number, item: CmuxTuiBrowserAttachItem): void {
		if (generation !== this.#attachmentGeneration) return;
		switch (item.kind) {
			case "snapshot": {
				if (
					!("browser" in item) ||
					!("size" in item) ||
					!item.size ||
					typeof item.size !== "object" ||
					!("width_px" in item.size) ||
					!("height_px" in item.size) ||
					typeof item.size.width_px !== "number" ||
					typeof item.size.height_px !== "number" ||
					!Number.isInteger(item.size.width_px) ||
					!Number.isInteger(item.size.height_px) ||
					item.size.width_px <= 0 ||
					item.size.height_px <= 0
				) {
					throw new CmuxTuiStreamValidationError("Malformed cmux-tui browser snapshot stream item");
				}
				this.#applySnapshot(validateBrowserSnapshot(item.browser, this.#browserId));
				this.#viewport = { ...this.#viewport, width: item.size.width_px, height: item.size.height_px };
				return;
			}
			case "state": {
				if (
					!("url" in item) ||
					!("title" in item) ||
					!("loading" in item) ||
					typeof item.url !== "string" ||
					typeof item.title !== "string" ||
					typeof item.loading !== "boolean"
				) {
					throw new CmuxTuiStreamValidationError("Malformed cmux-tui browser state stream item");
				}
				const routeChanged = item.url !== this.#lastUrl || (item.loading && !this.#loading);
				this.#lastUrl = item.url;
				this.#lastTitle = item.title;
				this.#loading = item.loading;
				if (routeChanged) this.#invalidatePointerAuthority();
				return;
			}
			case "frame": {
				if (
					!("mime_type" in item) ||
					!("data_base64" in item) ||
					!("width_px" in item) ||
					!("height_px" in item) ||
					!("pointer_frame_seq" in item) ||
					(item.mime_type !== "image/png" && item.mime_type !== "image/jpeg") ||
					typeof item.data_base64 !== "string" ||
					typeof item.width_px !== "number" ||
					typeof item.height_px !== "number" ||
					!Number.isInteger(item.width_px) ||
					!Number.isInteger(item.height_px) ||
					item.width_px <= 0 ||
					item.height_px <= 0 ||
					(item.pointer_frame_seq !== null && typeof item.pointer_frame_seq !== "string")
				) {
					throw new CmuxTuiStreamValidationError("Malformed cmux-tui browser frame stream item");
				}
				const frame: Frame = {
					mimeType: item.mime_type,
					dataBase64: item.data_base64,
					width: item.width_px,
					height: item.height_px,
					pointerFrameSeq: item.pointer_frame_seq,
					version: ++this.#frameVersion,
				};
				this.#latestFrame = frame;
				for (const waiter of [...this.#frameWaiters]) {
					if (frame.version <= waiter.afterVersion) continue;
					clearTimeout(waiter.timer);
					this.#frameWaiters.delete(waiter);
					waiter.resolve(frame);
				}
				return;
			}
			default:
				return;
		}
	}

	#receiveAttachmentEnd(generation: number, end: CmuxTuiStreamEnd): void {
		if (generation !== this.#attachmentGeneration) return;
		this.#attachment = null;
		this.#latestFrame = null;
		this.#invalidatePointerAuthority();
		if (end.reason === "closed") this.#markTerminal(end);
		this.#rejectFrameWaiters(new FrameStreamEnded(`cmux-tui browser stream ended: ${end.reason}`));
	}

	#markTerminal(end: CmuxTuiStreamEnd): void {
		if (this.#terminalEnd) return;
		this.#terminalEnd = end;
		this.#onTerminal(end);
	}

	async #captureFrame(): Promise<Frame> {
		for (let attempt = 0; attempt < 2; attempt++) {
			await this.#ensureAttachment();
			if (!this.#attachment?.alive) continue;
			if (this.#latestFrame) return this.#latestFrame;
			try {
				return await this.#waitForFrame(this.#frameVersion, this.#runContext?.timeoutMs, this.#runContext?.signal);
			} catch (error) {
				if (!(error instanceof FrameStreamEnded) || attempt > 0 || this.#terminalEnd) throw error;
			}
		}
		throw new ToolError("cmux-tui browser did not produce a frame");
	}

	async #waitForFrame(
		afterVersion: number,
		timeoutMs = 30_000,
		signal: AbortSignal | undefined = this.#runContext?.signal,
	): Promise<Frame> {
		throwIfAborted(signal);
		if (this.#terminalEnd) throw new ToolError("cmux-tui browser resource is closed");
		if (this.#latestFrame && this.#latestFrame.version > afterVersion) return this.#latestFrame;
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		let waiter: FrameWaiter;
		const timer = setTimeout(() => {
			this.#frameWaiters.delete(waiter);
			reject(new ToolError(`Timed out after ${timeoutMs}ms waiting for a cmux-tui browser frame`));
		}, timeoutMs);
		waiter = { afterVersion, resolve, reject, timer };
		this.#frameWaiters.add(waiter);
		const abort = (): void => {
			clearTimeout(timer);
			this.#frameWaiters.delete(waiter);
			reject(signal?.reason ?? new ToolError("cmux-tui browser frame wait aborted"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			return await promise;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async #pointerSequence(): Promise<string> {
		const frame = await this.#captureFrame();
		if (!frame.pointerFrameSeq) throw new ToolError("cmux-tui browser frame is not authorized for pointer input");
		return frame.pointerFrameSeq;
	}

	#invalidatePointerAuthority(): void {
		if (this.#latestFrame) this.#latestFrame = { ...this.#latestFrame, pointerFrameSeq: null };
	}

	#rejectFrameWaiters(error: Error): void {
		for (const waiter of this.#frameWaiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.#frameWaiters.clear();
	}

	#applySnapshot(value: unknown): void {
		const snapshot = validateBrowserSnapshot(value, this.#browserId);
		const pointerAuthorityChanged = snapshot.url !== this.#lastUrl || (snapshot.loading && !this.#loading);
		this.#lastUrl = snapshot.url;
		this.#lastTitle = snapshot.title;
		this.#loading = snapshot.loading;
		if (pointerAuthorityChanged) this.#invalidatePointerAuthority();
		if (snapshot.status === "failed") throw new ToolError(snapshot.error ?? "cmux-tui browser failed");
	}

	async #refreshSnapshot(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
		const { machineId, sessionId } = this.#client.route;
		try {
			const snapshot = await this.#client.request<CmuxTuiBrowserSnapshot>(
				"browser.get",
				{
					machine: machineId,
					session: sessionId,
					browser: this.#browserId,
				},
				{ timeoutMs, signal },
			);
			this.#applySnapshot(snapshot);
		} catch (error) {
			if (error instanceof CmuxTuiProtocolError && error.code === "selector.not_found") {
				this.#markTerminal({
					reason: "closed",
					error: { code: error.code, message: error.message, retryable: error.retryable },
				});
			}
			throw error;
		}
	}

	async #mutation(
		operation: string,
		fields: Record<string, unknown>,
		timeoutMs?: number,
		signal = this.#runContext?.signal,
	): Promise<void> {
		const { machineId, sessionId } = this.#client.route;
		await this.#client.request<CmuxTuiMutationResult<Record<string, never>>>(
			operation,
			{ machine: machineId, session: sessionId, browser: this.#browserId, ...fields },
			{ mutation: true, timeoutMs: timeoutMs ?? this.#runContext?.timeoutMs, signal },
		);
	}

	async #mutateBrowser(
		operation: string,
		fields: Record<string, unknown>,
		timeoutMs?: number,
		signal = this.#runContext?.signal,
	): Promise<CmuxTuiMutationResult<CmuxTuiBrowserSnapshot>> {
		const { machineId, sessionId } = this.#client.route;
		const result = await this.#client.request<CmuxTuiMutationResult<CmuxTuiBrowserSnapshot>>(
			operation,
			{ machine: machineId, session: sessionId, browser: this.#browserId, ...fields },
			{ mutation: true, timeoutMs: timeoutMs ?? this.#runContext?.timeoutMs, signal },
		);
		if (!result || typeof result !== "object" || !("value" in result)) {
			throw new ToolError(`Invalid cmux-tui ${operation} mutation result`);
		}
		return result;
	}

	async #navigateBrowser(
		operation: string,
		fields: Record<string, unknown>,
		opts: { waitUntil?: WaitUntil; timeoutMs?: number; signal?: AbortSignal },
	): Promise<void> {
		assertSupportedWaitUntil(opts.waitUntil);
		const timeoutMs = opts.timeoutMs ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = opts.signal ?? this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		const timeoutMessage = `cmux-tui browser navigation timed out after ${timeoutMs}ms`;
		throwIfAborted(signal);
		await this.#ensureAttachment(remainingTimeout(deadline, timeoutMessage), signal);
		this.#invalidatePointerAuthority();
		const result = await this.#mutateBrowser(operation, fields, remainingTimeout(deadline, timeoutMessage), signal);
		this.#applySnapshot(result.value);
		await this.#waitForLoad(deadline, timeoutMs, signal);
		await this.closeAttachment(remainingTimeout(deadline, timeoutMessage), signal);
	}

	async #waitForLoad(deadline: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const timeoutMessage = `cmux-tui browser navigation timed out after ${timeoutMs}ms`;
		while (this.#loading) {
			await this.#refreshSnapshot(remainingTimeout(deadline, timeoutMessage), signal);
			if (!this.#loading) return;
			const beforeSleep = remainingTimeout(deadline, timeoutMessage);
			await untilAborted(signal, () => Bun.sleep(Math.min(100, beforeSleep)));
		}
	}

	#requireRunContext(operation: string): CmuxRunContext {
		if (!this.#runContext) throw new ToolError(`${operation} requires an active cmux browser run`);
		return this.#runContext;
	}
}

class CmuxTuiPageFacade {
	readonly #tab: CmuxTuiTab;
	readonly keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
	readonly mouse: {
		move(x: number, y: number): Promise<void>;
		down(opts?: { button?: MouseButton; clickCount?: number }): Promise<void>;
		up(opts?: { button?: MouseButton; clickCount?: number }): Promise<void>;
		click(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<void>;
		wheel(opts: { deltaX?: number; deltaY?: number }): Promise<void>;
	};
	#lastPoint = { x: 0, y: 0 };

	constructor(tab: CmuxTuiTab) {
		this.#tab = tab;
		this.keyboard = { press: key => tab.press(key), type: text => tab.insertText(text) };
		this.mouse = {
			move: async (x, y) => {
				this.#lastPoint = { x, y };
				await tab.mouse("move", x, y);
			},
			down: opts => tab.mouse("down", this.#lastPoint.x, this.#lastPoint.y, opts),
			up: opts => tab.mouse("up", this.#lastPoint.x, this.#lastPoint.y, opts),
			click: async (x, y, opts) => {
				this.#lastPoint = { x, y };
				await tab.clickPoint(x, y, { button: opts?.button, clickCount: opts?.count });
			},
			wheel: opts => tab.wheel(opts.deltaX ?? 0, opts.deltaY ?? 0, this.#lastPoint.x, this.#lastPoint.y),
		};
	}

	url(): string {
		return this.#tab.url();
	}

	async title(): Promise<string> {
		return await this.#tab.title();
	}

	viewport(): ReadyInfo["viewport"] {
		return this.#tab.viewport();
	}

	async setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void> {
		await this.#tab.setViewport(viewport);
	}

	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<{ url: string }> {
		await this.#tab.goto(url, { waitUntil: opts?.waitUntil, timeoutMs: opts?.timeout });
		return { url: this.#tab.url() };
	}

	async goBack(opts?: { timeout?: number }): Promise<null> {
		await this.#tab.back(opts?.timeout);
		return null;
	}

	async goForward(opts?: { timeout?: number }): Promise<null> {
		await this.#tab.forward(opts?.timeout);
		return null;
	}

	async reload(opts?: { timeout?: number }): Promise<null> {
		await this.#tab.reload(opts?.timeout);
		return null;
	}

	async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer | string> {
		return await this.#tab.pageScreenshot(opts);
	}

	evaluate(): never {
		return unsupported("page.evaluate()");
	}

	content(): never {
		return unsupported("page.content()");
	}

	locator(): never {
		return unsupported("page.locator()");
	}

	waitForSelector(): never {
		return unsupported("page.waitForSelector()");
	}
}

class CmuxTuiBrowserFacade {
	readonly #tab: CmuxTuiTab;
	connected = true;

	constructor(tab: CmuxTuiTab) {
		this.#tab = tab;
	}

	async pages(): Promise<CmuxTuiPageFacade[]> {
		return [this.#tab.page];
	}

	async version(): Promise<string> {
		return "cmux-tui";
	}

	wsEndpoint(): string {
		return `cmux-tui://${this.#tab.surfaceId}`;
	}

	disconnect(): void {
		this.connected = false;
	}

	async close(): Promise<void> {
		this.connected = false;
	}
}
