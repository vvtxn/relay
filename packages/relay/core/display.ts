/**
 * Display utilities for agent output — shared across all clients (TUI, web, mobile).
 *
 * Deliberately dependency-free: this module is imported by browser bundles.
 */

import type { Entry } from "./sessions/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Display-ready tool call with summarized args and formatted output. */
export interface UIToolCall {
	name: string;
	input: string;
	output: string;
	diff?: string;
	/** True when the tool returned an error result. */
	isError?: boolean;
}

/** A chat message as rendered by clients: user text or agent text + tool calls. */
export interface UIMessage {
	role: "user" | "agent";
	content: string;
	toolCalls?: UIToolCall[];
}

/** A single line of parsed unified diff output (without color assignment). */
export interface DiffLine {
	lineNo: number;
	prefix: "+" | "-" | " ";
	content: string;
}

// ---------------------------------------------------------------------------
// Tool display names
// ---------------------------------------------------------------------------

export const TOOL_DISPLAY_NAMES: Record<string, string> = {
	read_file: "read",
	write_file: "write",
	edit_file: "edit",
	grep: "grep",
	bash: "run",
	delegate: "delegate",
};

export function getToolDisplayName(name: string): string {
	return TOOL_DISPLAY_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Tool arg summarization
// ---------------------------------------------------------------------------

export function summarizeToolArgs(name: string, args: string): string {
	try {
		const parsed = JSON.parse(args);
		switch (name) {
			case "read_file":
			case "write_file":
			case "edit_file":
				return parsed.path ?? args;
			case "grep":
				return parsed.pattern ?? args;
			case "bash":
				return parsed.command ?? args;
			case "delegate": {
				const description =
					typeof parsed.description === "string" && parsed.description.trim()
						? parsed.description.trim()
						: "";
				const firstLine =
					String(parsed.prompt ?? "")
						.split("\n")[0]
						?.trim() ?? "";
				const label = description || firstLine || args;
				return label.length > 80 ? `${label.slice(0, 80)}...` : label;
			}
			default:
				return Object.entries(parsed as Record<string, unknown>)
					.filter(([, v]) => typeof v === "string" && v.length < 100)
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(" ");
		}
	} catch {
		return args;
	}
}

export function createUIToolCall(name: string, args: string): UIToolCall {
	return { name, input: summarizeToolArgs(name, args), output: "" };
}

/** Strip @mention attached_context blocks from user message content to reduce token bloat in history. */
export function stripAttachedContext(content: string): string {
	return content.replace(/\n\n<attached_context>[\s\S]*<\/attached_context>$/, "");
}

/**
 * Convert persisted session entries into display-ready UI messages.
 * Tool results are folded into their corresponding tool calls.
 */
export function entriesToUIMessages(entries: Entry[]): UIMessage[] {
	const messages: UIMessage[] = [];
	const toolCallIdMap = new Map<string, UIToolCall>();

	for (const entry of entries) {
		if (entry.type === "message" && entry.role === "user" && typeof entry.content === "string") {
			messages.push({ role: "user", content: stripAttachedContext(entry.content) });
		} else if (entry.type === "message" && entry.role === "assistant") {
			const hasContent = typeof entry.content === "string" && entry.content.trim();
			const hasToolCalls = entry.toolCalls && entry.toolCalls.length > 0;
			if (!hasContent && !hasToolCalls) continue;
			const toolCalls: UIToolCall[] =
				entry.toolCalls?.map((tc) => {
					const uiTc = createUIToolCall(tc.function.name, tc.function.arguments);
					toolCallIdMap.set(tc.id, uiTc);
					return uiTc;
				}) ?? [];
			messages.push({
				role: "agent",
				content: typeof entry.content === "string" ? entry.content : "",
				toolCalls,
			});
		} else if (entry.type === "tool_result") {
			const tc = toolCallIdMap.get(entry.toolCallId);
			if (tc) {
				tc.output = entry.content;
				if (entry.isError) tc.isError = true;
				if (entry.diff) tc.diff = entry.diff;
			}
		}
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Tool output formatting
// ---------------------------------------------------------------------------

export function getToolDisplayOutput(tool: UIToolCall): string | null {
	if (!tool.output) return null;
	switch (tool.name) {
		case "read_file":
			return null;
		case "write_file":
		case "edit_file":
			return tool.output;
		case "grep": {
			const lines = tool.output.split("\n").filter(Boolean);
			const fileSet = new Set(lines.map((l) => l.split(":")[0]));
			return `${lines.length} match${lines.length !== 1 ? "es" : ""} in ${fileSet.size} file${
				fileSet.size !== 1 ? "s" : ""
			}`;
		}
		case "bash": {
			const firstLine = tool.output.split("\n")[0] ?? "";
			return firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
		}
		default:
			return tool.output.length > 120 ? tool.output.slice(0, 120) + "..." : tool.output;
	}
}

// ---------------------------------------------------------------------------
// Tool call summarization
// ---------------------------------------------------------------------------

function formatCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Tool call grouping
// ---------------------------------------------------------------------------

/** One tool's calls within a turn, collapsed for compact display. */
export interface ToolCallGroup {
	/** Raw tool name (e.g. `read_file`), for per-tool accents. */
	name: string;
	/** Display label (e.g. `read`). */
	label: string;
	/** Compact target list, e.g. `app.tsx, chat.tsx +2 more`; may be empty. */
	args: string;
	/** Aggregated result stat, e.g. `12 matches in 3 files`, `+4 −2`, `running…`; may be empty. */
	stat: string;
	/** Calls in the group that returned an error. */
	errorCount: number;
}

/** A call without a result yet (its output/diff/error arrives later). */
function isPendingToolCall(tool: UIToolCall): boolean {
	return tool.output.length === 0 && tool.diff === undefined && tool.isError !== true;
}

const GREP_MATCH_LINE = /^(.*?):(\d+):(.*)$/;
const GREP_NO_MATCHES = "No matches found.";
const ARG_LIST_MAX_ITEMS = 3;
const ARG_LIST_MAX_LENGTH = 44;

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** First-seen unique targets, capped by count and length (`a.ts, b.ts +2 more`). */
function compactToolArgs(name: string, calls: UIToolCall[]): string {
	const targets = [...new Set(calls.map((tool) => (name === "grep" ? `"${tool.input}"` : tool.input)))].filter(
		(target) => target.length > 0,
	);
	if (targets.length === 0) return "";

	const shown: string[] = [];
	for (const target of targets) {
		if (shown.length === ARG_LIST_MAX_ITEMS) break;
		const candidate = [...shown, target].join(", ");
		const remaining = targets.length - shown.length - 1;
		const suffix = remaining > 0 ? ` +${remaining} more` : "";
		if (shown.length > 0 && candidate.length + suffix.length > ARG_LIST_MAX_LENGTH) break;
		shown.push(target);
	}

	const hidden = targets.length - shown.length;
	const suffix = hidden > 0 ? ` +${hidden} more` : "";
	const joined = shown.join(", ");
	return joined.length + suffix.length <= ARG_LIST_MAX_LENGTH
		? `${joined}${suffix}`
		: `${truncateText(joined, ARG_LIST_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** Aggregate the group's completed results into one short stat. */
function groupStat(name: string, calls: UIToolCall[]): string {
	if (calls.some(isPendingToolCall)) return "running…";
	const done = calls.filter((tool) => !isPendingToolCall(tool) && tool.isError !== true);
	if (done.length === 0) return "";

	switch (name) {
		case "read_file": {
			const lines = done.reduce((total, tool) => total + tool.output.split("\n").length, 0);
			return formatCount(lines, "line", "lines");
		}
		case "grep": {
			if (done.every((tool) => tool.output === GREP_NO_MATCHES)) return "no matches";
			let matches = 0;
			const files = new Set<string>();
			for (const tool of done) {
				for (const line of tool.output.split("\n")) {
					const match = GREP_MATCH_LINE.exec(line);
					if (!match) continue;
					matches++;
					if (match[1]) files.add(match[1]);
				}
			}
			return `${formatCount(matches, "match", "matches")} in ${formatCount(files.size, "file", "files")}`;
		}
		case "write_file":
		case "edit_file": {
			let adds = 0;
			let deletes = 0;
			let hasDiff = false;
			for (const tool of done) {
				if (!tool.diff) continue;
				hasDiff = true;
				for (const line of tool.diff.split("\n")) {
					if (line.startsWith("+") && !line.startsWith("+++")) adds++;
					else if (line.startsWith("-") && !line.startsWith("---")) deletes++;
				}
			}
			return hasDiff ? `+${adds} −${deletes}` : formatCount(done.length, "file", "files");
		}
		case "bash":
			return done.length > 1 ? formatCount(done.length, "command", "commands") : "";
		case "delegate":
			return done.length > 1 ? formatCount(done.length, "task", "tasks") : "";
		default:
			return "";
	}
}

/**
 * Collapse a turn's tool calls into one row per tool (first-seen order) for
 * compact display: the unique targets it touched plus an aggregated result
 * stat. A long burst stays one row per tool instead of a row per call.
 */
export function groupToolCalls(toolCalls: UIToolCall[]): ToolCallGroup[] {
	const names: string[] = [];
	const grouped = new Map<string, UIToolCall[]>();
	for (const tool of toolCalls) {
		const existing = grouped.get(tool.name);
		if (existing) existing.push(tool);
		else {
			names.push(tool.name);
			grouped.set(tool.name, [tool]);
		}
	}

	return names.map((name) => {
		const calls = grouped.get(name) ?? [];
		return {
			name,
			label: getToolDisplayName(name),
			args: compactToolArgs(name, calls),
			stat: groupStat(name, calls),
			errorCount: calls.filter((tool) => tool.isError === true).length,
		};
	});
}

// ---------------------------------------------------------------------------
// Path abbreviation
// ---------------------------------------------------------------------------

/**
 * Shorten a path for display by replacing the home directory with `~`.
 * When `home` is unknown, common home prefixes (`/home/<user>`, `/Users/<user>`)
 * are recognized heuristically.
 */
export function abbreviateHome(path: string, home?: string): string {
	if (home && (path === home || path.startsWith(home + "/"))) {
		return "~" + path.slice(home.length);
	}
	return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

/** Expand a leading `~` back to the home directory. */
export function expandHome(path: string, home?: string): string {
	if (!home) return path;
	if (path === "~") return home;
	if (path.startsWith("~/")) return home + path.slice(1);
	return path;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const DIFF_HEADER_PREFIXES = ["diff ", "index ", "--- ", "+++ "];

export function parseDiffLines(raw: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const line of raw.split("\n")) {
		if (DIFF_HEADER_PREFIXES.some((p) => line.startsWith(p))) continue;
		if (line.startsWith("@@")) {
			const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
			if (m) {
				oldLine = parseInt(m[1] ?? "0");
				newLine = parseInt(m[2] ?? "0");
			}
			continue;
		}
		if (line.startsWith("+")) {
			lines.push({ lineNo: newLine++, prefix: "+", content: line.slice(1) });
		} else if (line.startsWith("-")) {
			lines.push({ lineNo: oldLine++, prefix: "-", content: line.slice(1) });
		} else {
			lines.push({
				lineNo: newLine,
				prefix: " ",
				content: line.startsWith(" ") ? line.slice(1) : line,
			});
			oldLine++;
			newLine++;
		}
	}
	return lines;
}
