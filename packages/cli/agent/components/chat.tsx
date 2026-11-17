import { Box, Markdown, memo, Text } from "#/tui/render/components.tsx";
import { useSignal } from "#/tui/render/hooks/signals.ts";
import { RESET_FG } from "#/tui/core/ansi.ts";
import { toAnsi } from "#/tui/core/primitives/color.ts";
import { splitMentions } from "#/tui/core/primitives/mentions.ts";
import { theme } from "#/tui/theme.ts";
import {
	getToolDisplayName,
	isPendingToolCall,
	toolCallStat,
	type UIMessage,
	type UIToolCall,
} from "@vvtxn/relay/core/display.ts";
import { DiffPreview } from "./diff.tsx";
import { TOOL_COLORS, TOOL_NAME_WIDTH } from "../tool-display.ts";

export type { UIMessage };

/** Output lines shown per call when a bundle is expanded; the rest are summarized. */
const OUTPUT_MAX_LINES = 30;
/** Longest output line kept as-is; longer lines are truncated (never mid-ANSI). */
const OUTPUT_MAX_LINE_LENGTH = 400;

/**
 * Color `@path` file mentions in a user turn with the shared `mention` accent,
 * re-applying the base color after each so the rest of the line stays muted.
 * The TUI has no inline text flow, so styling is embedded as ANSI (the same
 * approach `Markdown` uses) and rendered through a single `Text`.
 */
function mentionStyledText(content: string): string {
	const base = toAnsi(theme.textMuted) ?? "";
	const mention = toAnsi(theme.mention) ?? "";
	const body = splitMentions(content)
		.map((segment) => (segment.mention ? `${mention}${segment.text}${RESET_FG}${base}` : segment.text))
		.join("");
	return `${base}${body}${RESET_FG}`;
}

/** Split a tool result into display lines, capped so huge outputs stay bounded. */
function toolOutputLines(output: string): { lines: string[]; hidden: number } {
	const text = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
	if (text === "") return { lines: [], hidden: 0 };
	const all = text.split("\n");
	const lines = all.slice(0, OUTPUT_MAX_LINES).map((line) => {
		if (line.length <= OUTPUT_MAX_LINE_LENGTH) return line;
		// Never cut an escape sequence in half; leave styled lines for the
		// terminal to wrap instead of corrupting them.
		if (line.includes("\x1b")) return line;
		return `${line.slice(0, OUTPUT_MAX_LINE_LENGTH)}…`;
	});
	return { lines, hidden: Math.max(0, all.length - OUTPUT_MAX_LINES) };
}

/** `2 reads`, `1 write`, `2 runs` — display labels are lowercase verbs/nouns. */
function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	return /(?:s|x|z|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`;
}

/** Compact bundle header: `2 reads · 1 write`, in first-seen tool order. */
function bundleSummary(calls: UIToolCall[]): string {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const call of calls) {
		const label = getToolDisplayName(call.name);
		if (!counts.has(label)) order.push(label);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return order.map((label) => `${counts.get(label)} ${pluralize(label, counts.get(label) ?? 0)}`).join(" · ");
}

/** Capped output lines plus the hidden-line hint and empty state for one call. */
function ToolOutput({ call, indent = 0 }: { call: UIToolCall; indent?: number }) {
	const output = toolOutputLines(call.output);
	return (
		<Box flexDirection="column" paddingLeft={indent}>
			{output.lines.map((line, index) => (
				<Text key={index} color={call.isError === true ? theme.error : theme.textDim}>
					{line}
				</Text>
			))}
			{output.hidden > 0 && (
				<Text color={theme.textFaint}>{`… ${output.hidden} more line${output.hidden === 1 ? "" : "s"}`}</Text>
			)}
			{output.lines.length === 0 && <Text color={theme.textFaint}>no output</Text>}
		</Box>
	);
}

/**
 * One call inside an expanded bundle: tool label, target, per-call stat, then
 * the capped output and (for edit/write) its compact diff preview.
 */
function ToolCallDetail({ call }: { call: UIToolCall }) {
	const stat = toolCallStat(call);
	const indent = TOOL_NAME_WIDTH + 1;
	return (
		<Box flexDirection="column">
			<Box flexDirection="row" gap={1}>
				<Text
					width={TOOL_NAME_WIDTH}
					bold
					color={call.isError === true ? theme.error : (TOOL_COLORS[call.name] ?? theme.textMuted)}
				>
					{getToolDisplayName(call.name)}
				</Text>
				<Text flex color={theme.textDim}>
					{call.input}
				</Text>
				{stat !== "" && <Text color={theme.textFaint}>{stat}</Text>}
			</Box>
			{call.diff !== undefined ? (
				<Box paddingTop={1} paddingLeft={indent}>
					<DiffPreview diff={call.diff} />
				</Box>
			) : (
				!isPendingToolCall(call) && <ToolOutput call={call} indent={indent} />
			)}
		</Box>
	);
}

/**
 * Expanded bundle body. Pure and memoized: `bundleTranscript` keeps the call
 * array identity while the run is unchanged, so idle/streamed commits skip
 * rebuilding hundreds of output lines.
 */
const ExpandedToolBundle = memo(function ExpandedToolBundle({ calls }: { calls: UIToolCall[] }) {
	return (
		<Box flexDirection="column" gap={1} paddingLeft={2} paddingTop={1}>
			{calls.map((call, index) => (
				<ToolCallDetail key={index} call={call} />
			))}
		</Box>
	);
});

/**
 * One collapsed row for a run of tool activity (`2 reads · 1 write`). This is
 * the transcript's only tool surface: expanding lists every call in
 * chronological order with its output/diff. Expansion is component-local;
 * `bundleTranscript` reuses the call array so this row stays cheap.
 */
export function ToolBundleView({ calls }: { calls: UIToolCall[] }) {
	const expanded = useSignal(false);
	const errors = calls.filter((call) => call.isError === true).length;
	const running = calls.some(isPendingToolCall);

	return (
		<Box flexDirection="column">
			<Box flexDirection="row" gap={1} onClick={() => (expanded.value = !expanded.value)}>
				<Text color={theme.textFaint}>{expanded.value ? "▾" : "▸"}</Text>
				<Text bold color={errors > 0 ? theme.error : theme.textMuted}>
					{bundleSummary(calls)}
				</Text>
				{running && <Text color={theme.textFaint}>· running…</Text>}
				{errors > 0 && (
					<Text color={theme.error}>
						· {errors} error{errors === 1 ? "" : "s"}
					</Text>
				)}
			</Box>
			{expanded.value && <ExpandedToolBundle calls={calls} />}
		</Box>
	);
}

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

/**
 * A single prose turn. User turns sit on a full-width `surfaceElevated` band;
 * agent turns are marked with a `●` (brand). Tool activity renders separately
 * as collapsed bundles (`ToolBundleView`), so this stays a pure text row.
 * Memoized: unchanged messages skip re-rendering across commits.
 */
export const MessageView = memo(function MessageView({ msg }: { msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<Box bgColor={theme.surface} paddingX={1} paddingY={1}>
				<Text>{mentionStyledText(msg.content)}</Text>
			</Box>
		);
	}

	const content = msg.content.trim();
	if (content === "") return null;

	return (
		<Box flexDirection="row" gap={1}>
			<Text color={theme.brand} bold>
				●
			</Text>
			<Markdown flex>{content}</Markdown>
		</Box>
	);
});
