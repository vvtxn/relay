import { assertEquals } from "@std/assert";
import { safeUrl } from "./safe-url.ts";

Deno.test("safeUrl - rejects script and data schemes", () => {
	assertEquals(safeUrl("javascript:alert(1)"), null);
	assertEquals(safeUrl("JaVaScRiPt:alert(1)"), null);
	assertEquals(safeUrl("java\tscript:alert(1)"), null);
	assertEquals(safeUrl("java\nscript:alert(1)"), null);
	assertEquals(safeUrl(" vbscript:msgbox(1)"), null);
	assertEquals(safeUrl("data:text/html,<script>alert(1)</script>"), null);
	assertEquals(safeUrl("file:///etc/passwd"), null);
});

Deno.test("safeUrl - allows http, https, and mailto", () => {
	assertEquals(safeUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
	assertEquals(safeUrl("http://example.com"), "http://example.com");
	assertEquals(safeUrl("mailto:dev@example.com"), "mailto:dev@example.com");
});

Deno.test("safeUrl - allows relative and same-origin references", () => {
	assertEquals(safeUrl("/s/abc"), "/s/abc");
	assertEquals(safeUrl("#section"), "#section");
	assertEquals(safeUrl("?q=1"), "?q=1");
	assertEquals(safeUrl("./relative"), "./relative");
	assertEquals(safeUrl("../up"), "../up");
	assertEquals(safeUrl("no-scheme/path"), "no-scheme/path");
});

Deno.test("safeUrl - rejects empty input", () => {
	assertEquals(safeUrl(undefined), null);
	assertEquals(safeUrl(null), null);
	assertEquals(safeUrl(""), null);
	assertEquals(safeUrl("   "), null);
});
