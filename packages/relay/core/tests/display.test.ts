import { assertEquals } from "@std/assert";
import { abbreviateHome, expandHome, parseDiffLines, summarizeToolArgs } from "../display.ts";

Deno.test("abbreviateHome - uses the known home directory", () => {
	assertEquals(abbreviateHome("/home/magni/projects/relay", "/home/magni"), "~/projects/relay");
	assertEquals(abbreviateHome("/home/magni", "/home/magni"), "~");
});

Deno.test("abbreviateHome - falls back to common home prefixes", () => {
	assertEquals(abbreviateHome("/home/magni/projects/relay"), "~/projects/relay");
	assertEquals(abbreviateHome("/Users/magni/code"), "~/code");
	assertEquals(abbreviateHome("/home/magni"), "~");
});

Deno.test("abbreviateHome - leaves unrelated paths alone", () => {
	assertEquals(abbreviateHome("/var/log/relay", "/home/magni"), "/var/log/relay");
	assertEquals(abbreviateHome("/opt/project", "/home/magni"), "/opt/project");
});

Deno.test("expandHome - restores a leading tilde", () => {
	assertEquals(expandHome("~/projects/relay", "/home/magni"), "/home/magni/projects/relay");
	assertEquals(expandHome("~", "/home/magni"), "/home/magni");
	assertEquals(expandHome("/abs/path", "/home/magni"), "/abs/path");
});

Deno.test("expandHome - is a no-op without a home directory", () => {
	assertEquals(expandHome("~/projects", undefined), "~/projects");
});

Deno.test("summarizeToolArgs - extracts the salient argument per tool", () => {
	assertEquals(summarizeToolArgs("bash", '{"command":"ls -la"}'), "ls -la");
	assertEquals(summarizeToolArgs("read_file", '{"path":"/tmp/a.ts"}'), "/tmp/a.ts");
	assertEquals(summarizeToolArgs("grep", '{"pattern":"TODO"}'), "TODO");
});

Deno.test("parseDiffLines - parses a unified diff hunk", () => {
	const lines = parseDiffLines("@@ -1,2 +1,2 @@\n-old\n+new\n same");
	assertEquals(lines, [
		{ lineNo: 1, prefix: "-", content: "old" },
		{ lineNo: 1, prefix: "+", content: "new" },
		{ lineNo: 2, prefix: " ", content: "same" },
	]);
});
