import { Box, Markdown, Text } from "@/tui/render/components.tsx";
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
		<Box flexDirection="column">
			<Box flexDirection="row" gap={1}>
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

export function MessageView({ msg }: { key?: number; msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box flexDirection="column" gap={1}>
				<Box flexDirection="row" gap={1}>
					<Text color={theme.brand} bold>
						❯
					</Text>
					<Text flex color={theme.text}>
						{msg.content}
					</Text>
				</Box>
			</Box>
		);
	}

	const hasText = !!msg.content?.trim();
	const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

	if (!hasText && !hasToolCalls) return null;

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
			{hasToolCalls && msg.toolCalls?.map((tool, i) => <ToolCallView key={i} tool={tool} />)}
		</Box>
	);
}
