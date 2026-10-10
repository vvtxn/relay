import { Box, Markdown, memo, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";
import { getToolDisplayName, getToolDisplayOutput, parseDiffLines } from "@vvtxn/relay/core/display.ts";
import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";

export type { UIMessage };

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

/**
 * Unified diff lines, indented under their tool call with a `│` continuation.
 * Pure: memoized so unchanged diffs skip re-parsing across commits.
 */
const DiffView = memo(function DiffView({ diff }: { key?: number; diff: string }) {
	const lines = parseDiffLines(diff);
	const pad = String(lines.reduce((max, l) => Math.max(max, l.lineNo), 0)).length;

	return (
		<Box flexDirection="column">
			{lines.map((l, i) => (
				<Text key={i} color={l.prefix === "+" ? theme.success : l.prefix === "-" ? theme.error : theme.textDim}>
					{`│ ${String(l.lineNo).padStart(pad)} ${l.prefix}  ${l.content}`}
				</Text>
			))}
		</Box>
	);
});

// ---------------------------------------------------------------------------
// ToolCallView
// ---------------------------------------------------------------------------

/**
 * One compact tool-call row — `├` while more detail follows (a diff or another
 * tool call), `└` for a final diff-less call — with the name, summarized args,
 * and one-line output on a single line. Pure: memoized so unchanged tool
 * calls skip re-rendering across commits.
 */
const ToolCallView = memo(function ToolCallView(
	{ tool, last }: { key?: number; tool: UIToolCall; last?: boolean },
) {
	const output = getToolDisplayOutput(tool);
	const summary = tool.input + (output ? ` · ${output.trim()}` : "");
	const glyph = tool.diff || !last ? "├" : "└";

	return (
		<Box flexDirection="column">
			<Box flexDirection="row" gap={1}>
				<Text color={theme.textDim}>{glyph}</Text>
				<Text color={theme.brand} bold>{getToolDisplayName(tool.name)}</Text>
				<Text flex color={theme.textMuted}>{summary}</Text>
			</Box>
			{tool.diff && <DiffView diff={tool.diff} />}
		</Box>
	);
});

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A single chat turn. User and agent turns are labeled (`you` in info,
 * `relay` in brand) so roles read at a glance; turns are separated by the
 * scroll area's gap instead of full-message panels. Pure: memoized so
 * unchanged messages skip re-rendering across commits.
 */
export const MessageView = memo(function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box flexDirection="row" gap={1}>
				<Text color={theme.info} bold>you</Text>
				<Text flex color={theme.text}>{msg.content}</Text>
			</Box>
		);
	}

	const hasText = !!msg.content?.trim();
	const toolCalls = msg.toolCalls ?? [];

	if (!hasText && toolCalls.length === 0) return null;

	return (
		<Box flexDirection="column">
			<Text color={theme.brand} bold>relay</Text>
			{hasText && <Markdown flex>{msg.content.trim()}</Markdown>}
			{toolCalls.length > 0 && (
				<Box flexDirection="column">
					{toolCalls.map((tool, i) => <ToolCallView key={i} tool={tool} last={i === toolCalls.length - 1} />)}
				</Box>
			)}
		</Box>
	);
});
