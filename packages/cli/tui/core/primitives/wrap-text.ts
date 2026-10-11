import { codePointWidth, visibleLength } from "./char-width.ts";

export interface LineWithOffset {
	line: string;
	startIndex: number;
}

interface Unit {
	/** Visible character. */
	char: string;
	/** Terminal cell width (0, 1, or 2). */
	width: number;
	/** Raw text for this unit, including any preceding SGR sequences. */
	raw: string;
	/** Index of the character in the original string (excluding escape sequences). */
	rawStart: number;
}

/**
 * Split a string into visible character units, keeping SGR escape sequences
 * attached to the following character so wrapping never splits a sequence.
 * Zero-width (combining) code points are merged into the previous unit.
 */
function tokenize(text: string): Unit[] {
	const units: Unit[] = [];
	let pendingAnsi = "";
	let i = 0;

	while (i < text.length) {
		const cp = text.codePointAt(i) ?? 0;

		if (cp === 0x1b && text[i + 1] === "[") {
			let j = i + 2;
			while (j < text.length && text[j] !== "m") j++;
			pendingAnsi += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}

		const ch = String.fromCodePoint(cp);
		const width = codePointWidth(cp);

		if (width === 0) {
			const prev = units[units.length - 1];
			if (prev) {
				prev.raw += `${pendingAnsi}${ch}`;
			} else {
				units.push({ char: ch, width: 0, raw: `${pendingAnsi}${ch}`, rawStart: i });
			}
		} else {
			units.push({ char: ch, width, raw: `${pendingAnsi}${ch}`, rawStart: i });
		}

		pendingAnsi = "";
		i += ch.length;
	}

	if (pendingAnsi && units.length > 0) {
		units[units.length - 1]!.raw += pendingAnsi;
	}

	return units;
}

function unitsToString(units: Unit[]): string {
	return units.map((u) => u.raw).join("");
}

function unitsWidth(units: Unit[]): number {
	return units.reduce((sum, u) => sum + u.width, 0);
}

/**
 * Wraps text to a specified visible width, preferring word boundaries and
 * preserving multiple/leading spaces. ANSI escape sequences are treated as
 * zero-width and never split. Returns each line with its starting character
 * index in the original string.
 */
export function wrapTextWithOffsets(text: string, width: number): LineWithOffset[] {
	if (width <= 0) return [];

	const units = tokenize(String(text || ""));
	if (units.length === 0) return [{ line: "", startIndex: 0 }];

	const lines: LineWithOffset[] = [];
	let line: Unit[] = [];
	let lineWidth = 0;
	/** Index in `line` immediately after the most recent space. */
	let breakIndex = -1;

	const emit = (lineUnits: Unit[]) => {
		if (lineUnits.length === 0) return;
		lines.push({ line: unitsToString(lineUnits), startIndex: lineUnits[0]!.rawStart });
	};

	let i = 0;
	while (i < units.length) {
		const unit = units[i]!;

		if (line.length > 0 && unit.width > 0 && lineWidth + unit.width > width) {
			if (breakIndex > 0) {
				let end = breakIndex;
				while (end > 0 && line[end - 1]!.char === " ") end--;
				emit(line.slice(0, end));
				line = line.slice(breakIndex);
				lineWidth = unitsWidth(line);
				breakIndex = -1;
				continue;
			}
			emit(line);
			line = [];
			lineWidth = 0;
			breakIndex = -1;
			continue;
		}

		line.push(unit);
		lineWidth += unit.width;
		if (unit.char === " ") breakIndex = line.length;
		i++;
	}

	let end = line.length;
	while (end > 0 && line[end - 1]!.char === " ") end--;
	emit(line.slice(0, end));

	return lines.length > 0 ? lines : [{ line: "", startIndex: 0 }];
}

interface WrapCacheEntry {
	width: number;
	lines: string[];
}

const WRAP_CACHE_LIMIT = 2048;
const wrapCache = new Map<string, WrapCacheEntry>();

/**
 * Wraps text to a specified visible width, preferring word boundaries and
 * preserving multiple/leading spaces.
 *
 * Memoized with a small LRU keyed by the text (one width per entry): Yoga
 * measure functions and element paints wrap the same strings on every commit,
 * so unchanged text must not re-run the per-character tokenizer. Callers must
 * treat the returned array as immutable.
 */
export function wrapText(text: string, width: number): string[] {
	const cached = wrapCache.get(text);
	if (cached && cached.width === width) {
		// Refresh recency so on-screen lines survive evictions.
		wrapCache.delete(text);
		wrapCache.set(text, cached);
		return cached.lines;
	}

	const lines = wrapTextWithOffsets(text, width).map((l) => l.line);
	wrapCache.set(text, { width, lines });
	if (wrapCache.size > WRAP_CACHE_LIMIT) {
		const oldest = wrapCache.keys().next().value;
		if (oldest !== undefined) wrapCache.delete(oldest);
	}
	return lines;
}

