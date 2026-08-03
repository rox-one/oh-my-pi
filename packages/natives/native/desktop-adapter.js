const LEGACY_ERROR_CODES = {
	DESKTOP_INVALID_OPTIONS: "InvalidTarget",
	DESKTOP_INVALID_ACTION: "InvalidTarget",
	DESKTOP_BACKEND_UNAVAILABLE: null,
	DESKTOP_PERMISSION_DENIED: "PermissionDenied",
	DESKTOP_CAPTURE_FAILED: "CaptureFailed",
	DESKTOP_INPUT_FAILED: "InputFailed",
	DESKTOP_DEADLINE_EXCEEDED: "Timeout",
	DESKTOP_LAYOUT_CHANGED: "InvalidCoordinateFrame",
	DESKTOP_COORDINATE_OUT_OF_BOUNDS: "InvalidCoordinateFrame",
	DESKTOP_SESSION_CLOSED: "Closed",
	DESKTOP_WORKER_FAILED: "Internal",
};

const ADAPTED_SESSION_CLASSES = new WeakMap();

function desktopError(code, message) {
	return new Error(`${code}: ${message}`);
}

function normalizeError(error, fallbackCode) {
	if (!(error instanceof Error)) return desktopError(fallbackCode, String(error));
	if (/^[A-Z][A-Za-z]+: /.test(error.message)) return error;

	const match = /^(DESKTOP_[A-Z_]+):\s*(.*)$/.exec(error.message);
	if (match === null) return desktopError(fallbackCode, error.message);
	const code = LEGACY_ERROR_CODES[match[1]] ?? fallbackCode;
	return desktopError(code, match[2]);
}

function normalizeCapabilities(capabilities) {
	return {
		...capabilities,
		ax: false,
		backgroundWindowInput: false,
		deliveryModes: ["foreground"],
		axPermission: "unavailable",
	};
}

