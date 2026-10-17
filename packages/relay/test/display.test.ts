// Grouping tests for the compact tool-call display: first-seen tool order,
// capped target lists, aggregated result stats, and error/pending handling.

import { describe, expect, it } from "vite-plus/test";
import { groupToolCalls, type UIToolCall } from "../core/display.ts";

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
});
