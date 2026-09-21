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
			default:
				return Object.entries(parsed as Record<string, unknown>)
					.filter(([, v]) => typeof v === "string" && v.length < 100)
					.map(([k, v]) => `${k}=${v}`)
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
			const toolCalls: UIToolCall[] = entry.toolCalls?.map((tc) => {
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
			if (tc) tc.output = entry.content;
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
