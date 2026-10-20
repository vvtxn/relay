// Diff presentation helpers: compact previews keep only changed lines, full
// review keeps context and hunk headers, and session collection folds live or
// persisted tool calls into the review list.

import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { buildDiffRows, collectSessionDiffs } from "../agent/diffs.ts";

const diff = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -10,3 +10,4 @@",
	" keep",
	"-old",
	"+new",
	"+extra",
	" keep2",
	"@@ -30,2 +31,2 @@",
	"-old2",
	"+new2",
].join("\n");

const newFileDiff = [
	"diff --git a/src/new.ts b/src/new.ts",
	"--- a/src/new.ts",
	"+++ b/src/new.ts",
	"@@ -1,0 +1,2 @@",
	"+one",
	"+two",
].join("\n");

describe("buildDiffRows", () => {
	it("keeps only the changed lines in compact mode", () => {
		const { rows, hidden, gutter } = buildDiffRows(diff);

		expect(rows).toEqual([
			{ kind: "line", lineNo: 11, prefix: "-", content: "old" },
			{ kind: "line", lineNo: 11, prefix: "+", content: "new" },
			{ kind: "line", lineNo: 12, prefix: "+", content: "extra" },
			{ kind: "separator", text: "⋯" },
			{ kind: "line", lineNo: 30, prefix: "-", content: "old2" },
			{ kind: "line", lineNo: 31, prefix: "+", content: "new2" },
		]);
		expect(hidden).toBe(0);
		expect(gutter).toBe(2);
	});

	it("caps the changed lines and reports how many were hidden", () => {
		const { rows, hidden } = buildDiffRows(diff, { maxLines: 2 });

		expect(rows).toHaveLength(2);
		expect(hidden).toBe(3);
	});

	it("keeps context and hunk headers in review mode", () => {
		const { rows } = buildDiffRows(diff, { context: true });

		expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -10,3 +10,4 @@" });
		expect(rows.filter((row) => row.kind === "line")).toHaveLength(7);
		expect(rows.filter((row) => row.kind === "hunk")).toHaveLength(2);
	});

	it("expands tabs to four spaces for gutter alignment", () => {
		const tabbed = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-old", "+	new"].join("\n");
		const { rows } = buildDiffRows(tabbed);

		expect(rows[1]).toEqual({ kind: "line", lineNo: 1, prefix: "+", content: "    new" });
	});
});

describe("collectSessionDiffs", () => {
	it("collects only calls with diffs, in order, with paths and stats", () => {
		const messages: UIMessage[] = [
			{
				role: "agent",
				content: "",
				toolCalls: [
					{ name: "edit_file", input: "src/a.ts", output: "ok", diff },
					{ name: "read_file", input: "src/b.ts", output: "content" },
				],
			},
			{
				role: "agent",
				content: "",
				toolCalls: [{ name: "write_file", input: "src/new.ts", output: "ok", diff: newFileDiff }],
			},
		];

		expect(collectSessionDiffs(messages)).toEqual([
			{ name: "edit_file", path: "src/a.ts", diff, adds: 3, deletes: 2 },
			{ name: "write_file", path: "src/new.ts", diff: newFileDiff, adds: 2, deletes: 0 },
		]);
	});

	it("returns an empty list when no tool produced a diff", () => {
		const messages: UIMessage[] = [
			{ role: "agent", content: "", toolCalls: [{ name: "read_file", input: "a.ts", output: "x" }] },
		];

		expect(collectSessionDiffs(messages)).toEqual([]);
	});
});
