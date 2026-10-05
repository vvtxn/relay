import { assertEquals } from "@std/assert";
import { splitText, wrapText, wrapTextWithOffsets } from "../core/primitives/wrap-text.ts";
import { stripAnsi } from "../core/primitives/char-width.ts";

Deno.test("wrapText - wraps long text at word boundaries", () => {
	const result = wrapText("hello world foo", 10);
	assertEquals(result, ["hello", "world foo"]);
});

Deno.test("wrapText - breaks words longer than width", () => {
	const result = wrapText("abcdefghij", 4);
	assertEquals(result, ["abcd", "efgh", "ij"]);
});

Deno.test("wrapText - handles empty string", () => {
	const result = wrapText("", 10);
	assertEquals(result, [""]);
});

Deno.test("wrapText - handles width of 0", () => {
	const result = wrapText("hello", 0);
	assertEquals(result, []);
});

Deno.test("wrapText - preserves single words shorter than width", () => {
	const result = wrapText("hi", 10);
	assertEquals(result, ["hi"]);
});

Deno.test("splitText - splits text at exact character boundaries", () => {
	const result = splitText("abcdefghij", 4);
	assertEquals(result, ["abcd", "efgh", "ij"]);
});

Deno.test("splitText - handles text shorter than width", () => {
	const result = splitText("abc", 10);
	assertEquals(result, ["abc"]);
});

Deno.test("splitText - handles empty string", () => {
	const result = splitText("", 10);
	assertEquals(result, [""]);
});

Deno.test("splitText - handles exact width match", () => {
	const result = splitText("abcd", 4);
	assertEquals(result, ["abcd"]);
});

Deno.test("wrapText - does not count ANSI escape sequences toward width", () => {
	const result = wrapText("\x1b[31mhello\x1b[39m world", 10);
	assertEquals(result.map(stripAnsi), ["hello", "world"]);
});

Deno.test("wrapText - keeps escape sequences intact when hard-wrapping", () => {
	const ESC = String.fromCharCode(27);
	const source = "\x1b[38;2;1;2;3mabcdef\x1b[39m";
	const result = wrapText(source, 3);
	assertEquals(result.map(stripAnsi), ["abc", "def"]);
	const escapes = source.split(ESC).length - 1;
	const resultEscapes = result.reduce((sum, line) => sum + line.split(ESC).length - 1, 0);
	assertEquals(resultEscapes, escapes, "no escape sequence should be dropped or split");
});

Deno.test("wrapText - preserves leading and repeated spaces", () => {
	assertEquals(wrapText("  a  b", 10), ["  a  b"]);
});

Deno.test("wrapText - counts wide characters as two cells", () => {
	assertEquals(wrapText("你好世界", 4), ["你好", "世界"]);
});

Deno.test("wrapTextWithOffsets - startIndex tracks the original string", () => {
	assertEquals(wrapTextWithOffsets("hello world", 5), [
		{ line: "hello", startIndex: 0 },
		{ line: "world", startIndex: 6 },
	]);
});
