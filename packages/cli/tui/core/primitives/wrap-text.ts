import { codePointWidth } from "./char-width.ts";

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

/**
 * Splits text into lines of the specified visible width without word wrapping,
 * keeping ANSI escape sequences intact. Tracks each line's starting index.
 */
export function splitTextWithOffsets(text: string, width: number): LineWithOffset[] {
	if (width <= 0) return [];

	const units = tokenize(String(text || ""));
	if (units.length === 0) return [{ line: "", startIndex: 0 }];

	const result: LineWithOffset[] = [];
	let line: Unit[] = [];
	let lineWidth = 0;

	for (const unit of units) {
		if (line.length > 0 && unit.width > 0 && lineWidth + unit.width > width) {
			result.push({ line: unitsToString(line), startIndex: line[0]!.rawStart });
			line = [];
			lineWidth = 0;
		}
		line.push(unit);
		lineWidth += unit.width;
	}

	if (line.length > 0) {
		result.push({ line: unitsToString(line), startIndex: line[0]!.rawStart });
	}

	return result.length > 0 ? result : [{ line: "", startIndex: 0 }];
}

/**
 * Splits text into lines of the specified visible width without word wrapping.
 */
export function splitText(text: string, width: number): string[] {
	return splitTextWithOffsets(text, width).map((l) => l.line);
}
