import { assertEquals } from "@std/assert";
import { inputManager } from "../core/input.ts";

// splitSequences tests
Deno.test("splitSequences - splits regular characters individually", () => {
	assertEquals(inputManager.splitSequences("abc"), ["a", "b", "c"]);
});

Deno.test("splitSequences - keeps arrow key escape sequences together", () => {
	assertEquals(inputManager.splitSequences("\x1b[A"), ["\x1b[A"]);
	assertEquals(inputManager.splitSequences("\x1b[B"), ["\x1b[B"]);
	assertEquals(inputManager.splitSequences("\x1b[C"), ["\x1b[C"]);
	assertEquals(inputManager.splitSequences("\x1b[D"), ["\x1b[D"]);
});

Deno.test("splitSequences - handles mixed input", () => {
	assertEquals(inputManager.splitSequences("a\x1b[Cb"), ["a", "\x1b[C", "b"]);
});

Deno.test("splitSequences - handles numeric escape sequences", () => {
	assertEquals(inputManager.splitSequences("\x1b[3~"), ["\x1b[3~"]);
	assertEquals(inputManager.splitSequences("\x1b[1~"), ["\x1b[1~"]);
});

Deno.test("splitSequences - handles escape sequences with semicolons", () => {
	assertEquals(inputManager.splitSequences("\x1b[1;5C"), ["\x1b[1;5C"]);
});

Deno.test("splitSequences - handles multiple escape sequences", () => {
	assertEquals(inputManager.splitSequences("\x1b[A\x1b[B"), ["\x1b[A", "\x1b[B"]);
});

// parseKey tests - arrow keys
Deno.test("parseKey - parses arrow keys", () => {
	assertEquals(inputManager.parseKey("\x1b[A").key, "up");
	assertEquals(inputManager.parseKey("\x1b[B").key, "down");
	assertEquals(inputManager.parseKey("\x1b[C").key, "right");
	assertEquals(inputManager.parseKey("\x1b[D").key, "left");
});

// parseKey tests - home/end
Deno.test("parseKey - parses home key variants", () => {
	assertEquals(inputManager.parseKey("\x1b[H").key, "home");
	assertEquals(inputManager.parseKey("\x1b[1~").key, "home");
});

Deno.test("parseKey - parses end key variants", () => {
	assertEquals(inputManager.parseKey("\x1b[F").key, "end");
	assertEquals(inputManager.parseKey("\x1b[4~").key, "end");
});

// parseKey tests - special keys
Deno.test("parseKey - parses delete key", () => {
	assertEquals(inputManager.parseKey("\x1b[3~").key, "delete");
});

Deno.test("parseKey - parses enter key", () => {
	assertEquals(inputManager.parseKey("\r").key, "enter");
});

Deno.test("parseKey - parses backspace", () => {
	assertEquals(inputManager.parseKey("\x7f").key, "backspace");
	assertEquals(inputManager.parseKey("\b").key, "backspace");
});

Deno.test("parseKey - parses escape", () => {
	assertEquals(inputManager.parseKey("\x1b").key, "escape");
});

Deno.test("parseKey - parses tab", () => {
	assertEquals(inputManager.parseKey("\t").key, "tab");
});

// parseKey tests - ctrl combinations
Deno.test("parseKey - parses ctrl+c", () => {
	const event = inputManager.parseKey("\x03");
	assertEquals(event.key, "c");
	assertEquals(event.ctrl, true);
});

Deno.test("parseKey - parses ctrl+a through ctrl+z", () => {
	for (let i = 1; i <= 26; i++) {
		const event = inputManager.parseKey(String.fromCharCode(i));
		// Special cases: ctrl+c (3), ctrl+h (8 = backspace), ctrl+i (9 = tab), ctrl+m (13 = enter)
		if (i === 3) {
			assertEquals(event.key, "c");
			assertEquals(event.ctrl, true);
		} else if (i === 8) {
			assertEquals(event.key, "backspace");
		} else if (i === 9) {
			assertEquals(event.key, "tab");
		} else if (i === 13) {
			assertEquals(event.key, "enter");
		} else {
			assertEquals(event.key, String.fromCharCode(i + 96));
			assertEquals(event.ctrl, true);
		}
	}
});

// parseKey tests - regular characters
Deno.test("parseKey - parses regular characters", () => {
	assertEquals(inputManager.parseKey("a").key, "a");
	assertEquals(inputManager.parseKey("Z").key, "Z");
	assertEquals(inputManager.parseKey("1").key, "1");
	assertEquals(inputManager.parseKey(" ").key, " ");
});

// SGR mouse sequences
Deno.test("splitSequences - keeps SGR mouse reports together", () => {
	assertEquals(inputManager.splitSequences("\x1b[<64;10;5M"), ["\x1b[<64;10;5M"]);
	assertEquals(inputManager.splitSequences("\x1b[<0;1;2m"), ["\x1b[<0;1;2m"]);
});

Deno.test("parseKey - maps SGR wheel events", () => {
	assertEquals(inputManager.parseKey("\x1b[<64;10;5M").key, "wheelup");
	assertEquals(inputManager.parseKey("\x1b[<65;10;5M").key, "wheeldown");
});

Deno.test("parseKey - consumes other mouse events", () => {
	assertEquals(inputManager.parseKey("\x1b[<0;10;5M").key, "mouse");
	assertEquals(inputManager.parseKey("\x1b[<0;10;5m").key, "mouse");
});