function legacyPoint(point) {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

/**
 * Adapt the pre-parity desktop addon ABI used by pull-request CI artifacts to
 * the current session contract. Released addons exposed capture/execute/close;
 * current addons already expose the complete API and pass through unchanged.
 */
export function adaptDesktopSession(NativeDesktopSession) {
	if (typeof NativeDesktopSession?.prototype?.click === "function") return NativeDesktopSession;
	const cached = ADAPTED_SESSION_CLASSES.get(NativeDesktopSession);
	if (cached) return cached;

	class DesktopSession {
		#native;
		#closed = false;
		#capturedTargets = new Set();

		constructor(options) {
			try {
				this.#native = new NativeDesktopSession(options);
			} catch (error) {
				throw normalizeError(error, "Internal");
			}
		}

		get capabilities() {
			return normalizeCapabilities(this.#native.capabilities);
		}

		#ensureOpen() {
			if (this.#closed) throw desktopError("Closed", "desktop session is closed");
		}

		#ensureCaptured(target) {
			if (!this.#capturedTargets.has(target)) {
				throw desktopError(
					"InvalidCoordinateFrame",
					`no capture of '${target}' yet — take a screenshot of this target first`,
				);
			}
		}

		#ensureForeground(options) {
			if (options?.deliveryMode !== undefined && options.deliveryMode !== "foreground") {
				throw desktopError(
					"BackgroundUnavailable",
					"the installed native addon supports foreground input only",
				);
			}
		}

		async #execute(action, target, fallbackCode = "InputFailed") {
			try {
				await this.#native.execute([action], target);
			} catch (error) {
				throw normalizeError(error, fallbackCode);
			}
		}

		async listDisplays() {
			this.#ensureOpen();
			throw desktopError("CaptureFailed", "the installed native addon does not expose display enumeration");
		}

		async listWindows() {
			this.#ensureOpen();
			if (typeof this.#native.listWindows !== "function") {
				throw desktopError("CaptureFailed", "the installed native addon does not expose window enumeration");
			}
			try {
				return await this.#native.listWindows();
			} catch (error) {
				throw normalizeError(error, "CaptureFailed");
			}
		}

		async capture(target, caps) {
			this.#ensureOpen();
			if (target !== "desktop" && !/^\d+$/.test(target)) {
				throw desktopError("InvalidTarget", `invalid window target '${target}'`);
			}
			if (target !== "desktop" && typeof this.#native.listWindows !== "function") {
				throw desktopError("CaptureFailed", "the installed native addon does not support window capture");
			}
			try {
				const capture = await this.#native.capture(target);
				this.#capturedTargets.add(target);
				return {
					...capture,
					sourceWidth: capture.sourceWidth ?? capture.width,
					sourceHeight: capture.sourceHeight ?? capture.height,
					target,
				};
			} catch (error) {
				throw normalizeError(error, "CaptureFailed");
			}
		}

		async click(target, x, y, options) {
			this.#ensureOpen();
			this.#ensureCaptured(target);
			this.#ensureForeground(options);
			const count = options?.count ?? 1;
			const type = count === 2 && (options?.button ?? "left") === "left" ? "double_click" : "click";
			const action = {
				type,
				x: Math.round(x),
				y: Math.round(y),
				keys: options?.modifiers ?? [],
			};
			if (type === "click") action.button = options?.button ?? "left";
			await this.#execute(action, target);
		}

		async moveMouse(target, x, y, options) {
			this.#ensureOpen();
			this.#ensureCaptured(target);
			this.#ensureForeground(options);
			await this.#execute({ type: "move", x: Math.round(x), y: Math.round(y), keys: options?.modifiers ?? [] }, target);
		}

		async drag(target, path, options) {
			this.#ensureOpen();
			this.#ensureCaptured(target);
			this.#ensureForeground(options);
			await this.#execute({ type: "drag", path: path.map(legacyPoint), keys: options?.modifiers ?? [] }, target);
		}

		async scroll(target, x, y, dx, dy, options) {
			this.#ensureOpen();
			this.#ensureCaptured(target);
			this.#ensureForeground(options);
			await this.#execute(
				{
					type: "scroll",
					x: Math.round(x),
					y: Math.round(y),
					scroll_x: Math.round(dx),
					scroll_y: Math.round(dy),
					keys: options?.modifiers ?? [],
				},
				target,
			);
		}

		async typeText(target, text, options) {
			this.#ensureOpen();
			this.#ensureForeground(options);
			await this.#execute({ type: "type", text }, target);
		}

		async keyChord(target, keys, options) {
			this.#ensureOpen();
			this.#ensureForeground(options);
			await this.#execute({ type: "keypress", keys }, target);
		}

		async raiseWindow() {
			this.#ensureOpen();
			throw desktopError("BackgroundUnavailable", "the installed native addon does not support window control");
		}

		async axSnapshot() {
			this.#ensureOpen();
			throw desktopError("AxUnsupported", "accessibility is unavailable in the installed native addon");
		}

		async axQuery() {
			return this.axSnapshot();
		}

		async axElementAt() {
			return this.axSnapshot();
		}

		async axFocused() {
			return this.axSnapshot();
		}

		async axNode() {
			return this.axSnapshot();
		}

		async axAttributes() {
			return this.axSnapshot();
		}

		async axChildren() {
			return this.axSnapshot();
		}

		async axParent() {
			return this.axSnapshot();
		}

		async axPerform() {
			return this.axSnapshot();
		}

		async axSetValue() {
			return this.axSnapshot();
		}

		async axFocus() {
			return this.axSnapshot();
		}

		async axClick() {
			return this.axSnapshot();
		}

		async close() {
			if (this.#closed) return;
			this.#closed = true;
			try {
				await this.#native.close();
			} catch (error) {
				throw normalizeError(error, "Internal");
			}
		}
	}

	ADAPTED_SESSION_CLASSES.set(NativeDesktopSession, DesktopSession);
	return DesktopSession;
}
