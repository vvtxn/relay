import { assert, assertEquals } from "@std/assert";
import { CLEAR_SCREEN, CURSOR_DEFAULT, CURSOR_SHOW, EXIT_ALT_SCREEN, RESET } from "../core/ansi.ts";
import { Terminal } from "../core/terminal.ts";

function fakeStdout(captured: string[], isTTY = true) {
	return {
		columns: 80,
		rows: 24,
		isTTY,
		write: (data: string, callback?: (error?: Error | null) => void) => {
			captured.push(data);
			if (callback) queueMicrotask(() => callback(null));
			return true;
		},
		on: (_event: string, _listener: () => void) => {},
		off: (_event: string, _listener: () => void) => {},
	} as unknown as typeof process.stdout;
}

Deno.test("Terminal.dispose - leaves the alternate screen last", () => {
	const captured: string[] = [];
	const terminal = new Terminal(fakeStdout(captured));
	captured.length = 0;

	terminal.dispose();

	const output = captured.join("");
	assert(output.includes(RESET), "expected SGR reset on teardown");
	assert(output.includes(CLEAR_SCREEN), "expected screen clear on teardown");
	assert(output.includes(CURSOR_DEFAULT), "expected cursor shape restore on teardown");
	assert(output.includes(CURSOR_SHOW), "expected cursor show on teardown");
	assert(output.includes(EXIT_ALT_SCREEN), "expected exit-alternate-screen on teardown");
	assertEquals(
		captured[captured.length - 1],
		EXIT_ALT_SCREEN,
		"exit-alternate-screen must be the final byte written",
	);
	assert(
		output.indexOf(EXIT_ALT_SCREEN) > output.indexOf(RESET),
		"exit-alternate-screen must come after the SGR reset",
	);
});

Deno.test("Terminal.drain - resolves once queued writes flush", async () => {
	const captured: string[] = [];
	const terminal = new Terminal(fakeStdout(captured));
	terminal.dispose();
	await terminal.drain();
	assert(captured.join("").includes(EXIT_ALT_SCREEN));
});

Deno.test("Terminal.dispose - writes no escape bytes when piped", () => {
	const captured: string[] = [];
	const terminal = new Terminal(fakeStdout(captured, false));
	captured.length = 0;

	terminal.dispose();

	assertEquals(captured, []);
});
