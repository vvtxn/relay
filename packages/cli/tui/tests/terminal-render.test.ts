import { assert, assertEquals } from "@std/assert";
import type { VNode } from "../render/jsx-runtime.ts";
import { Renderer } from "../render/renderer.ts";
import { Terminal } from "../core/terminal.ts";

interface FakeStdout {
	stdout: typeof process.stdout;
	captured: string[];
	resizeListeners: Array<() => void>;
}

function fakeStdout(options: { columns: number; rows: number; isTTY: boolean }): FakeStdout {
	const captured: string[] = [];
	const resizeListeners: Array<() => void> = [];
	const stdout = {
		columns: options.columns,
		rows: options.rows,
		isTTY: options.isTTY,
		write: (data: string, callback?: (error?: Error | null) => void) => {
			captured.push(data);
			if (callback) queueMicrotask(() => callback(null));
			return true;
		},
		on: (event: string, listener: () => void) => {
			if (event === "resize") resizeListeners.push(listener);
		},
		off: (_event: string, _listener: () => void) => {},
	} as unknown as typeof process.stdout;
	return { stdout, captured, resizeListeners };
}

function box(props: Record<string, unknown>, ...children: unknown[]): VNode {
	return { type: "box", props: { ...props, children } } as unknown as VNode;
}

function text(children: string): VNode {
	return { type: "text", props: { children } } as unknown as VNode;
}

Deno.test("Terminal - default background covers unpainted cells", () => {
	const { stdout } = fakeStdout({ columns: 40, rows: 6, isTTY: false });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });
	const renderer = new Renderer(terminal);

	renderer.commitRender(box({ flex: true, flexDirection: "column" }, text("hi")));

	for (const row of terminal.currentBuffer) {
		for (const cell of row) {
			assert(cell.style.includes("48;2;10;10;10"), `cell ${JSON.stringify(cell)} missing default bg`);
		}
	}
});

Deno.test("Terminal - SGR reset restores the default background", () => {
	const { stdout } = fakeStdout({ columns: 10, rows: 3, isTTY: false });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });

	terminal.render([{ x: 0, y: 0, text: "\x1b[31ma\x1b[0mb" }]);

	const row = terminal.currentBuffer[0]!;
	assert(row[0]!.style.includes("48;2;10;10;10"), "first cell should keep default bg");
	assert(row[1]!.style.includes("48;2;10;10;10"), "bg must survive a full reset");
	assert(!row[1]!.style.includes("[31m"), "fg must be cleared by reset");
});

Deno.test("Box - nested surface background survives a full reset in child text", () => {
	const { stdout } = fakeStdout({ columns: 20, rows: 3, isTTY: false });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });
	const renderer = new Renderer(terminal);

	renderer.commitRender(
		box(
			{ flex: true, flexDirection: "column", bgColor: "#101010" },
			text("a\x1b[31mb\x1b[0mc"),
		),
	);

	const row = terminal.currentBuffer[0]!;
	for (let x = 0; x < 3; x++) {
		assert(
			row[x]!.style.includes("48;2;16;16;16"),
			`cell ${x} (${JSON.stringify(row[x]!.char)}) lost the surface bg`,
		);
	}
});

Deno.test("Terminal - double-width characters occupy two cells", () => {
	const { stdout } = fakeStdout({ columns: 10, rows: 3, isTTY: false });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });

	terminal.render([{ x: 0, y: 0, text: "你x" }]);

	const row = terminal.currentBuffer[0]!;
	assertEquals(row[0]!.char, "你");
	assertEquals(row[1]!.cont, true);
	assertEquals(row[2]!.char, "x");
});

Deno.test("Terminal - flush batches contiguous cells into runs", () => {
	const { stdout, captured } = fakeStdout({ columns: 10, rows: 3, isTTY: true });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });
	captured.length = 0;

	terminal.beginFrame();
	terminal.render([{ x: 0, y: 0, text: "ab" }]);
	terminal.endFrame();

	const frame = captured.join("");
	const ESC = String.fromCharCode(27);
	const cursorMoves = frame.split(ESC).filter((part) => /^\[[0-9]+;[0-9]+H/.test(part)).length;
	assert(cursorMoves <= 3, `expected at most one cursor move per row, got ${cursorMoves}`);
});

Deno.test("Terminal - sets and restores OSC 11 background and mouse tracking", () => {
	const { stdout, captured } = fakeStdout({ columns: 10, rows: 3, isTTY: true });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });

	const setup = captured.join("");
	assert(setup.includes("]11;#0a0a0a"), "expected OSC 11 to set the terminal background");
	assert(setup.includes("?1006h"), "expected mouse tracking to be enabled");

	captured.length = 0;
	terminal.dispose();

	const teardown = captured.join("");
	assert(teardown.includes("]111"), "expected OSC 11 background reset");
	assert(teardown.includes("?1006l"), "expected mouse tracking to be disabled");
});

Deno.test("Terminal - resize updates the size signal", () => {
	const { stdout, resizeListeners } = fakeStdout({ columns: 30, rows: 5, isTTY: true });
	const terminal = new Terminal(stdout);

	const mutable = stdout as unknown as { columns: number; rows: number };
	mutable.columns = 50;
	mutable.rows = 10;
	resizeListeners[0]!();

	assertEquals(terminal.size.value, { width: 50, height: 10 });
});

Deno.test("Box - bgColor fills the entire box rect including edges", () => {
	const { stdout } = fakeStdout({ columns: 24, rows: 8, isTTY: false });
	const terminal = new Terminal(stdout, { defaultBg: "#0A0A0A" });
	const renderer = new Renderer(terminal);

	renderer.commitRender(
		box(
			{ flex: true, flexDirection: "column", padding: 1, bgColor: "#0A0A0A" },
			box({ width: 16, height: 5, bgColor: "#101010" }),
		),
	);

	const buf = terminal.currentBuffer;
	const SURFACE = "48;2;16;16;16";
	for (let y = 1; y <= 5; y++) {
		for (let x = 1; x <= 16; x++) {
			assert(buf[y]![x]!.style.includes(SURFACE), `cell (${x},${y}) should carry the box bg`);
		}
	}
});
