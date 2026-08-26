import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("prepared extension rebinding", () => {
	it("binds a fresh session extension without evaluating the module again", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepared-extension-"));
		temporaryDirectories.push(directory);
		const extensionPath = path.join(directory, "counter.ts");
		const counterKey = `__omp_prepared_extension_${crypto.randomUUID().replaceAll("-", "")}`;
		await Bun.write(
			extensionPath,
			`Reflect.set(globalThis, ${JSON.stringify(counterKey)}, Number(Reflect.get(globalThis, ${JSON.stringify(counterKey)}) ?? 0) + 1);\nexport default function counterExtension() {}\n`,
		);

		const parent = await loadExtensions([extensionPath], directory);
		const prepared = parent.preparedExtensions;
		expect(prepared).toHaveLength(1);
		expect(Reflect.get(globalThis, counterKey)).toBe(1);

		const child = await bindPreparedExtensions(prepared ?? [], directory);

		expect(Reflect.get(globalThis, counterKey)).toBe(1);
		expect(child.extensions).toHaveLength(1);
		expect(child.extensions[0]).not.toBe(parent.extensions[0]);
		expect(child.runtime).not.toBe(parent.runtime);
	});
});
