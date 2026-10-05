import type { Position } from "@/tui/render/types/index.ts";
import { RESET_BG } from "@/tui/core/ansi.ts";

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
