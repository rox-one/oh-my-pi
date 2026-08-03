const activeSecretInputs = new WeakSet<NodeJS.ReadStream>();
const inputsAwaitingLineFeed = new WeakSet<NodeJS.ReadStream>();
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Writable terminal surface used by {@link promptSecretInput}. */
export interface SecretInputOutput {
	write(text: string): unknown;
}

/** Options for reading one confidential line from a terminal. */
export interface SecretInputOptions {
	/** TTY to read from. Defaults to `process.stdin`. */
	input?: NodeJS.ReadStream;
	/** Destination for the prompt and trailing newline. Defaults to `process.stdout`. */
	output?: SecretInputOutput;
	/** Cancels the pending prompt without exposing the partially entered value. */
	signal?: AbortSignal;
}

/** Raised when the input stream cannot disable terminal echo. */
export class SecretInputUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("Confidential input requires a TTY with raw-mode support", options);
		this.name = "SecretInputUnavailableError";
	}
}

/** Raised when confidential input is cancelled before submission. */
export class SecretInputCancelledError extends Error {
	constructor() {
		super("Confidential input cancelled");
		this.name = "SecretInputCancelledError";
	}
}

/**
 * Read one confidential line without echoing entered characters.
 *
 * The input must be a real TTY with raw-mode support and no existing data,
 * keypress, or readable listeners. This exclusive-ownership requirement keeps
 * other application consumers from receiving the cleartext bytes. The helper
 * also rejects concurrent prompts on the same stream and never falls back to
 * an echoed readline prompt. Enter submits, Backspace edits, and Ctrl-C or
 * Escape cancels. Cleanup restores the original raw mode and does not leave a
 * previously non-flowing input stream flowing.
 */
export function promptSecretInput(prompt: string, options: SecretInputOptions = {}): Promise<string> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const { signal } = options;

	if (input.isTTY !== true || typeof input.setRawMode !== "function") {
		return Promise.reject(new SecretInputUnavailableError());
	}
	if (input.readableEncoding !== null) {
		return Promise.reject(
			new SecretInputUnavailableError({
				cause: new Error("Confidential input requires a byte-mode input stream"),
			}),
		);
	}
	if (signal?.aborted) {
		return Promise.reject(signal.reason ?? new SecretInputCancelledError());
	}
	if (
		activeSecretInputs.has(input) ||
		input.listenerCount("data") > 0 ||
		input.listenerCount("keypress") > 0 ||
		input.listenerCount("readable") > 0
	) {
		return Promise.reject(
			new SecretInputUnavailableError({
				cause: new Error("Confidential input requires exclusive ownership of the input stream"),
			}),
		);
	}

	activeSecretInputs.add(input);
	const suppressBufferedLineFeed = inputsAwaitingLineFeed.has(input) && input.readableLength > 0;
	inputsAwaitingLineFeed.delete(input);

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	{
		const wasRaw = input.isRaw === true;
		const wasFlowing = input.readableFlowing === true;
		const decoder = new TextDecoder();
		let rawModeTouched = false;
		let promptStarted = false;
		let settled = false;
		let awaitingBufferedLineFeed = suppressBufferedLineFeed;
		let value = "";

		const cleanup = (): unknown => {
			input.off("data", onData);
			input.off("error", onError);
			input.off("end", onEnd);
			input.off("close", onEnd);
			signal?.removeEventListener("abort", onAbort);

			let cleanupError: unknown;
			if (rawModeTouched) {
				try {
					input.setRawMode(wasRaw);
				} catch (error) {
					cleanupError = error;
				}
			}
			if (!wasFlowing) input.pause();
			activeSecretInputs.delete(input);
			return cleanupError;
		};

		const finish = (result: { value: string } | { error: unknown }): void => {
			if (settled) return;
			settled = true;
			const cleanupError = cleanup();
			try {
				if (promptStarted) output.write("\n");
			} catch (error) {
				value = "";
				reject(cleanupError ?? error);
				return;
			}
			if ("error" in result && result.error instanceof SecretInputUnavailableError) {
				value = "";
				reject(result.error);
				return;
			}
			if (cleanupError !== undefined) {
				value = "";
				reject(cleanupError);
				return;
			}
			if ("error" in result) {
				value = "";
				reject(result.error);
				return;
			}
			value = "";
			resolve(result.value);
		};

		function onData(chunk: Buffer | string): void {
			const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			const characters = Array.from(text);
			for (let index = 0; index < characters.length; index++) {
				const character = characters[index]!;
				if (settled) return;
				if (awaitingBufferedLineFeed) {
					awaitingBufferedLineFeed = false;
					if (character === "\n") continue;
				}
				if (character === "\r") {
					if (characters[index + 1] !== "\n") inputsAwaitingLineFeed.add(input);
					finish({ value });
					return;
				}
				if (character === "\n") {
					finish({ value });
					return;
				}
				if (character === "\b" || character === "\u007f") {
					const graphemes = Array.from(graphemeSegmenter.segment(value));
					value = value.slice(0, graphemes.at(-1)?.index ?? 0);
					continue;
				}
				if (character === "\u001b" || character === "\u0003") {
					finish({ error: new SecretInputCancelledError() });
					return;
				}
				if (character === "\u0004") {
					finish({ error: new Error("Confidential input ended before submission") });
					return;
				}
				if (character < " ") continue;
				value += character;
			}
		}

		function onError(error: Error): void {
			finish({ error });
		}

		function onEnd(): void {
			finish({ error: new Error("Confidential input ended before submission") });
		}

		function onAbort(): void {
			finish({ error: signal?.reason ?? new SecretInputCancelledError() });
		}

		try {
			input.on("data", onData);
			input.once("error", onError);
			input.once("end", onEnd);
			input.once("close", onEnd);
			signal?.addEventListener("abort", onAbort, { once: true });
			rawModeTouched = true;
			try {
				input.setRawMode(true);
			} catch (cause) {
				finish({ error: new SecretInputUnavailableError({ cause }) });
			}
			if (!settled) {
				input.resume();
				promptStarted = true;
				output.write(prompt);
			}
		} catch (error) {
			finish({ error });
		}
	}
	return promise;
}
