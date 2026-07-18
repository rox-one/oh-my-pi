import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport, re-rendering at
 *   the current width every frame (so resizes reflow it) until capacity
 *   pressure retires it.
 * - `committed`: appended to terminal history; immutable and never re-rendered.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
}

type OfferedKind = "commit" | "replay";
type RetirementPolicy = "pressure" | "flush";

interface Replay {
	cursor: number;
	end: number;
}

const MAX_LIVE_BLOCKS = 256;
const EMPTY_ROWS: readonly string[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: { batch: HistoryBatch; end: number; kind: OfferedKind } | undefined;
	#replay: Replay | undefined;
	#replayRequested = false;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };

	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({ component, state: "active" });
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0) return;
		if (!this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replay = undefined;
		this.#replayRequested = false;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	override prepareNativeScrollbackReplay(): void {
		// Replay retires the old terminal tape, so descendants may discard layout
		// locks whose only purpose was keeping that immutable history byte-stable.
		super.prepareNativeScrollbackReplay();
		// The next compose must paint the COMPLETE frame onto the freshly cleared
		// tape, so suppress its committed-prefix compaction unconditionally — even
		// when nothing has been compacted yet (#compactedChildStart === 0). The
		// pre-clear commit boundary still points at rows the ED3 just erased;
		// letting compaction run against that stale #committedRows would drop the
		// leading finalized blocks from the very frame meant to reprint them,
		// leaving them on neither the tape nor the frame until the next replay
		// (the resume-paint transcript-vanish, issue #5990). Rehydrating already
		// compacted children additionally rewinds #compactedChildStart and clears
		// the assembled rows so the whole history recomposes.
		this.#replayPending = true;
		if (this.#compactedChildStart === 0) return;
		this.#compactedChildStart = 0;
		this.#generation++;
		this.#lines.length = 0;
		this.#stableRowsFloor = 0;
	}

	getRenderStablePrefixRows(): number {
		const value = Math.min(this.#stableRowsFloor, this.#lines.length);
		this.#stableRowsFloor = this.#lines.length;
		return value;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	/**
	 * Whether none of `component`'s rows (per the most recent render) have
	 * entered native scrollback. Callers that retract ephemeral blocks (IRC
	 * cards, displaceable todo/job snapshots) must check this: removing a
	 * block whose rows are already on the tape is an interior deletion of
	 * committed history the engine cannot express — the block must be sealed
	 * in place as history instead. A component that has never rendered has no
	 * committed rows and is safely removable.
	 */
	isBlockUncommitted(component: Component): boolean {
		const index = this.children.indexOf(component);
		// Compacted prefix is already committed native history and must not be
		// retracted. Compacted slots may be sparse holes after a later re-render
		// (render only fills from #compactedChildStart), so the loop below must
		// skip undefined entries.
		if (index >= 0 && index < this.#compactedChildStart) return false;
		for (const segment of this.#segments) {
			if (segment === undefined || segment.component !== component) continue;
			return segment.rowCount === 0 || segment.startRow >= this.#committedRows;
		}
		return true;
	}

	/**
	 * Whether `component` is inside the live (repaintable) region exactly as
	 * {@link render} computes it: at/after the first still-mutating block, or
	 * the transcript tail when every block has finalized. Self-animating
	 * finalized blocks (a detached task's shimmering progress rows) poll this
	 * to stop animating — and settle on static bytes — the moment they sit
	 * above the seam, where their rows become commit-eligible native-scrollback
	 * history.
	 */
	isBlockInLiveRegion(component: Component): boolean {
		const children = this.children;
		const index = children.indexOf(component);
		if (index < 0) return false;
		if (this.#entries[index]!.state === "committed") return false;
		return this.#offered === undefined || index >= this.#offered.end;
	}
	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Replays the immutable committed prefix without changing lifecycle state. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#startReplay();
	}

	/** Total rows the live (non-committed, non-offered) tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const rendered of this.#liveBlocks(width)) {
			if (rendered.length > 0) total += rendered.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#syncEntries();
		this.#settleFinalized();
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) return EMPTY_ROWS;

		// Full-height pass first: measure every live block whole. Empty blocks
		// (hidden tool activity under display.hideToolActivity, content-less
		// streaming blocks) occupy no viewport rows, so they are dropped here and
		// never reach the pressure/emergency paths — otherwise they would reserve
		// a base row (over-truncating real text) or emit a blank row per block.
		const shown: TranscriptEntry[] = [];
		const blocks: (readonly string[])[] = [];
		let total = 0;
		for (const entry of live) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, frame);
			const rendered = trimBlankEdges(entry.component.render(width));
			if (rendered.length === 0) continue;
			total += rendered.length + (shown.length > 0 ? 1 : 0);
			shown.push(entry);
			blocks.push(rendered);
		}
		if (shown.length === 0) return EMPTY_ROWS;
		if (shown.length > capacity) return this.#renderEmergency(shown, width, capacity, frame);
		if (total <= capacity) {
			const output: string[] = [];
			for (const rendered of blocks) {
				if (output.length > 0) output.push("");
				output.push(...rendered);
			}
			return output;
		}

		// Pressure: one row minimum per block, surplus to the newest blocks first,
		// separators dropped. Tool blocks re-render compact below three rows; text
		// blocks keep their latest rows visible.
		const allocation: number[] = new Array(shown.length).fill(1);
		let surplus = capacity - shown.length;
		for (let index = shown.length - 1; index >= 0 && surplus > 0; index--) {
			const extra = Math.min(Math.max(0, blocks[index]!.length - 1), surplus);
			allocation[index] += extra;
			surplus -= extra;
		}
		const output: string[] = [];
		for (let index = 0; index < shown.length; index++) {
			const allocated = allocation[index]!;
			this.#setAllocation(shown[index]!.component, allocated, frame);
			const rendered = trimBlankEdges(shown[index]!.component.render(width));
			if (rendered.length <= allocated) output.push(...rendered);
			else output.push(...rendered.slice(rendered.length - allocated));
		}
		return output.length > capacity ? output.slice(output.length - capacity) : output;
	}

	/**
	 * Offers the shortest finalized prefix needed to restore live capacity.
	 * The offer stands until the terminal acknowledges it.
	 */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		if (this.#replay !== undefined) {
			const start = this.#replay.cursor;
			const end = Math.min(start + 1, this.#replay.end);
			const batch: HistoryBatch = { id: this.#nextBatchId++, rows: this.#renderRange(start, end, width) };
			this.#offered = { batch, end, kind: "replay" };
			return batch;
		}
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			this.#setAllocation(live[index]!.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = trimBlankEdges(live[index]!.component.render(width));
			heights[index] = rendered.length;
			if (rendered.length > 0) total += rendered.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) return undefined;
		// Retire the longest settled prefix needed to fit; commit order is
		// absolute, so retirement stops at the first still-active block.
		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) return undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width),
		};
		this.#offered = { batch, end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered commit or replay batch. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#entries[index]!.state = "committed";
			}
			this.#frontier = offered.end;
		} else {
			const replay = this.#replay;
			if (replay === undefined || offered.end > replay.end) return;
			replay.cursor = offered.end;
			if (replay.cursor === replay.end) this.#replay = undefined;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.#startReplay();
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		return rows;
	}

	#renderRange(start: number, end: number, width: number): readonly string[] {
		const rows: string[] = [];
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...block);
		}
		if (rows.length > 0) rows.push("");
		return rows;
	}

	#startReplay(): void {
		const end = this.#frontier;
		this.#replay = end > 0 ? { cursor: 0, end } : undefined;
		this.#replayRequested = false;
	}

	#renderEmergency(
		shown: readonly TranscriptEntry[],
		width: number,
		rows: number,
		frame: AnimationFrame,
	): readonly string[] {
		const output: string[] = [];
		const hiddenCount = Math.max(0, shown.length - rows);
		let hiddenActive = 0;
		for (let index = 0; index < hiddenCount; index++) {
			if (shown[index]!.state === "active") hiddenActive++;
		}
		if (hiddenActive > 0) output.push(`${hiddenActive} more transcript blocks active`);
		const visibleRows = rows - output.length;
		const visible = visibleRows > 0 ? shown.slice(-visibleRows) : [];
		// Callers pass only non-empty blocks; trim residual edge blanks so each
		// block contributes its first real row instead of a reserved blank.
		for (const entry of visible) {
			this.#setAllocation(entry.component, 1, frame);
			output.push(trimBlankEdges(entry.component.render(width))[0] ?? "");
		}
		return output.slice(0, rows);
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	/** Live entries exclude an offered commit but never an independent replay. */
	#liveEntries(): TranscriptEntry[] {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		return this.#entries.slice(start);
	}

	*#liveBlocks(width: number): Generator<readonly string[]> {
		for (const entry of this.#liveEntries()) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			yield trimBlankEdges(entry.component.render(width));
		}
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
