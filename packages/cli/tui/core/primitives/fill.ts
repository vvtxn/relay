import type { Position } from "#/tui/render/types/index.ts";
import { RESET_BG } from "#/tui/core/ansi.ts";

/**
 * Background fill positions for a box: one styled run of spaces per row,
 * spanning the full width of the box. Kept here so every element that paints a
 * surface shares one definition of a box's painted bounds.
 */
export function fillPositions(x: number, y: number, w: number, h: number, bgAnsi: string): Position[] {
	if (w <= 0 || h <= 0) return [];

	const row = `${bgAnsi}${" ".repeat(w)}${RESET_BG}`;
	const positions: Position[] = [];
	for (let i = 0; i < h; i++) {
		positions.push({ x, y: y + i, text: row });
	}
	return positions;
}

const BORDER_GLYPHS = {
	square: { tl: "┌", tr: "┐", bl: "└", br: "┘" },
	rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯" },
} as const;

/**
 * Border positions for a box: a 1-cell outline drawn on the box's outer ring.
 * The ring shows `outerBgAnsi` — the backdrop *behind* the box (its inherited
 * background), never the box's own fill, so a bordered box's surface cannot
 * bleed outside the outline. `rounded` swaps square corners for quarter-circle
 * arcs (the arc cannot fill a partial cell, hence the same rule for corners).
 * Needs at least a 2x2 box; smaller boxes render no border.
 */
export function borderPositions(
	x: number,
	y: number,
	w: number,
	h: number,
	fgAnsi: string,
	outerBgAnsi: string | null,
	rounded: boolean,
): Position[] {
	if (w < 2 || h < 2) return [];

	const { tl, tr, bl, br } = rounded ? BORDER_GLYPHS.rounded : BORDER_GLYPHS.square;
	const style = `${outerBgAnsi ?? ""}${fgAnsi}`;
	const horizontal = "─".repeat(w - 2);
	const positions: Position[] = [
		{ x, y, text: `${style}${tl}${horizontal}${tr}` },
		{ x, y: y + h - 1, text: `${style}${bl}${horizontal}${br}` },
	];
	for (let i = 1; i < h - 1; i++) {
		positions.push({ x, y: y + i, text: `${style}│` });
		positions.push({ x: x + w - 1, y: y + i, text: `${style}│` });
	}
	return positions;
}
