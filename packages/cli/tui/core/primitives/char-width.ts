/**
 * Terminal character width + ANSI helpers (a compact wcwidth).
 *
 * The terminal grid is measured in cells, not UTF-16 code units. This module
 * classifies code points as:
 *
 * - **0** — combining marks, zero-width joiners/selectors (attach to the previous cell)
 * - **2** — East Asian Wide/Fullwidth and emoji presentation (occupy two cells)
 * - **1** — everything else, including the "ambiguous" class (matching the
 *   default behavior of most terminals)
 *
 * It also provides ANSI-aware measurement so text wrapping never counts escape
 * sequences as visible content.
 */

/** Whether a code point is zero-width (combining mark or stray joiner). */
function isZeroWidth(cp: number): boolean {
	return (
		cp === 0x200b || // zero width space
		cp === 0x200c || // zero width non-joiner
		cp === 0x200d || // zero width joiner
		cp === 0xfeff || // zero width no-break space
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0x0483 && cp <= 0x0489) || // Cyrillic combining
		(cp >= 0x0591 && cp <= 0x05bd) || // Hebrew accents
		cp === 0x05bf ||
		(cp >= 0x05c1 && cp <= 0x05c2) ||
		(cp >= 0x05c4 && cp <= 0x05c5) ||
		(cp >= 0x0610 && cp <= 0x061a) || // Arabic marks
		(cp >= 0x064b && cp <= 0x065f) ||
		cp === 0x0670 ||
		(cp >= 0x06d6 && cp <= 0x06dc) ||
		(cp >= 0x06df && cp <= 0x06e4) ||
		(cp >= 0x06e7 && cp <= 0x06e8) ||
		(cp >= 0x06ea && cp <= 0x06ed) ||
		(cp >= 0x0e31 && cp <= 0x0e31) || // Thai
		(cp >= 0x0e34 && cp <= 0x0e3a) ||
		(cp >= 0x0e47 && cp <= 0x0e4e) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
		(cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
		(cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
		(cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
		(cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
		(cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji skin-tone modifiers
	);
}

/** Whether a code point is East Asian Wide/Fullwidth or emoji presentation. */
function isWide(cp: number): boolean {
	return (
		cp >= 0x1100 && cp <= 0x115f || // Hangul Jamo
		cp >= 0x2329 && cp <= 0x232a || // angle brackets
		cp >= 0x2e80 && cp <= 0x303e || // CJK radicals, Kangxi, CJK symbols
		cp >= 0x3041 && cp <= 0x33ff || // Hiragana .. CJK compatibility
		cp >= 0x3400 && cp <= 0x4dbf || // CJK ext A
		cp >= 0x4e00 && cp <= 0x9fff || // CJK unified ideographs
		cp >= 0xa000 && cp <= 0xa4cf || // Yi
		cp >= 0xac00 && cp <= 0xd7a3 || // Hangul syllables
		cp >= 0xf900 && cp <= 0xfaff || // CJK compatibility ideographs
		cp >= 0xfe10 && cp <= 0xfe19 || // vertical forms
		cp >= 0xfe30 && cp <= 0xfe6f || // CJK compatibility forms
		cp >= 0xff00 && cp <= 0xff60 || // fullwidth forms
		cp >= 0xffe0 && cp <= 0xffe6 || // fullwidth signs
		cp >= 0x1f300 && cp <= 0x1f64f || // misc symbols and pictographs, emoticons
		cp >= 0x1f900 && cp <= 0x1f9ff || // supplemental symbols and pictographs
		cp >= 0x1fa70 && cp <= 0x1faff || // symbols and pictographs extended-A
		cp >= 0x20000 && cp <= 0x3fffd // CJK ext B and beyond
	);
}

/** Display width of a single code point: 0, 1, or 2. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
	if (isZeroWidth(cp)) return 0;
	if (isWide(cp)) return 2;
	return 1;
}

/** Display width of a cluster (string) in terminal cells. */
export function charWidth(char: string): number {
	let width = 0;
	for (const ch of char) {
		width += codePointWidth(ch.codePointAt(0) ?? 0);
	}
	return width;
}

/** Matches SGR escape sequences (`\x1b[...m`). */
// deno-lint-ignore no-control-regex
export const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Remove SGR escape sequences from a string. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_RE, "");
}

/** Visible display width of a string, ignoring SGR escape sequences. */
export function visibleLength(text: string): number {
	return charWidth(stripAnsi(text));
}
