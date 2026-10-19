// Grouping tests for the compact tool-call display: first-seen tool order,
// capped target lists, aggregated result stats, and error/pending handling.

import { describe, expect, it } from "vite-plus/test";
import { diffStats, groupToolCalls, parseDiff, parseDiffLines, type UIToolCall } from "../core/display.ts";

function tool(name: string, input: string, output = "", extra: Partial<UIToolCall> = {}): UIToolCall {
	return { name, input, output, ...extra };
}

describe("groupToolCalls", () => {
	it("groups by tool in first-seen order and aggregates stats", () => {
		const groups = groupToolCalls([
			tool("read_file", "a.ts", "1\n2"),
			tool("grep", "foo", "a.ts:1:foo"),
			tool("read_file", "b.ts", "1\n2\n3"),
		]);

		expect(groups.map((group) => group.name)).toEqual(["read_file", "grep"]);
		expect(groups[0]?.label).toBe("read");
		expect(groups[0]?.args).toBe("a.ts, b.ts");
		expect(groups[0]?.stat).toBe("5 lines");
		expect(groups[1]?.args).toBe('"foo"');
		expect(groups[1]?.stat).toBe("1 match in 1 file");
	});

	it("deduplicates repeated targets", () => {
		const groups = groupToolCalls([tool("read_file", "a.ts", "x"), tool("read_file", "a.ts", "x")]);
		expect(groups[0]?.args).toBe("a.ts");
	});

	it("caps the target list at three items with a +N more suffix", () => {
		const groups = groupToolCalls([
			tool("read_file", "a.ts", "x"),
			tool("read_file", "b.ts", "x"),
			tool("read_file", "c.ts", "x"),
			tool("read_file", "d.ts", "x"),
			tool("read_file", "e.ts", "x"),
		]);
		expect(groups[0]?.args).toBe("a.ts, b.ts, c.ts +2 more");
	});

	it("truncates a single overlong target to the length budget", () => {
		const long = "packages/cli/tui/render/components/command-palette.tsx";
		const groups = groupToolCalls([tool("read_file", long, "x")]);
		expect(groups[0]?.args.length).toBeLessThanOrEqual(44);
		expect(groups[0]?.args.startsWith("packages/cli")).toBe(true);
		expect(groups[0]?.args.endsWith("…")).toBe(true);
	});

	it("keeps overlong targets plus the +N more suffix within the budget", () => {
		const long = "packages/cli/tui/render/components/command-palette.tsx";
		const groups = groupToolCalls([tool("read_file", long, "x"), tool("read_file", "b.ts", "x")]);
		expect(groups[0]?.args).toContain("+1 more");
		expect(groups[0]?.args.length).toBeLessThanOrEqual(44);
	});

	it("counts grep matches and distinct files", () => {
		const groups = groupToolCalls([tool("grep", "border", "a.ts:1:border\nb.ts:2:border\na.ts:9:border")]);
		expect(groups[0]?.stat).toBe("3 matches in 2 files");
	});

	it("reports no matches when every search came back empty", () => {
		const groups = groupToolCalls([tool("grep", "a", "No matches found."), tool("grep", "b", "No matches found.")]);
		expect(groups[0]?.stat).toBe("no matches");
	});

	it("sums diff stats for edit and write calls", () => {
		const diff = ["--- a.ts", "+++ a.ts", "@@ -1,2 +1,2 @@", "-old", "+new", "+extra"].join("\n");
		const groups = groupToolCalls([tool("edit_file", "a.ts", "ok", { diff })]);
		expect(groups[0]?.stat).toBe("+2 −1");
	});

	it("falls back to a file count when no diff is available", () => {
		const groups = groupToolCalls([tool("write_file", "a.ts", "ok"), tool("write_file", "b.ts", "ok")]);
		expect(groups[0]?.stat).toBe("2 files");
	});

	it("reports running… while any call in the group is pending", () => {
		const groups = groupToolCalls([tool("bash", "npm test"), tool("bash", "npm build", "done")]);
		expect(groups[0]?.stat).toBe("running…");
	});

	it("counts errors separately and excludes them from stats", () => {
		const groups = groupToolCalls([
			tool("read_file", "a.ts", "1\n2"),
			tool("read_file", "b.ts", "boom", { isError: true }),
		]);
		expect(groups[0]?.stat).toBe("2 lines");
		expect(groups[0]?.errorCount).toBe(1);
	});

	it("shows no stat for a single bash command", () => {
		const groups = groupToolCalls([tool("bash", "npm test", "ok")]);
		expect(groups[0]?.stat).toBe("");
		expect(groups[0]?.args).toBe("npm test");
	});

	it("keeps the underlying calls for per-call detail rendering", () => {
		const diff = ["--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
		const groups = groupToolCalls([tool("edit_file", "a.ts", "ok", { diff }), tool("read_file", "b.ts", "x")]);
		expect(groups[0]?.calls).toHaveLength(1);
		expect(groups[0]?.calls[0]?.input).toBe("a.ts");
	});
});

describe("parseDiff", () => {
	const patch = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -10,3 +10,4 @@",
		" context",
		"-old",
		"+new",
		"+extra",
		" context2",
		"@@ -30,2 +31,2 @@",
		"-old2",
		"+new2",
	].join("\n");

	it("parses the file path, hunks, and line numbers", () => {
		const [file] = parseDiff(patch);

		expect(file?.path).toBe("src/a.ts");
		expect(file?.hunks).toHaveLength(2);
		expect(file?.hunks[0]?.header).toBe("@@ -10,3 +10,4 @@");
		expect(file?.hunks[0]?.lines).toEqual([
			{ lineNo: 10, prefix: " ", content: "context" },
			{ lineNo: 11, prefix: "-", content: "old" },
			{ lineNo: 11, prefix: "+", content: "new" },
			{ lineNo: 12, prefix: "+", content: "extra" },
			{ lineNo: 13, prefix: " ", content: "context2" },
		]);
	});

	it("treats header-looking content as changed lines inside a hunk", () => {
		const tricky = [
			"diff --git a/a.txt b/a.txt",
			"--- a/a.txt",
			"+++ b/a.txt",
			"@@ -1,2 +1,2 @@",
			"--- removed heading",
			"+++ added heading",
		].join("\n");

		expect(parseDiff(tricky)[0]?.hunks[0]?.lines).toEqual([
			{ lineNo: 1, prefix: "-", content: "-- removed heading" },
			{ lineNo: 1, prefix: "+", content: "++ added heading" },
		]);
	});

	it("flattens to the legacy parseDiffLines output", () => {
		expect(parseDiffLines(patch)).toEqual(parseDiff(patch).flatMap((file) => file.hunks.flatMap((h) => h.lines)));
	});

	it("starts a new file at ---/+++ when diff --git is absent", () => {
		const multi = [
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -1 +1 @@",
			"-old2",
			"+new2",
		].join("\n");
		const files = parseDiff(multi);

		expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
		expect(files[1]?.hunks[0]?.lines[0]).toEqual({ lineNo: 1, prefix: "-", content: "old2" });
	});

	it("ignores trailing blank lines and no-newline markers", () => {
		const withMarker = [
			"--- a/a.txt",
			"+++ b/a.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"\\ No newline at end of file",
			"",
		].join("\n");

		expect(parseDiffLines(withMarker)).toEqual([
			{ lineNo: 1, prefix: "-", content: "old" },
			{ lineNo: 1, prefix: "+", content: "new" },
		]);
	});
});

describe("diffStats", () => {
	it("counts only hunk bodies, not file headers or header-looking content", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,3 @@",
			"--- removed heading",
			"+++ added heading",
			"+++ another addition",
		].join("\n");

		expect(diffStats(patch)).toEqual({ adds: 2, deletes: 1 });
	});

	it("returns zeroes for a patch without hunks", () => {
		expect(diffStats("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts")).toEqual({ adds: 0, deletes: 0 });
	});
});
