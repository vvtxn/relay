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

/** A chat message as rendered by clients: user text, agent text + tool calls, or a system notice. */
export interface UIMessage {
	role: "user" | "agent" | "system";
	content: string;
	toolCalls?: UIToolCall[];
}

/** A single line of parsed unified diff output (without color assignment). */
export interface DiffLine {
	lineNo: number;
	prefix: "+" | "-" | " ";
	content: string;
}

/** One hunk of a unified diff. */
export interface DiffHunk {
	/** The `@@ -old,count +new,count @@` header line. */
	header: string;
	lines: DiffLine[];
}

/** One file's section of a unified diff. */
export interface DiffFile {
	/** Path parsed from the `+++` header (without the `b/` prefix), when present. */
	path?: string;
	hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

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
					const uiTc = createUIToolCall(tc.name, tc.arguments);
					toolCallIdMap.set(tc.id, uiTc);
					return uiTc;
				}) ?? [];
			messages.push({
				role: "agent",
				content: typeof entry.content === "string" ? entry.content : "",
				toolCalls,
			});
		} else if (entry.type === "model_change") {
			messages.push({ role: "system", content: `Switched to ${entry.label}` });
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
// Tool call stats
// ---------------------------------------------------------------------------

function formatCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** A call without a result yet (its output/diff/error arrives later). */
export function isPendingToolCall(tool: UIToolCall): boolean {
	return tool.output.length === 0 && tool.diff === undefined && tool.isError !== true;
}

const GREP_MATCH_LINE = /^(.*?):(\d+):(.*)$/;
const GREP_NO_MATCHES = "No matches found.";

/**
 * Added/removed line counts from a unified diff. Only hunk bodies count, so
 * git/file headers and `---`/`+++` lines are never mistaken for changes.
 */
export function diffStats(raw: string): { adds: number; deletes: number } {
	let adds = 0;
	let deletes = 0;
	let inHunk = false;
	let oldRemaining = 0;
	let newRemaining = 0;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			const match = HUNK_HEADER.exec(line);
			inHunk = match !== null;
			oldRemaining = Number.parseInt(match?.[2] ?? "1", 10);
			newRemaining = Number.parseInt(match?.[4] ?? "1", 10);
			continue;
		}
		if (!inHunk) continue;

		if (line.startsWith("+")) {
			adds++;
			newRemaining--;
		} else if (line.startsWith("-")) {
			deletes++;
			oldRemaining--;
		} else if (line.startsWith(" ")) {
			oldRemaining--;
			newRemaining--;
		} else {
			continue;
		}

		if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
	}

	return { adds, deletes };
}

/** Short result stat for one tool call (`12 matches in 3 files`, `40 lines`, `+4 −2`, `running…`). */
export function toolCallStat(tool: UIToolCall): string {
	if (isPendingToolCall(tool)) return "running…";
	if (tool.isError === true) return "";

	switch (tool.name) {
		case "read_file":
			return formatCount(tool.output.split("\n").length, "line", "lines");
		case "grep": {
			if (tool.output === GREP_NO_MATCHES) return "no matches";
			let matches = 0;
			const files = new Set<string>();
			for (const line of tool.output.split("\n")) {
				const match = GREP_MATCH_LINE.exec(line);
				if (!match) continue;
				matches++;
				if (match[1]) files.add(match[1]);
			}
			return `${formatCount(matches, "match", "matches")} in ${formatCount(files.size, "file", "files")}`;
		}
		case "write_file":
		case "edit_file": {
			if (!tool.diff) return "";
			const stats = diffStats(tool.diff);
			return `+${stats.adds} −${stats.deletes}`;
		}
		default:
			return "";
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

/**
 * Parse a unified diff into files and hunks with line numbers.
 *
 * Tolerant of extra git metadata (`index`, mode lines, `\ No newline …`) and
 * of diffs without `diff --git` headers. Header-looking content lines inside a
 * hunk are treated as content, never as headers: hunk lengths come from the
 * `@@` header, so a `--- foo` deletion is unambiguous until the hunk is full.
 */
export function parseDiff(raw: string): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	let oldRemaining = 0;
	let newRemaining = 0;

	const ensureFile = (): DiffFile => {
		if (!current) {
			current = { hunks: [] };
			files.push(current);
		}
		return current;
	};

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			const path = match?.[2];
			current = { ...(path ? { path } : {}), hunks: [] };
			files.push(current);
			hunk = null;
			continue;
		}

		if (line.startsWith("@@")) {
			const file = ensureFile();
			const match = HUNK_HEADER.exec(line);
			oldLine = Number.parseInt(match?.[1] ?? "0", 10);
			newLine = Number.parseInt(match?.[3] ?? "0", 10);
			oldRemaining = Number.parseInt(match?.[2] ?? "1", 10);
			newRemaining = Number.parseInt(match?.[4] ?? "1", 10);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}

		if (hunk) {
			if (line === "" || line.startsWith("\\")) continue;

			if (line.startsWith("+")) {
				hunk.lines.push({ lineNo: newLine++, prefix: "+", content: line.slice(1) });
				newRemaining--;
			} else if (line.startsWith("-")) {
				hunk.lines.push({ lineNo: oldLine++, prefix: "-", content: line.slice(1) });
				oldRemaining--;
			} else if (line.startsWith(" ")) {
				hunk.lines.push({ lineNo: newLine, prefix: " ", content: line.slice(1) });
				oldLine++;
				newLine++;
				oldRemaining--;
				newRemaining--;
			} else {
				continue;
			}

			if (oldRemaining <= 0 && newRemaining <= 0) hunk = null;
			continue;
		}

		// File headers and metadata outside a hunk. A `---` line after a file
		// section starts a new file even when the patch omits `diff --git`.
		if (line.startsWith("--- ")) {
			if (current && current.hunks.length > 0) current = null;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const file = ensureFile();
			const headerPath = line.slice(4).split("\t")[0] ?? "";
			const path = headerPath.startsWith("b/") ? headerPath.slice(2) : headerPath;
			if (path && path !== "/dev/null") file.path = path;
		}
	}

	return files;
}
