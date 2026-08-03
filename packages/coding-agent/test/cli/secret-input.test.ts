import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
	promptSecretInput,
	SecretInputCancelledError,
	type SecretInputOutput,
	SecretInputUnavailableError,
} from "@oh-my-pi/pi-coding-agent/cli/secret-input";

interface FakeInput {
	stream: PassThrough & NodeJS.ReadStream;
	rawModes: boolean[];
	getRawMode(): boolean;
}

function createInput(options: { isTTY?: boolean; initiallyRaw?: boolean; failRawMode?: boolean } = {}): FakeInput {
	const stream = new PassThrough() as PassThrough & NodeJS.ReadStream;
	const rawModes: boolean[] = [];
	let rawMode = options.initiallyRaw ?? false;
	Object.defineProperty(stream, "isTTY", { value: options.isTTY ?? true });
	Object.defineProperty(stream, "isRaw", { get: () => rawMode });
	stream.setRawMode = (mode: boolean) => {
		rawModes.push(mode);
		if (mode && options.failRawMode) throw new Error("raw mode denied");
		rawMode = mode;
		return stream;
	};
	return { stream, rawModes, getRawMode: () => rawMode };
}

function createOutput(): SecretInputOutput & { text: string } {
	return {
		text: "",
		write(text: string) {
			this.text += text;
			return true;
		},
	};
}

function press(input: NodeJS.ReadStream, text: string | undefined, key: Record<string, unknown>): void {
	input.emit("keypress", text, key);
}

describe("promptSecretInput", () => {
	it("rejects when raw-mode echo suppression is unavailable", async () => {
		const input = createInput({ isTTY: false });
		const output = createOutput();

		await expect(promptSecretInput("Token: ", { input: input.stream, output })).rejects.toBeInstanceOf(
			SecretInputUnavailableError,
		);
		expect(output.text).toBe("");
		expect(input.rawModes).toEqual([]);
	});

	it("fails closed when another listener can consume the input bytes", async () => {
		for (const event of ["data", "keypress", "readable"] as const) {
			const input = createInput();
			const output = createOutput();
			const listener = () => {};
			input.stream.on(event, listener);

			await expect(promptSecretInput("Token: ", { input: input.stream, output })).rejects.toBeInstanceOf(
				SecretInputUnavailableError,
			);
			expect(output.text).toBe("");
			expect(input.rawModes).toEqual([]);
			input.stream.off(event, listener);
		}
	});

	it("reports raw-mode activation failures as unavailable confidential input", async () => {
		const input = createInput({ failRawMode: true });
		const output = createOutput();

		await expect(promptSecretInput("Token: ", { input: input.stream, output })).rejects.toBeInstanceOf(
			SecretInputUnavailableError,
		);
		expect(output.text).toBe("");
		expect(input.rawModes).toEqual([true, false]);
	});

	it("collects a line without echoing it and restores terminal state", async () => {
		const input = createInput();
		const output = createOutput();
		const result = promptSecretInput("Token: ", { input: input.stream, output });

		press(input.stream, "secx", {});
		press(input.stream, undefined, { name: "backspace" });
		press(input.stream, "ret", {});
		press(input.stream, "\r", { name: "return" });

		await expect(result).resolves.toBe("secret");
		expect(output.text).toBe("Token: \n");
		expect(output.text).not.toContain("secret");
		expect(input.rawModes).toEqual([true, false]);
		expect(input.getRawMode()).toBe(false);
		expect(input.stream.isPaused()).toBe(true);
	});

	it("rejects concurrent prompts on one stream and releases ownership after completion", async () => {
		const input = createInput();
		const firstOutput = createOutput();
		const secondOutput = createOutput();
		const first = promptSecretInput("First: ", { input: input.stream, output: firstOutput });
		const second = promptSecretInput("Second: ", { input: input.stream, output: secondOutput });

		await expect(second).rejects.toBeInstanceOf(SecretInputUnavailableError);
		expect(secondOutput.text).toBe("");
		input.stream.write("secret\r");
		await expect(first).resolves.toBe("secret");
		expect(input.rawModes).toEqual([true, false]);
		expect(input.getRawMode()).toBe(false);
		expect(input.stream.listenerCount("data")).toBe(0);

		const retry = promptSecretInput("Retry: ", { input: input.stream, output: secondOutput });
		input.stream.write("next\r");
		await expect(retry).resolves.toBe("next");
		expect(input.rawModes).toEqual([true, false, true, false]);
		expect(input.getRawMode()).toBe(false);
		expect(input.stream.listenerCount("data")).toBe(0);
	});

	it("restores an input that was already in raw mode", async () => {
		const input = createInput({ initiallyRaw: true });
		const output = createOutput();
		const result = promptSecretInput("Secret: ", { input: input.stream, output });

		press(input.stream, "value", {});
		press(input.stream, "\r", { name: "return" });

		await expect(result).resolves.toBe("value");
		expect(input.rawModes).toEqual([true, true]);
		expect(input.getRawMode()).toBe(true);
	});

	it("cancels on Ctrl-C without exposing the partial value", async () => {
		const input = createInput();
		const output = createOutput();
		const result = promptSecretInput("Secret: ", { input: input.stream, output });

		press(input.stream, "partial", {});
		press(input.stream, "\u0003", { ctrl: true, name: "c" });

		await expect(result).rejects.toBeInstanceOf(SecretInputCancelledError);
		expect(output.text).toBe("Secret: \n");
		expect(output.text).not.toContain("partial");
		expect(input.getRawMode()).toBe(false);
	});

	it("restores terminal state when the input reaches EOF or errors", async () => {
		for (const event of ["end", "close", "error"] as const) {
			const input = createInput();
			const output = createOutput();
			const result = promptSecretInput("Secret: ", { input: input.stream, output });
			if (event === "error") input.stream.emit(event, new Error("input failed"));
			else input.stream.emit(event);

			await expect(result).rejects.toThrow(event === "error" ? "input failed" : "ended before submission");
			expect(input.getRawMode()).toBe(false);
			expect(input.rawModes).toEqual([true, false]);
		}
	});

	it("restores terminal state when an AbortSignal cancels the prompt", async () => {
		const input = createInput();
		const output = createOutput();
		const controller = new AbortController();
		const result = promptSecretInput("Secret: ", { input: input.stream, output, signal: controller.signal });

		press(input.stream, "partial", {});
		controller.abort(new Error("operation cancelled"));

		await expect(result).rejects.toThrow("operation cancelled");
		expect(output.text).not.toContain("partial");
		expect(input.getRawMode()).toBe(false);
	});

	it("restores raw mode when writing the prompt fails", async () => {
		const input = createInput();
		let writes = 0;
		const result = promptSecretInput("Secret: ", {
			input: input.stream,
			output: {
				write() {
					writes++;
					throw new Error("output failed");
				},
			},
		});

		await expect(result).rejects.toThrow("output failed");
		expect(writes).toBe(2);
		expect(input.getRawMode()).toBe(false);
	});
});
