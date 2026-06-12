import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { copyFastembedNativeAssets } from "../scripts/bundle-dist";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("bundle-dist native assets", () => {
	test("copies fastembed's nested ONNX napi-v3 binding where the bundled require resolves", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bundle-assets-"));
		tempDirs.push(tempDir);

		const assets = await copyFastembedNativeAssets(tempDir);
		const sourceBinding = path.join(assets.sourceDir, process.platform, process.arch, "onnxruntime_binding.node");
		const copiedBinding = path.join(assets.outputDir, process.platform, process.arch, "onnxruntime_binding.node");
		const sourceStat = await fs.stat(sourceBinding);
		const copiedStat = await fs.stat(copiedBinding);

		expect(assets.outputDir).toBe(path.join(tempDir, "bin", "napi-v3"));
		expect(copiedStat.size).toBe(sourceStat.size);
	});
});
