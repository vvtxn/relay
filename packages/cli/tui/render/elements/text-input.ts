import { RESET_FG } from "@/tui/core/ansi.ts";
import { toAnsi } from "@/tui/core/primitives/color.ts";
import { findMentions, type MentionRange } from "@/tui/core/primitives/mentions.ts";
import { cursorPositionInWrappedText, type WrappedLine, wrapTextForEditing } from "@/tui/core/primitives/wrap-text.ts";
import { theme } from "@/tui/theme.ts";
import type { ElementHandler, Position, TextInputInstance } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";

export const TextInputLayout: LayoutHandler<TextInputInstance> = (instance) => {
	const { yogaNode } = instance;
	if (instance.props.width !== undefined) yogaNode.setWidth(instance.props.width);
	else yogaNode.setWidthAuto();

	if (instance.props.height !== undefined) {
		yogaNode.unsetMeasureFunc();
		yogaNode.setHeight(instance.props.height);
		return;
	}

	yogaNode.setHeightAuto();
	yogaNode.setMeasureFunc((width) => {
		// Props are read through `instance` (not a destructured copy) because
		// the reconciler replaces `instance.props` before re-applying layout.
		const value = instance.props.value || instance.props.placeholder || "";
		const lines = wrapEditorText(value, Math.floor(width));
		const maxLines = Math.max(1, instance.props.maxLines ?? lines.length);
		return { width, height: Math.max(1, Math.min(lines.length, maxLines)) };
	});
	// `setMeasureFunc` does not dirty the node in yoga-layout 3.x, so the new
	// content would otherwise keep the previous measured height.
	yogaNode.markDirty();
};

interface CursorInfo {
	x: number;
	y: number;
	visible: boolean;
}

let pendingCursor: CursorInfo | null = null;

export function getPendingCursor(): CursorInfo | null {
	return pendingCursor;
}

export function clearPendingCursor() {
	pendingCursor = null;
}

let lastWrap: { text: string; width: number; lines: WrappedLine[] } | null = null;

/**
 * Editing wrap with a one-entry cache: Yoga's measure function and the paint
 * pass wrap the same value at the same width on every commit, and the results
 * are read-only. Callers must treat the returned lines as immutable.
 */
function wrapEditorText(text: string, width: number): WrappedLine[] {
	if (lastWrap && lastWrap.text === text && lastWrap.width === width) return lastWrap.lines;
	const lines = wrapTextForEditing(text, width);
	lastWrap = { text, width, lines };
	return lines;
}

/**
 * Keep the cursor line inside the field: no scroll while it fits, otherwise
 * follow the cursor with the minimum offset (derived, so it stays correct when
 * the cursor moves up as well as down).
 */
function viewportScrollTop(totalLines: number, cursorLine: number, viewportHeight: number): number {
	const maxScroll = Math.max(0, totalLines - viewportHeight);
	return Math.max(0, Math.min(cursorLine - viewportHeight + 1, maxScroll));
}

/** Style one wrapped line: mentions in the accent color, padded to `width` cells. */
function formatLine(
	line: WrappedLine,
	width: number,
	mentions: MentionRange[],
	defaultAnsi: string | null,
	mentionAnsi: string,
): string {
	let result = defaultAnsi ?? "";
	let inMention = false;
	let offset = 0;

	for (const char of line.line) {
		const absoluteIndex = line.startIndex + offset;
		const isMention = mentions.some((m) => absoluteIndex >= m.start && absoluteIndex < m.end);
		if (isMention !== inMention) {
			result += isMention ? mentionAnsi : `${RESET_FG}${defaultAnsi ?? ""}`;
			inMention = isMention;
		}
		result += char;
		offset += char.length;
	}

	result += RESET_FG;
	const padding = width - line.cells;
	if (padding > 0) result += " ".repeat(padding);
	return result;
}

export const TextInputElement: ElementHandler<TextInputInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());
	const width = Math.round(instance.yogaNode.getComputedWidth());
	const height = Math.max(1, Math.round(instance.yogaNode.getComputedHeight()));

	const value = instance.props.value || "";
	const placeholder = instance.props.placeholder || "";
	const displayText = value || placeholder;
	const isPlaceholder = !value && !!placeholder;
	const cursorPos = instance.props.cursorPosition ?? value.length;

	const lines = wrapEditorText(displayText, width);
	const mentions = isPlaceholder ? [] : findMentions(value);
	const cursor = cursorPositionInWrappedText(lines, cursorPos, width);
	const scrollTop = viewportScrollTop(lines.length, cursor.line, height);

	const colorToUse = isPlaceholder ? instance.props.placeholderColor : instance.props.color;
	const defaultAnsi = colorToUse ? toAnsi(colorToUse) : null;
	const mentionAnsi = toAnsi(theme.accent) ?? "\x1b[36m";

	const positions: Position[] = [];
	for (let row = 0; row < height; row++) {
		const line = lines[scrollTop + row];
		positions.push({
			x,
			y: y + row,
			text: line ? formatLine(line, width, mentions, defaultAnsi, mentionAnsi) : " ".repeat(width),
		});
	}

	if (instance.props.focused && cursor.line >= scrollTop && cursor.line - scrollTop < height) {
		pendingCursor = {
			x: x + cursor.col,
			y: y + cursor.line - scrollTop,
			visible: true,
		};
	}

	return positions;
};
