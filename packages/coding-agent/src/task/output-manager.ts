/**
 * Session-scoped manager for agent output IDs.
 *
 * Keeps every subagent output id unique within a session without polluting the
 * common case with bookkeeping. A requested name is used verbatim the first
 * time it appears; only a *repeated* name gets a numeric suffix to disambiguate
 * it (e.g. "Anna", "Anna-2", "Anna-3"). When a parent prefix is configured, ids
 * are nested under it (e.g. "Anna.Bob") so hierarchical outputs stay grouped.
 *
 * This enables reliable agent:// URL resolution and prevents artifact
 * collisions across repeated or nested task invocations.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ADVISOR_TRANSCRIPT_STEM } from "../advisor/transcript-recorder";

/**
 * Receipt for a subagent output artifact that was written **and read back**.
 *
 * Existence of a receipt is the only proof a parent has that `uri` resolves:
 * the executor writes `<id>.md`, reads the bytes back off disk, and hashes
 * them. A silent write failure (full disk, evicted temp dir, racing cleanup)
 * therefore yields no receipt instead of a pointer to a missing file.
 */
export interface AgentOutputArtifact {
	/** Internal URL that resolves to the verified file (`agent://<id>`). */
	readonly uri: string;
	/** Absolute path of the verified `<id>.md`. */
	readonly path: string;
	/** SHA-256 of the bytes on disk, lowercase hex. */
	readonly sha256: string;
	/** Byte length on disk. */
	readonly bytes: number;
	/** Line count of the written text. */
	readonly lineCount: number;
	/** UTF-16 length of the written text. */
	readonly charCount: number;
}

/** Outcome of {@link writeVerifiedAgentOutput}: a receipt, or why there is none. */
export type AgentOutputWriteResult =
	| { readonly ok: true; readonly artifact: AgentOutputArtifact }
	| { readonly ok: false; readonly error: string };

/**
 * Write `<artifactsDir>/<id>.md` and verify it by reading the bytes back and
 * comparing length + SHA-256 against what was meant to land there.
 *
 * Callers MUST treat a non-`ok` result as "no artifact exists": advertising
 * the path anyway is what let a completed task point at an unreadable file
 * (issue #9646).
 */
export async function writeVerifiedAgentOutput(
	artifactsDir: string,
	id: string,
	text: string,
): Promise<AgentOutputWriteResult> {
	const target = path.join(artifactsDir, `${id}.md`);
	const expected = Buffer.from(text, "utf8");
	try {
		await Bun.write(target, expected);
		const actual = await Bun.file(target).bytes();
		const sha256 = new Bun.CryptoHasher("sha256").update(actual).digest("hex");
		const expectedSha256 = new Bun.CryptoHasher("sha256").update(expected).digest("hex");
		if (actual.byteLength !== expected.byteLength || sha256 !== expectedSha256) {
			return {
				ok: false,
				error: `artifact readback mismatch for ${id}.md (wrote ${expected.byteLength} bytes, read ${actual.byteLength})`,
			};
		}
		return {
			ok: true,
			artifact: {
				uri: `agent://${id}`,
				path: target,
				sha256,
				bytes: actual.byteLength,
				lineCount: text.split("\n").length,
				charCount: text.length,
			},
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Manages agent output ID allocation to ensure uniqueness.
 *
 * The first allocation of a given name keeps the name as-is; subsequent
 * allocations of the same name get a `-2`, `-3`, … suffix. On resume, scans
 * existing output and child-session files so prior state is never overwritten.
 */
export class AgentOutputManager {
	#initialized = false;
	#initializing: Promise<void> | undefined;
	/** Final ids already handed out, relative to this manager's scope. */
	readonly #taken = new Set<string>();
	readonly #getArtifactsDir: () => string | null;
	readonly #parentPrefix: string | undefined;

	constructor(getArtifactsDir: () => string | null, options?: { parentPrefix?: string }) {
		this.#getArtifactsDir = getArtifactsDir;
		this.#parentPrefix = options?.parentPrefix;
		// Reserve the advisor transcript stem: a subagent allocated this id would
		// write `<id>.jsonl`, clobbering the advisor's `__advisor.jsonl` in the same
		// artifacts dir. Reserving bumps such a request to `__advisor-2`.
		this.#taken.add(ADVISOR_TRANSCRIPT_STEM);
	}

	/**
	 * Seed the taken-id set from output files already on disk so a resumed
	 * session never reuses a name that would clobber a prior subagent's output.
	 */
	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		this.#initializing ??= this.#seedFromDisk();
		await this.#initializing;
		this.#initialized = true;
	}

	async #seedFromDisk(): Promise<void> {
		const dir = this.#getArtifactsDir();
		if (!dir) return;

		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return; // Directory doesn't exist yet
		}

		const prefix = this.#parentPrefix ? `${this.#parentPrefix}.` : "";
		for (const file of files) {
			const extension = file.endsWith(".jsonl") ? ".jsonl" : file.endsWith(".md") ? ".md" : undefined;
			if (!extension) continue;
			let rest = file.slice(0, -extension.length);
			if (prefix) {
				if (!rest.startsWith(prefix)) continue;
				rest = rest.slice(prefix.length);
			}
			// Requested ids never contain "."; a dot marks a nested child, so this
			// manager only owns the first segment of whatever remains.
			const dot = rest.indexOf(".");
			const segment = dot === -1 ? rest : rest.slice(0, dot);
			if (segment) this.#taken.add(segment);
		}
	}

	/** Pick the first free name (base, then `base-2`, `base-3`, …) and reserve it. */
	#allocateUnique(id: string): string {
		let candidate = id;
		for (let n = 2; this.#taken.has(candidate); n++) {
			candidate = `${id}-${n}`;
		}
		this.#taken.add(candidate);
		return this.#parentPrefix ? `${this.#parentPrefix}.${candidate}` : candidate;
	}

	/** Reserve final IDs discovered outside the output directory scan. */
	async reserve(ids: Iterable<string>): Promise<void> {
		await this.#ensureInitialized();
		const prefix = this.#parentPrefix ? `${this.#parentPrefix}.` : "";
		for (const id of ids) {
			let rest = id;
			if (prefix) {
				if (!rest.startsWith(prefix)) continue;
				rest = rest.slice(prefix.length);
			}
			const dot = rest.indexOf(".");
			const segment = dot === -1 ? rest : rest.slice(0, dot);
			if (segment) this.#taken.add(segment);
		}
	}

	/**
	 * Allocate a unique ID.
	 *
	 * @param id Requested ID (e.g., "Anna")
	 * @returns Unique ID ("Anna" first, then "Anna-2", "Anna-3", …)
	 */
	async allocate(id: string): Promise<string> {
		await this.#ensureInitialized();
		return this.#allocateUnique(id);
	}
}