/** One wrapped line of editable text, with its source span and visible width. */
export interface WrappedLine {
	/** Visible text of the line. Trailing spaces are kept on the final line. */
	line: string;
	/** Index in the original string of this line's first character. */
	startIndex: number;
	/** Index in the original string just past this line's last character. */
	endIndex: number;
	/** Visible width of the line in terminal cells. */
	cells: number;
}

/** A cursor position on a wrapped line grid (both zero-based). */
export interface WrappedCursor {
	line: number;
	col: number;
}

/**
 * Word-wrap text for an editable field, preserving every source character.
 *
 * Unlike `wrapTextWithOffsets`, a space that triggers a word break is consumed
 * by the break only when a following word exists (the source gap is covered by
 * the next line's `startIndex`), and the final line keeps its trailing spaces.
 * `startIndex`/`endIndex` therefore cover every character, so a cursor can be
 * mapped back onto the painted lines — see `cursorPositionInWrappedText`.
 * Presentational wrapping keeps using `wrapText`/`wrapTextWithOffsets`.
 */
export function wrapTextForEditing(text: string, width: number): WrappedLine[] {
	const empty: WrappedLine[] = [{ line: "", startIndex: 0, endIndex: 0, cells: 0 }];
	if (width <= 0) return empty;

	const units = tokenize(String(text || ""));
	if (units.length === 0) return empty;

	const lines: WrappedLine[] = [];
	let line: Unit[] = [];
	let lineWidth = 0;
	/** Index in `line` immediately after the most recent space. */
	let breakIndex = -1;

	const push = (lineUnits: Unit[], cells: number) => {
		if (lineUnits.length === 0) return;
		const startIndex = lineUnits[0]!.rawStart;
		const length = lineUnits.reduce((sum, u) => sum + u.char.length, 0);
		lines.push({ line: unitsToString(lineUnits), startIndex, endIndex: startIndex + length, cells });
	};

	let i = 0;
	while (i < units.length) {
		const unit = units[i]!;

		if (line.length > 0 && unit.width > 0 && lineWidth + unit.width > width) {
			if (unit.char === " " && line.some((u) => u.char !== " ")) {
				// A word separator that does not fit: if a word follows, break
				// here and consume the whole run of spaces — they only exist to
				// separate the two words. Trailing spaces (no word after) are
				// kept on a line of their own so the cursor still advances.
				let next = i;
				while (next < units.length && units[next]!.char === " ") next++;
				if (next < units.length) {
					push(line, lineWidth);
					line = [];
					lineWidth = 0;
					breakIndex = -1;
					i = next;
					continue;
				}
			}
			if (breakIndex > 0) {
				let end = breakIndex;
				while (end > 0 && line[end - 1]!.char === " ") end--;
				if (end > 0) {
					const head = line.slice(0, end);
					push(head, unitsWidth(head));
					line = line.slice(breakIndex);
					lineWidth = unitsWidth(line);
					breakIndex = -1;
					continue;
				}
			}
			push(line, lineWidth);
			line = [];
			lineWidth = 0;
			breakIndex = -1;
			continue;
		}

		line.push(unit);
		lineWidth += unit.width;
		if (unit.char === " ") breakIndex = line.length;
		i++;
	}

	// Keep trailing spaces on the final line: the cursor after a typed space
	// must advance, and padding paints the same cells either way.
	push(line, lineWidth);
	return lines.length > 0 ? lines : empty;
}

/**
 * Map a source character index onto the wrapped line grid.
 *
 * Total for `0 .. text.length`: indexes inside the space run consumed by a word
 * break resolve to the start of the line those spaces introduce, and a cursor
 * at the end of a full line wraps to the next line when one exists. The column
 * is clamped so the hardware cursor always stays inside the field.
 */
export function cursorPositionInWrappedText(
	lines: WrappedLine[],
	cursorPosition: number,
	width: number,
): WrappedCursor {
	const maxCol = Math.max(0, width - 1);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (cursorPosition < line.startIndex) {
			// On a space consumed by a word break: show it at the start of the
			// line the spaces introduce.
			return { line: i, col: 0 };
		}
		if (cursorPosition <= line.endIndex) {
			const col = visibleLength(line.line.slice(0, cursorPosition - line.startIndex));
			if (col >= width && i + 1 < lines.length) {
				// End of a full line: the cursor wraps to the next line.
				return { line: i + 1, col: 0 };
			}
			return { line: i, col: Math.min(col, maxCol) };
		}
	}

	const last = lines.length - 1;
	const lastLine = lines[last]!;
	return { line: last, col: Math.min(lastLine.cells, maxCol) };
}
