import { Box, Markdown, memo, Text } from "#/tui/render/components.tsx";
import { theme } from "#/tui/theme.ts";
import { groupToolCalls } from "@vvtxn/relay/core/display.ts";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { DiffPreview } from "./diff.tsx";
import { TOOL_COLORS, TOOL_NAME_WIDTH } from "../tool-display.ts";

export type { UIMessage };

/** Files previewed under one grouped row; the rest stay behind `ctrl+o`. */
const PREVIEW_MAX_FILES = 3;

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A single chat turn. User turns sit on a full-width `surfaceElevated` band,
 * agent turns are marked with a `●`; tool activity renders as one compact row
 * per tool instead of a row per call — colored tool name, the targets it
 * touched, and an aggregated result stat (`12 matches in 3 files`, `+4 −2`,
 * `running…`). Edit/write groups also show a compact changed-lines-only diff
 * preview under the row; the rest of the patch stays behind `ctrl+o`.
 * Pure: memoized so unchanged messages skip re-rendering across commits.
 */
export const MessageView = memo(function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box bgColor={theme.surface} paddingX={1} paddingY={1}>
				<Text color={theme.textMuted}>{msg.content}</Text>
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
					{groupToolCalls(toolCalls).map((group) => {
						const diffs = group.calls.flatMap((call) =>
							call.diff === undefined ? [] : [{ call, diff: call.diff }],
						);
						const previews = diffs.slice(0, PREVIEW_MAX_FILES);
						const hiddenFiles = diffs.length - previews.length;

						return (
							<Box key={group.name} flexDirection="column" paddingBottom={previews.length > 0 ? 1 : 0}>
								<Box flexDirection="row" gap={1}>
									<Text
										width={TOOL_NAME_WIDTH}
										bold
										color={
											group.errorCount > 0
												? theme.error
												: (TOOL_COLORS[group.name] ?? theme.textMuted)
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

								{previews.length > 0 && (
									<Box flexDirection="column" gap={1} paddingLeft={TOOL_NAME_WIDTH + 1}>
										{previews.map((preview, index) => (
											<DiffPreview
												key={index}
												diff={preview.diff}
												{...(previews.length > 1 ? { path: preview.call.input } : {})}
											/>
										))}
										{hiddenFiles > 0 && (
											<Text color={theme.textFaint}>
												{`+${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"} · ctrl+o`}
											</Text>
										)}
									</Box>
								)}
							</Box>
						);
					})}
				</Box>
			)}
		</Box>
	);
});
