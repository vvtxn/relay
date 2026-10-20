/**
 * Diff rendering for the terminal client.
 *
 * `DiffPreview` is the compact transcript view: changed lines only, capped at
 * a few rows, with the line-number gutter carrying the location. `DiffViewer`
 * is the full review overlay opened with `ctrl+o`: every hunk and context line
 * in a scrollable panel.
 *
 * Both are pure functions of their props. The preview is memoized so streamed
 * text deltas do not re-parse or re-render unchanged diffs; the viewer receives
 * pre-built rows from the app, and its body is memoized for the same reason.
 */

import { BOLD, BOLD_OFF, RESET_FG } from "#/tui/core/ansi.ts";
import { toAnsi } from "#/tui/core/primitives/color.ts";
import { Box, memo, ScrollArea, Text } from "#/tui/render/components.tsx";
import { theme } from "#/tui/theme.ts";
import { getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import { buildDiffRows, type DiffRow, type DiffRows, type SessionDiff } from "../diffs.ts";
import { TOOL_COLORS } from "../tool-display.ts";

/** Changed lines shown in a transcript preview before the `… more` footer. */
const PREVIEW_MAX_LINES = 8;

function paint(text: string, color: string, bold = false): string {
	const ansi = toAnsi(color);
	const styled = ansi ? `${ansi}${text}${RESET_FG}` : text;
	return bold ? `${BOLD}${styled}${BOLD_OFF}` : styled;
}

/** Format one structured row into an ANSI string for a single `<Text>`. */
function formatDiffRow(row: DiffRow, gutter: number): string {
	if (row.kind === "hunk") return paint(row.text, theme.accent);
	if (row.kind === "separator") return paint(`${" ".repeat(gutter)} ${row.text}`, theme.textFaint);

	const lineNo = paint(String(row.lineNo).padStart(gutter), theme.textFaint);
	if (row.prefix === " ") {
		return `${lineNo} ${paint(` ${row.content}`, theme.textDim)}`;
	}

	const color = row.prefix === "+" ? theme.success : theme.error;
	return `${lineNo} ${paint(row.prefix, color, true)}${paint(row.content, color)}`;
}

export type DiffPreviewProps = {
	diff: string;
	/** File header shown when a group touched more than one file. */
	path?: string | undefined;
	maxLines?: number | undefined;
	key?: number;
};

/**
 * Compact changed-lines-only preview for one edit/write result.
 * Pure: memoized because a draft message is re-invoked on every text delta.
 */
export const DiffPreview = memo(function DiffPreview(props: DiffPreviewProps) {
	const { rows, gutter, hidden } = buildDiffRows(props.diff, {
		maxLines: props.maxLines ?? PREVIEW_MAX_LINES,
	});

	return (
		<Box flexDirection="column">
			{props.path !== undefined && <Text color={theme.textDim}>{props.path}</Text>}
			{rows.map((row, index) => (
				<Text key={index}>{formatDiffRow(row, gutter)}</Text>
			))}
			{hidden > 0 && (
				<Text color={theme.textFaint}>
					{`${" ".repeat(gutter + 2)}… ${hidden} more changed line${hidden === 1 ? "" : "s"} · ctrl+o`}
				</Text>
			)}
		</Box>
	);
});

/**
 * The scrollable body of the review overlay. Memoized so the row VNodes are
 * reused while the app re-renders behind it (streamed text, spinner ticks).
 */
const DiffBody = memo(function DiffBody(props: { view: DiffRows; key?: number }) {
	return (
		<Box flexDirection="column">
			{props.view.rows.map((row, index) => (
				<Text key={index}>{formatDiffRow(row, props.view.gutter)}</Text>
			))}
		</Box>
	);
});

export interface DiffViewerProps {
	diff: SessionDiff;
	/** Pre-built full-context rows for `diff`. */
	view: DiffRows;
	/** Zero-based position across the session's diffs. */
	index: number;
	total: number;
}

/**
 * Full-screen review overlay for one diff. The app owns the open/index state
 * and routes keys; this component only renders.
 */
export function DiffViewer(props: DiffViewerProps) {
	const label = getToolDisplayName(props.diff.name);
	const accent = TOOL_COLORS[props.diff.name] ?? theme.textMuted;

	return (
		<Box position="absolute" top={0} left={0} right={0} bottom={0} bgColor={theme.background} padding={1}>
			<Box flex flexDirection="column" gap={1} padding={1} borderColor={theme.border} borderRadius>
				<Box flexDirection="row" gap={1} justifyContent="space-between">
					<Box flexDirection="row" gap={1}>
						<Text bold color={accent}>
							{label}
						</Text>
						<Text color={theme.text}>{props.diff.path}</Text>
					</Box>
					<Box flexDirection="row" gap={1}>
						<Text color={theme.success}>+{props.diff.adds}</Text>
						<Text color={theme.error}>−{props.diff.deletes}</Text>
					</Box>
				</Box>

				<ScrollArea flex scrollbar focused>
					<DiffBody view={props.view} />
				</ScrollArea>

				<Box flexDirection="row" gap={1} justifyContent="space-between">
					<Text color={theme.textFaint}>
						{props.index + 1} / {props.total}
					</Text>
					<Text color={theme.textFaint}>↑/↓ scroll · n/p diff · esc close</Text>
				</Box>
			</Box>
		</Box>
	);
}
