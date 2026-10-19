import { Box, Markdown, memo, Text } from "#/tui/render/components.tsx";
import { theme } from "#/tui/theme.ts";
import { groupToolCalls } from "@vvtxn/relay/core/display.ts";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";

export type { UIMessage };

/** Per-tool accents — the same tokens the web client colors tool names with. */
const TOOL_COLORS: Record<string, string> = {
	read_file: theme.toolRead,
	write_file: theme.toolWrite,
	edit_file: theme.toolEdit,
	grep: theme.toolGrep,
	bash: theme.toolRun,
};

/** Widest tool display name (`delegate`), so the target column stays aligned. */
const TOOL_NAME_WIDTH = 8;

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A single chat turn. User turns sit on a full-width `surfaceElevated` band,
 * agent turns are marked with a `●`; tool activity renders as one compact row
 * per tool instead of a row per call — colored tool name, the targets it
 * touched, and an aggregated result stat (`12 matches in 3 files`, `+4 −2`,
 * `running…`).
 * Pure: memoized so unchanged messages skip re-rendering across commits.
 */
export const MessageView = memo(function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box bgColor={theme.surfaceElevated} paddingX={2} paddingY={1}>
				<Text color={theme.text}>{msg.content}</Text>
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
					<Text color={theme.brand} bold>
						●
					</Text>
					<Markdown flex>{msg.content.trim()}</Markdown>
				</Box>
			)}
			{toolCalls.length > 0 && (
				<Box flexDirection="column">
					{groupToolCalls(toolCalls).map((group) => (
						<Box key={group.name} flexDirection="row" gap={1}>
							<Text
								width={TOOL_NAME_WIDTH}
								bold
								color={
									group.errorCount > 0 ? theme.error : (TOOL_COLORS[group.name] ?? theme.textMuted)
								}
							>
								{group.label}
							</Text>
							<Text flex color={theme.textDim}>
								{group.args}
							</Text>
							<Box flexDirection="row" gap={1}>
								{group.stat !== "" && <Text color={theme.textFaint}>{group.stat}</Text>}
								{group.errorCount > 0 && (
									<Text color={theme.error}>
										{group.stat !== "" ? "· " : ""}
										{group.errorCount} error{group.errorCount === 1 ? "" : "s"}
									</Text>
								)}
							</Box>
						</Box>
					))}
				</Box>
			)}
		</Box>
	);
});
