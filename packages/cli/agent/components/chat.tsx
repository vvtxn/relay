import { Box, Markdown, memo, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";
import { summarizeToolCalls } from "@vvtxn/relay/core/display.ts";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";

export type { UIMessage };

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A single chat turn. User turns are marked with a `│` bar, agent turns with a
 * `●`; tool calls are collapsed into one summary line on a surface panel
 * instead of a row per call. Pure: memoized so unchanged messages skip
 * re-rendering across commits.
 */
export const MessageView = memo(function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box flexDirection="row" gap={1}>
				<Text color={theme.borderLabel}>│</Text>
				<Text flex color={theme.text}>{msg.content}</Text>
			</Box>
		);
	}

	const hasText = !!msg.content?.trim();
	const toolCalls = msg.toolCalls ?? [];

	if (!hasText && toolCalls.length === 0) return null;

	return (
		<Box flexDirection="column" gap={1}>
			{hasText && (
				<Box flexDirection="row" gap={1}>
					<Text color={theme.brand} bold>●</Text>
					<Markdown flex>{msg.content.trim()}</Markdown>
				</Box>
			)}
			{toolCalls.length > 0 && (
				<Box bgColor={theme.surface} padding={1}>
					<Text color={theme.textMuted}>{summarizeToolCalls(toolCalls)}</Text>
				</Box>
			)}
		</Box>
	);
});
