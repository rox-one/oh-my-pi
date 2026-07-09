import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const EMPTY_HTML_COMMENT_SEPARATOR = /^\s*<!--[\s-]*-->\s*$/;

function stripEmptyHtmlCommentSeparators(text: string): string {
	if (!text.includes("<!--")) return text;
	const lines = text.split("\n");
	const resultLines: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!EMPTY_HTML_COMMENT_SEPARATOR.test(line)) {
			resultLines.push(line);
			continue;
		}
		const prevBlank = resultLines.length > 0 && resultLines[resultLines.length - 1]!.trim() === "";
		const nextBlank = i + 1 < lines.length && lines[i + 1]!.trim() === "";
		if ((prevBlank || resultLines.length === 0) && nextBlank) i += 1;
	}
	return resultLines.join("\n");
}

// Single-entry memo for the proseOnly formatting path. During a streaming tick
// the same growing thinking text is formatted up to three times (reveal count,
// reveal slice, component render); this collapses them to one computation. The
// non-prose branch skips code-fence elision and never consults the cache. A
// single entry is enough for the common case of one active thinking block and
// never regresses (a miss recomputes exactly as before).
let formatCacheKey = "";
let formatCacheValue = "";

export function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return trimmed;
		}
	}
	return "";
}

/**
 * Resume cap: a trailing partial line longer than this retires the fold
 * checkpoint. With no newline the seam sits at byte 0, so resuming would
 * refold the entire text every tick — O(total)/tick, O(n²) per stream. Past
 * the cap the slot falls back to the exact-key memo: O(1) on exact repeats,
 * a full recompute on growth (the pre-incremental asymptotics for this
 * pathological shape, bounded per call).
 */
const MAX_RESUME_PARTIAL_BYTES = 8192;

// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as a `<!--` delta followed by
// ` -->`. Comments with actual content are left untouched.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;
const FENCE = /^( {0,3})([`~]{3,})/;

/**
 * Whether `line` is reasoning-summary comment noise: an empty HTML comment,
 * or its still-unterminated `<!--` prefix on the last line while streaming.
 */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

/**
 * Whether `text` is an append of the previously formatted text: the stored
 * text must be a verbatim prefix of `text`. Verified exactly with
 * `startsWith` — its intrinsic compare runs at memcmp speed, and every byte
 * of the previous text is checked, leaving no gap a stream switch could hide
 * in (spot-check anchors were exploitable: texts crafted to match only at
 * the sampled positions slipped through as false-positive appends). This
 * reads O(previous text) per genuinely-new text; the repeated renders of one
 * streaming tick never reach here — the identity memo answers them first.
 */
function isAppend(cache: DisplayCache, text: string): boolean {
	const prev = cache.text;
	return prev.length > 0 && text.startsWith(prev);
}

/** Fold one input line into the accumulator. Whitespace-only lines defer to the tail region. */
function pushFoldLine(state: FoldState, line: string): void {
	state.emitted++;
	if (line.trim() === "") {
		// Blank lines are kept verbatim (a `" "` line still renders its space);
		// they just never become the prose ellipsis target.
		if (state.hasTail) state.tailBlankSep += `\n${line}`;
		else state.committed += (state.emitted > 1 ? "\n" : "") + line;
		return;
	}
	if (state.hasTail) {
		state.committed += (state.tailPred ? "\n" : "") + state.tailLine + state.tailBlankSep;
		state.tailPred = true;
	} else {
		state.tailPred = state.emitted > 1;
	}
	state.tailLine = line;
	state.hasTail = true;
	state.tailBlankSep = "";
}

/** Prose-mode ellipsis: rewrite the last non-blank output line in place. */
function appendFoldEllipsis(state: FoldState): void {
	if (!state.hasTail) {
		pushFoldLine(state, "...");
		return;
	}
	const trimmed = state.tailLine.trimEnd();
	if (trimmed.endsWith("...")) {
		state.tailLine = trimmed;
	} else if (trimmed.endsWith(".")) {
		state.tailLine = `${trimmed.slice(0, -1)}...`;
	} else {
		state.tailLine = `${trimmed}...`;
	}
}

/** Materialize the folded output from the committed prefix and the tail region. */
function renderFold(state: FoldState): string {
	if (!state.hasTail) return state.committed;
	return state.committed + (state.tailPred ? "\n" : "") + state.tailLine + state.tailBlankSep;
}

/**
 * Thinking text prepared for display. Both modes drop empty `<!-- -->`
 * sentinel lines outside code fences (see {@link isCommentNoise}); prose-only
 * mode additionally elides fenced code down to a trailing ellipsis.
 */
export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	const cleanedText = stripEmptyHtmlCommentSeparators(text);
	if (!proseOnly || !cleanedText) return cleanedText;
	if (text === formatCacheKey) return formatCacheValue;

	const lines = cleanedText.split("\n");
	const resultLines: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	const FENCE = /^( {0,3})([`~]{3,})/;
	const EMPTY_HTML_COMMENT = /^\s*<!--\s*-->\s*$/;
	const hasRenderableLineAfter = (index: number): boolean => {
		for (let j = index + 1; j < lines.length; j++) {
			const next = lines[j]!;
			if (next.trim() === "" || EMPTY_HTML_COMMENT.test(next)) continue;
			return true;
		}
		return false;
	};

	let suppressBlankAfterComment = false;
	const appendEllipsis = () => {
		let lastLineIdx = resultLines.length - 1;
		while (lastLineIdx >= 0 && resultLines[lastLineIdx]!.trim() === "") {
			lastLineIdx--;
		}

		if (lastLineIdx >= 0) {
			const lastLine = resultLines[lastLineIdx]!;
			const trimmed = lastLine.trimEnd();
			if (trimmed.endsWith("...")) {
				resultLines[lastLineIdx] = trimmed;
			} else if (trimmed.endsWith(".")) {
				resultLines[lastLineIdx] = `${trimmed.slice(0, -1)}...`;
			} else {
				resultLines[lastLineIdx] = `${trimmed}...`;
			}
		} else {
			resultLines.push("...");
		}
	};

	const lines = text.slice(fromByte).split("\n");
	const last = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Freeze the resume state entering the final (possibly partial) line;
		// that line is re-folded from here on the next append.
		if (i === last) cache.state = { ...state };

		if (state.inFence) {
			const close = FENCE.exec(line);
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				close &&
				close[2]![0] === state.fenceChar &&
				close[2]!.length >= state.fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				state.inFence = false;
				state.fenceChar = "";
				state.fenceLen = 0;
			}
			suppressBlankAfterComment = false;
			// We skip all internal lines of a code fence.
		} else if (EMPTY_HTML_COMMENT.test(line)) {
			if (hasRenderableLineAfter(i)) {
				const last = resultLines[resultLines.length - 1];
				if (last !== undefined && last.trim() !== "") resultLines.push("");
			}
			suppressBlankAfterComment = true;
		} else if (suppressBlankAfterComment && line.trim() === "") {
		} else if (open) {
			suppressBlankAfterComment = false;
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				state.inFence = true;
				state.fenceChar = ch;
				state.fenceLen = marker.length;
				if (proseOnly) {
					appendFoldEllipsis(state);
				} else {
					pushFoldLine(state, line);
				}
				continue;
			}
		} else {
			suppressBlankAfterComment = false;
			resultLines.push(line);
		}
		pushFoldLine(state, line);
	}

	const formatted = renderFold(state);
	cache.text = text;
	cache.value = formatted;
	cache.hadComment = hasComment;
	cache.startLineByte = text.lastIndexOf("\n") + 1;
	// A trailing partial line past the cap means no newline ever arrived (the
	// seam sits at 0 and resuming would refold the whole text every tick).
	// Retire the checkpoint: later calls hit the identity memo on exact
	// repeats and recompute fully on growth — bounded per call.
	cache.resumable = text.length - cache.startLineByte <= MAX_RESUME_PARTIAL_BYTES;
	return formatted;
}

/** Whether a formatted thinking block has non-placeholder content worth rendering. */
export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text) return false;
	if (!formattedText) return false;
	return formattedText.length > 0 && canonicalizeMessage(stripEmptyHtmlCommentSeparators(text)).length > 0;
}

/** Whether an assistant message contains thinking content the TUI can reveal. */
export function messageHasDisplayableThinking(message: AgentMessage, proseOnly: boolean): boolean {
	if (message.role !== "assistant") return false;
	for (const content of message.content) {
		if (content.type !== "thinking") continue;
		if (hasDisplayableThinking(content.thinking, formatThinkingForDisplay(content.thinking, proseOnly))) {
			return true;
		}
	}
	return false;
}
