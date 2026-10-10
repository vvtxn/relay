import {
	BOLD,
	BOLD_OFF,
	ITALIC,
	ITALIC_OFF,
	RESET_FG,
	STRIKETHROUGH,
	STRIKETHROUGH_OFF,
	UNDERLINE,
	UNDERLINE_OFF,
} from "@/tui/core/ansi.ts";
import { toAnsi } from "@/tui/core/primitives/color.ts";
import { type MarkdownSegment, parseMarkdown } from "@/tui/core/primitives/parse-markdown.ts";
import { useScrollArea } from "./hooks/scroll-area.ts";
import { useSignal, useSignalEffect } from "./hooks/signals.ts";
import { memo } from "./memo.ts";
import type {
	BoxProps,
	MarkdownProps,
	ScrollAreaProps,
	SpinnerProps,
	TextInputProps,
	TextProps,
} from "./types/index.ts";

export { memo };

const SPINNER_FRAME_COUNT = 10;

export function Box(props: BoxProps) {
	return <box {...props} />;
}

export function Text(props: TextProps) {
	return <text {...props} />;
}

export function TextInput(props: TextInputProps) {
	return <textInput {...props} />;
}

export function Spinner(props: SpinnerProps) {
	const frame = useSignal(0);
	const interval = props.interval ?? 80;

	useSignalEffect(() => {
		const timer = setInterval(() => {
			frame.value = (frame.value + 1) % SPINNER_FRAME_COUNT;
		}, interval);
		return () => clearInterval(timer);
	});

	return <spinner {...props} frame={frame.value} />;
}

function childrenToString(children: unknown): string {
	if (children == null || children === false) return "";
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(childrenToString).join("");
	return "";
}

function formatSegment(segment: MarkdownSegment): string {
	let text = segment.text;
	if (segment.color) {
		const ansi = toAnsi(segment.color);
		if (ansi) text = `${ansi}${text}${RESET_FG}`;
	}
	if (segment.bold) text = `${BOLD}${text}${BOLD_OFF}`;
	if (segment.italic) text = `${ITALIC}${text}${ITALIC_OFF}`;
	if (segment.underline) text = `${UNDERLINE}${text}${UNDERLINE_OFF}`;
	if (segment.strikethrough) text = `${STRIKETHROUGH}${text}${STRIKETHROUGH_OFF}`;
	return text;
}

export function ScrollArea(props: ScrollAreaProps & { autoScroll?: boolean }) {
	const { focused, scrollStep, autoScroll, ...rest } = props;
	const scroll = useScrollArea({ focused, scrollStep, autoScroll });
	return (
		<scrollArea
			{...rest}
			scrollOffset={scroll.scrollOffset.value}
			onMetrics={scroll.onMetrics}
			onScrollOffsetChange={scroll.onScrollOffsetChange}
		/>
	);
}

export { CommandPalette } from "./components/command-palette.tsx";
export { WelcomeScreen } from "./components/welcome-screen.tsx";
export { ApprovalPrompt } from "./components/approval-prompt.tsx";

const FORMATTED_CACHE_LIMIT = 256;
const formattedLinesCache = new Map<string, string[]>();

/**
 * Parsed + ANSI-formatted lines for one markdown content string, memoized with
 * a small LRU: the same content would otherwise be re-parsed and re-formatted
 * on every commit. Callers must treat the returned array as immutable.
 */
function formattedMarkdownLines(content: string): string[] {
	const cached = formattedLinesCache.get(content);
	if (cached) {
		formattedLinesCache.delete(content);
		formattedLinesCache.set(content, cached);
		return cached;
	}

	const lines = parseMarkdown(content).map((line) => line.segments.map(formatSegment).join(""));
	formattedLinesCache.set(content, lines);
	if (formattedLinesCache.size > FORMATTED_CACHE_LIMIT) {
		const oldest = formattedLinesCache.keys().next().value;
		if (oldest !== undefined) formattedLinesCache.delete(oldest);
	}
	return lines;
}

/**
 * Markdown content rendered as styled Text lines. Pure: memoized so unchanged
 * content skips re-parsing, re-formatting, and VNode churn across commits.
 */
export const Markdown = memo(function Markdown(props: MarkdownProps) {
	const content = childrenToString(props.children);
	const lines = formattedMarkdownLines(content);

	return (
		<Box
			flexDirection="column"
			{...(props.width !== undefined ? { width: props.width } : {})}
			{...(props.height !== undefined ? { height: props.height } : {})}
			{...(props.flex !== undefined ? { flex: props.flex } : {})}
		>
			{lines.map((line, i) => {
				return <Text key={i}>{line}</Text>;
			})}
		</Box>
	);
});
