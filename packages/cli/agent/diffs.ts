/**
 * Diff presentation helpers for the terminal client.
 *
 * Pure and UI-free so the row building and session collection can be tested
 * without mounting the TUI. `parseDiff`/`diffStats` come from the shared
 * display module, so the CLI and web read the same patch structure.
 */

import { diffStats, parseDiff, type DiffLine, type UIMessage } from "@vvtxn/relay/core/display.ts";

/** One edit/write diff available for review in a session. */
export interface SessionDiff {
	/** Raw tool name (e.g. `edit_file`), used for its display label and accent. */
	name: string;
	/** File path from the patch header, falling back to the summarized tool arg. */
	path: string;
	diff: string;
	adds: number;
	deletes: number;
}

/** Collect every tool result that carried a diff, in conversation order. */
export function collectSessionDiffs(messages: UIMessage[]): SessionDiff[] {
	const diffs: SessionDiff[] = [];
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			if (!call.diff) continue;
			const parsed = parseDiff(call.diff);
			const stats = diffStats(call.diff);
			diffs.push({
				name: call.name,
				path: parsed[0]?.path ?? (call.input || "diff"),
				diff: call.diff,
				adds: stats.adds,
				deletes: stats.deletes,
			});
		}
	}
	return diffs;
}

/** One rendered line in the compact preview or the full review overlay. */
export type DiffRow =
	| { kind: "hunk"; text: string }
	| { kind: "line"; lineNo: number; prefix: DiffLine["prefix"]; content: string }
	| { kind: "separator"; text: string };

export interface DiffRows {
	rows: DiffRow[];
	/** Width of the line-number gutter. */
	gutter: number;
	/** Changed lines omitted by `maxLines` (previews only). */
	hidden: number;
}

export interface DiffRowOptions {
	/** Keep unchanged context lines and hunk headers (full review view). */
	context?: boolean;
	/** Maximum changed lines for a compact preview; omit for every line. */
	maxLines?: number;
}

interface RowCandidate {
	line: DiffLine;
	hunkStart: boolean;
	header: string;
}

/**
 * Flatten a unified diff into display rows.
 *
 * Compact mode (the transcript preview) drops unchanged context and shows only
 * the changed lines, with a `⋯` separator between hunks. Context mode (the
 * review overlay) keeps every line plus its `@@` header. Tabs expand to four
 * spaces so the line-number gutter and content stay aligned in the terminal.
 */
export function buildDiffRows(raw: string, options: DiffRowOptions = {}): DiffRows {
	const context = options.context === true;
	const candidates: RowCandidate[] = [];

	for (const file of parseDiff(raw)) {
		for (const hunk of file.hunks) {
			let hunkStart = true;
			for (const line of hunk.lines) {
				if (!context && line.prefix === " ") continue;
				candidates.push({ line, hunkStart, header: hunk.header });
				hunkStart = false;
			}
		}
	}

	const visible = options.maxLines === undefined ? candidates : candidates.slice(0, options.maxLines);
	const hidden =
		options.maxLines === undefined
			? 0
			: candidates.slice(visible.length).filter((candidate) => candidate.line.prefix !== " ").length;

	const rows: DiffRow[] = [];
	let gutter = 1;
	let firstHunk = true;

	for (const candidate of visible) {
		if (candidate.hunkStart) {
			if (context) rows.push({ kind: "hunk", text: candidate.header });
			else if (!firstHunk) rows.push({ kind: "separator", text: "⋯" });
			firstHunk = false;
		}

		gutter = Math.max(gutter, String(candidate.line.lineNo).length);
		rows.push({
			kind: "line",
			lineNo: candidate.line.lineNo,
			prefix: candidate.line.prefix,
			content: candidate.line.content.replaceAll("\t", "    "),
		});
	}

	return { rows, gutter, hidden };
}
