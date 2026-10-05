import { assertEquals } from "@std/assert";
import { ANSI_SGR_RE, charWidth, codePointWidth, visibleLength } from "../core/primitives/char-width.ts";

Deno.test("codePointWidth - ascii and latin are single width", () => {
	assertEquals(codePointWidth("a".codePointAt(0)!), 1);
	assertEquals(codePointWidth(" ".codePointAt(0)!), 1);
});

Deno.test("codePointWidth - CJK and emoji are double width", () => {
	assertEquals(codePointWidth("你".codePointAt(0)!), 2);
	assertEquals(codePointWidth("😀".codePointAt(0)!), 2);
});

Deno.test("codePointWidth - combining marks are zero width", () => {
	assertEquals(codePointWidth("\u0301".codePointAt(0)!), 0);
});

Deno.test("charWidth - sums code point widths", () => {
	assertEquals(charWidth("abc"), 3);
	assertEquals(charWidth("你好"), 4);
	assertEquals(charWidth("a你b"), 4);
});

Deno.test("visibleLength - ignores SGR escape sequences", () => {
	assertEquals(visibleLength("\x1b[31mred\x1b[39m"), 3);
	assertEquals(visibleLength("\x1b[38;2;1;2;3m你好\x1b[39m"), 4);
});

Deno.test("ANSI_SGR_RE - matches only SGR sequences", () => {
	assertEquals("a\x1b[1;31mb\x1b[0mc".replace(ANSI_SGR_RE, ""), "abc");
});
