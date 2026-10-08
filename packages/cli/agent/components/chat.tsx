import { Box, Markdown, Text } from "@/tui/render/components.tsx";
import type { Children } from "@/tui/render/types/index.ts";
import { space } from "@/tui/spacing.ts";
import { theme } from "@/tui/theme.ts";
import { getToolDisplayName, getToolDisplayOutput, parseDiffLines } from "@vvtxn/relay/core/display.ts";
import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";

export type { UIMessage };

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

function DiffView({ diff }: { diff: string }) {
	const lines = parseDiffLines(diff);
	const pad = String(lines.reduce((max, l) => Math.max(max, l.lineNo), 0)).length;

	return (
		<Box flexDirection="column">
			{lines.map((l, i) => (
				<Text key={i} color={l.prefix === "+" ? theme.success : l.prefix === "-" ? theme.error : theme.textDim}>
					{`${String(l.lineNo).padStart(pad)} ${l.prefix}  ${l.content}`}
				</Text>
			))}
		</Box>
	);
}

// ---------------------------------------------------------------------------
// ToolCallView
// ---------------------------------------------------------------------------

function ToolCallView({ tool }: { key?: number; tool: UIToolCall }) {
	const output = getToolDisplayOutput(tool);

	return (
		<Box flexDirection="column" gap={space.block} paddingLeft={space.inline}>
			<Box flexDirection="row" gap={space.inline}>
				<Text color={theme.brand} bold>{getToolDisplayName(tool.name)}</Text>
				<Text color={theme.textMuted}>{tool.input}</Text>
			</Box>
			{output && <Text color={theme.textMuted}>{output.trim()}</Text>}
			{tool.diff && <DiffView diff={tool.diff} />}
		</Box>
	);
}

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A full-bleed card with a colored left rail. The rail is the primary role cue
 * (user = info, agent = brand); the background step (surfaceElevated vs
 * surface) reinforces it. There are no borders, so the rail — a one-cell box
 * that stretches to the card height — gives each message a hard left edge that
 * survives even when the background is subtle.
 */
function Card({ rail, bg, children }: { rail: string; bg: string; children?: Children }) {
	return (
		<Box flexDirection="row" bgColor={bg}>
			<Box width={space.rail} bgColor={rail} />
			<Box
				flex
				flexDirection="column"
				paddingLeft={space.gutter - space.rail}
				paddingRight={space.cardX}
				paddingY={space.cardY}
				gap={space.block}
			>
				{children}
			</Box>
		</Box>
	);
}

export function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Card rail={theme.info} bg={theme.surfaceElevated}>
				<Box flexDirection="row" gap={space.inline}>
					<Text color={theme.info} bold>
						❯
					</Text>
					<Text flex color={theme.text}>
						{msg.content}
					</Text>
				</Box>
			</Card>
		);
	}

	const hasText = !!msg.content?.trim();
	const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

	if (!hasText && !hasToolCalls) return null;

	return (
		<Card rail={theme.brand} bg={theme.surface}>
			{hasText && (
				<Box flexDirection="row" gap={space.inline}>
					<Text color={theme.brand} bold>
						●
					</Text>
					<Markdown flex>{msg.content.trim()}</Markdown>
				</Box>
			)}
			{hasToolCalls && msg.toolCalls?.map((tool, i) => <ToolCallView key={i} tool={tool} />)}
		</Card>
	);
}
