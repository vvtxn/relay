/**
 * Diff presentation for every Relay client.
 *
 * `parseDiff()` in `display.ts` gives files → hunks → lines; this module turns
 * that into render-ready rows plus a single color contract. Clients only paint:
 * the TUI maps a theme token to ANSI, the web maps the same token to a
 * `--relay-*` custom property. Change prefixes are data, never text — no client
 * prints `+`/`-`/space markers, the row color carries the signal.
 *
 * Deliberately dependency-free and browser-safe (same rules as `display.ts`).
 */

import { parseDiff, type DiffLine } from "./display.ts";
import type { Theme } from "./theme.ts";

/** What a diff line means; the `+`/`-`/space prefix never reaches the UI. */
export type DiffLineKind = "add" | "del" | "ctx";

/** One render-ready row. */
export type DiffViewRow =
	| { kind: "file"; path: string; adds: number; deletes: number }
	| { kind: "hunk"; header: string }
	| { kind: "separator"; text: string }
	| { kind: "line"; type: DiffLineKind; lineNo: number; text: string };

export interface DiffView {
	rows: DiffViewRow[];
	/** Width of the line-number gutter. */
	gutter: number;
	/** Changed lines omitted by `maxChangedLines` (compact previews only). */
	hiddenChanged: number;
	/** Added / removed line counts across the whole patch. */
	adds: number;
	deletes: number;
}

export interface DiffViewOptions {
	/** Keep unchanged context lines and `@@` headers (full review view). */
	context?: boolean;
	/** Maximum changed lines for a compact preview; omit for every line. */
	maxChangedLines?: number;
	/**
	 * Emit a file row (path + per-file counts) before each section of a
	 * multi-file patch. Ignored for single-file patches, where the surrounding
	 * tool row or modal header already shows the path. Defaults to true.
	 */
	fileHeaders?: boolean;
}

/** Theme token that paints a row; clients resolve the name in their palette. */
export function diffRowToken(row: DiffViewRow): keyof Theme {
	switch (row.kind) {
		case "file":
		case "hunk":
			return "accent";
		case "separator":
			return "textFaint";
		case "line":
			return row.type === "add" ? "diffAdd" : row.type === "del" ? "diffDel" : "textDim";
	}
}

/**
 * Theme token for a row's line background, or null when it stays transparent.
 * Added/removed rows get a faint tint so they read at a glance without the
 * `+`/`-` markers.
 */
export function diffRowBackground(row: DiffViewRow): keyof Theme | null {
	if (row.kind !== "line") return null;
	if (row.type === "add") return "diffAddBackground";
	if (row.type === "del") return "diffDelBackground";
	return null;
}

/** Right-align a line number in the view's gutter. */
export function formatDiffGutter(lineNo: number, gutter: number): string {
	return String(lineNo).padStart(gutter);
}

function lineKind(prefix: DiffLine["prefix"]): DiffLineKind {
	return prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
}

interface Candidate {
	line: DiffLine;
	fileIndex: number;
	hunkStart: boolean;
	header: string;
}

interface FileCounts {
	adds: number;
	deletes: number;
}

/**
 * Flatten a unified diff into display rows.
 *
 * Compact mode (a transcript preview) drops unchanged context and shows only
 * the changed lines, with a `⋯` separator between hunks. Context mode (the full
 * review view) keeps every line plus its `@@` header. Tabs expand to four
 * spaces so the gutter and content stay aligned in the terminal.
 */
export function prettyDiff(raw: string, options: DiffViewOptions = {}): DiffView {
	const context = options.context === true;
	const showFileHeaders = options.fileHeaders !== false;
	const files = parseDiff(raw);
	const counts: FileCounts[] = [];

	const candidates: Candidate[] = [];
	for (const [fileIndex, file] of files.entries()) {
		const stat = { adds: 0, deletes: 0 };
		for (const hunk of file.hunks) {
			let hunkStart = true;
			for (const line of hunk.lines) {
				if (line.prefix === "+") stat.adds++;
				else if (line.prefix === "-") stat.deletes++;
				else if (!context) continue;
				candidates.push({ line, fileIndex, hunkStart, header: hunk.header });
				hunkStart = false;
			}
		}
		counts.push(stat);
	}

	const visible = options.maxChangedLines === undefined ? candidates : candidates.slice(0, options.maxChangedLines);
	const hiddenChanged =
		options.maxChangedLines === undefined
			? 0
			: candidates.slice(visible.length).filter((candidate) => candidate.line.prefix !== " ").length;

	const rows: DiffViewRow[] = [];
	let gutter = 1;
	let lastFile = -1;
	let firstHunk = true;

	for (const candidate of visible) {
		if (candidate.fileIndex !== lastFile) {
			lastFile = candidate.fileIndex;
			const file = files[candidate.fileIndex];
			const stat = counts[candidate.fileIndex];
			if (showFileHeaders && files.length > 1 && file && stat) {
				rows.push({ kind: "file", path: file.path ?? "diff", adds: stat.adds, deletes: stat.deletes });
			}
		}

		if (candidate.hunkStart) {
			if (context) rows.push({ kind: "hunk", header: candidate.header });
			else if (!firstHunk) rows.push({ kind: "separator", text: "⋯" });
			firstHunk = false;
		}

		gutter = Math.max(gutter, String(candidate.line.lineNo).length);
		rows.push({
			kind: "line",
			type: lineKind(candidate.line.prefix),
			lineNo: candidate.line.lineNo,
			text: candidate.line.content.replaceAll("\t", "    "),
		});
	}

	const totals = counts.reduce(
		(accumulator, stat) => ({ adds: accumulator.adds + stat.adds, deletes: accumulator.deletes + stat.deletes }),
		{ adds: 0, deletes: 0 },
	);

	return { rows, gutter, hiddenChanged, ...totals };
}
