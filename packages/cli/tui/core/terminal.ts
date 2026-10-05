import process from "node:process";
import { type Signal, signal } from "@preact/signals-core";
import type { Cell } from "../render/types/index.ts";
import {
	CLEAR_SCREEN,
	CURSOR_BLOCK,
	CURSOR_DEFAULT,
	CURSOR_HIDE,
	CURSOR_SHOW,
	cursorTo,
	ENTER_ALT_SCREEN,
	EXIT_ALT_SCREEN,
	MOUSE_DISABLE,
	MOUSE_ENABLE,
	OSC_RESET_BACKGROUND,
	oscSetBackground,
	RESET,
	SYNC_END,
	SYNC_START,
} from "./ansi.ts";
import { charWidth } from "./primitives/char-width.ts";
import { toBgAnsi } from "./primitives/color.ts";

export interface TerminalOptions {
	/**
	 * Default background color (name or `#rrggbb`). Painted into every cell of
	 * the grid so the app background always spans the full terminal, and — for
	 * hex values — applied to the terminal itself via OSC 11 (restored on exit).
	 */
	defaultBg?: string | undefined;
}

export interface TerminalSize {
	width: number;
	height: number;
}

function normalizeHex(color?: string): string | null {
	if (!color) return null;
	const match = color.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!match) return null;
	const digits = match[1]!;
	const full = digits.length === 3 ? digits.split("").map((d) => d + d).join("") : digits;
	return `#${full.toLowerCase()}`;
}

export class Terminal {
	stdout: typeof process.stdout;
	width: number;
	height: number;
	/** Reactive terminal size — renderers can subscribe to re-layout on resize. */
	readonly size: Signal<TerminalSize>;
	currentBuffer: Cell[][];
	previousBuffer: Cell[][];
	isFirstRender: boolean = true;
	cursorVisible: boolean = true;
	cursorX: number = -1;
	cursorY: number = -1;
	private defaultStyle: string = "";
	private defaultBgHex: string | null = null;
	private mouseEnabled: boolean = false;
	private resizeHandler: (() => void) | null = null;
	private disposed: boolean = false;
	private frameBuffer: string = "";
	private batching: boolean = false;

	constructor(stdout: typeof process.stdout = process.stdout, options: TerminalOptions = {}) {
		this.stdout = stdout;
		this.width = this.stdout.columns || 80;
		this.height = this.stdout.rows || 24;
		this.defaultBgHex = normalizeHex(options.defaultBg);
		this.defaultStyle = options.defaultBg ? (toBgAnsi(options.defaultBg) ?? "") : "";
		this.size = signal<TerminalSize>({ width: this.width, height: this.height });
		this.currentBuffer = this.createEmptyBuffer();
		this.previousBuffer = this.createEmptyBuffer();

		this.setupResizeHandler();
		this.enterAlternateScreen();
		this.applyDefaultBackground();
		this.enableMouseTracking();
		this.write(CURSOR_BLOCK);
		this.hideCursor();
		this.clearScreen();
	}

	private isTTY(): boolean {
		return this.stdout.isTTY ?? false;
	}

	private write(data: string) {
		if (this.batching) {
			this.frameBuffer += data;
		} else {
			this.stdout.write(data);
		}
	}

	/**
	 * Resolve once all queued stdout writes have been flushed to the
	 * terminal. Await this before process exit — otherwise teardown bytes
	 * (e.g. exit-alternate-screen) can be dropped and the terminal is left
	 * showing the last frame.
	 */
	drain(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.stdout.write("", (error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	beginFrame() {
		this.batching = true;
		this.frameBuffer = SYNC_START;
	}

	endFrame() {
		this.frameBuffer += SYNC_END;
		this.batching = false;
		this.stdout.write(this.frameBuffer);
		this.frameBuffer = "";
	}

	private setupResizeHandler() {
		if (!this.isTTY()) return;

		this.resizeHandler = () => {
			this.width = this.stdout.columns || 80;
			this.height = this.stdout.rows || 24;
			this.size.value = { width: this.width, height: this.height };
			this.currentBuffer = this.createEmptyBuffer();
			this.previousBuffer = this.createEmptyBuffer();
			this.isFirstRender = true;
			this.clearScreen();
		};

		this.stdout.on("resize", this.resizeHandler);
	}

	private blankCell(): Cell {
		return { char: " ", style: this.defaultStyle };
	}

	private createEmptyBuffer(): Cell[][] {
		return Array.from(
			{ length: this.height },
			() => Array.from({ length: this.width }, () => this.blankCell()),
		);
	}

	private clearScreen() {
		if (!this.isTTY()) return;
		this.write(CLEAR_SCREEN);
	}

	private applyDefaultBackground() {
		if (!this.isTTY() || !this.defaultBgHex) return;
		this.write(oscSetBackground(this.defaultBgHex));
	}

	enterAlternateScreen() {
		if (!this.isTTY()) return;
		this.write(ENTER_ALT_SCREEN);
	}

	exitAlternateScreen() {
		if (!this.isTTY()) return;
		this.write(EXIT_ALT_SCREEN);
	}

	private enableMouseTracking() {
		if (!this.isTTY() || this.mouseEnabled) return;
		this.write(MOUSE_ENABLE);
		this.mouseEnabled = true;
	}

	private disableMouseTracking() {
		if (!this.isTTY() || !this.mouseEnabled) return;
		this.write(MOUSE_DISABLE);
		this.mouseEnabled = false;
	}

	hideCursor() {
		if (!this.isTTY()) return;
		if (this.cursorVisible) {
			this.write(CURSOR_HIDE);
			this.cursorVisible = false;
		}
	}

	showCursor() {
		if (!this.isTTY()) return;
		if (!this.cursorVisible) {
			this.write(CURSOR_SHOW);
			this.cursorVisible = true;
		}
	}

	setCursorPosition(x: number, y: number) {
		if (!this.isTTY()) return;
		if (this.cursorX !== x || this.cursorY !== y) {
			this.write(cursorTo(y + 1, x + 1));
			this.cursorX = x;
			this.cursorY = y;
		}
	}

	/**
	 * Parse a styled string into per-character cells. Iterates by code point so
	 * surrogate pairs (emoji) stay intact, and resets to the terminal's default
	 * style on SGR reset so backgrounds are never lost mid-string.
	 */
	private extractStyle(str: string): Array<{ char: string; style: string }> {
		const out: Array<{ char: string; style: string }> = [];
		let currentStyle = this.defaultStyle;
		let i = 0;

		while (i < str.length) {
			const cp = str.codePointAt(i) ?? 0;

			if (cp === 0x1b && str[i + 1] === "[") {
				let j = i + 2;
				while (j < str.length && str[j] !== "m") j++;
				const sequence = str.slice(i, j + 1);
				if (sequence === RESET) {
					currentStyle = this.defaultStyle;
				} else {
					currentStyle += sequence;
				}
				i = j + 1;
				continue;
			}

			const ch = String.fromCodePoint(cp);
			const sanitized = ch === "\n" || ch === "\r" || ch === "\t" ? " " : ch;
			out.push({ char: sanitized, style: currentStyle });
			i += ch.length;
		}

		return out;
	}

	/** Clear any double-width character overlapping `col` so cells never desync. */
	private clearWideNeighbors(row: Cell[], col: number) {
		const cell = row[col];
		if (!cell) return;
		if (cell.cont) {
			const lead = col - 1 >= 0 ? row[col - 1] : undefined;
			if (lead) row[col - 1] = this.blankCell();
		} else if (charWidth(cell.char) === 2 && col + 1 < this.width) {
			const next = row[col + 1];
			if (next?.cont) row[col + 1] = this.blankCell();
		}
	}

	private writeToBuffer(x: number, y: number, text: string) {
		if (y < 0 || y >= this.height) return;

		const row = this.currentBuffer[y];
		if (!row) return;

		const cells = this.extractStyle(text);
		let col = x;

		for (const { char, style } of cells) {
			const width = charWidth(char);

			if (width === 0) {
				const prev = col - 1;
				if (prev >= 0 && prev < this.width) {
					const prevCell = row[prev];
					if (prevCell && !prevCell.cont) prevCell.char += char;
				}
				continue;
			}

			if (col < 0 || col >= this.width) {
				col += width;
				continue;
			}

			if (width === 2 && col + 1 >= this.width) {
				// Not enough room for a double-width glyph — render a space.
				this.clearWideNeighbors(row, col);
				row[col] = { char: " ", style };
				col += width;
				continue;
			}

			this.clearWideNeighbors(row, col);
			if (width === 2) this.clearWideNeighbors(row, col + 1);
			row[col] = { char, style };
			if (width === 2) row[col + 1] = { char: "", style, cont: true };
			col += width;
		}
	}

	render(positions: Array<{ x: number; y: number; text: string }>) {
		this.clearBuffer(this.currentBuffer);

		for (const { x, y, text } of positions) {
			this.writeToBuffer(Math.round(x), Math.round(y), text);
		}

		this.flush();
	}

	private clearBuffer(buffer: Cell[][]) {
		for (let y = 0; y < this.height; y++) {
			const row = buffer[y];
			if (!row) continue;
			for (let x = 0; x < this.width; x++) {
				const cell = row[x];
				if (cell) {
					cell.char = " ";
					cell.style = this.defaultStyle;
					cell.cont = false;
				}
			}
		}
	}

	private flush() {
		if (!this.isTTY()) return;

		let output = "";

		for (let y = 0; y < this.height; y++) {
			const currentRow = this.currentBuffer[y];
			const previousRow = this.previousBuffer[y];
			if (!currentRow || !previousRow) continue;

			let runStart = -1;
			let run = "";
			let runStyle = "";
			let runStyleSet = false;

			const endRun = () => {
				if (runStart < 0) return;
				output += cursorTo(y + 1, runStart + 1) + run + RESET;
				runStart = -1;
				run = "";
				runStyle = "";
				runStyleSet = false;
			};

			for (let x = 0; x < this.width; x++) {
				const current = currentRow[x];
				const previous = previousRow[x];
				if (!current || !previous) continue;
				if (current.cont) continue;

				const changed = this.isFirstRender ||
					current.char !== previous.char ||
					current.style !== previous.style;

				if (!changed) {
					endRun();
					continue;
				}

				if (runStart < 0) runStart = x;
				if (!runStyleSet || current.style !== runStyle) {
					run += RESET + current.style;
					runStyle = current.style;
					runStyleSet = true;
				}
				run += current.char;
			}

			endRun();
		}

		if (output) {
			this.write(output);
			this.cursorX = -1;
			this.cursorY = -1;
		}

		[this.previousBuffer, this.currentBuffer] = [this.currentBuffer, this.previousBuffer];
		this.isFirstRender = false;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;

		if (this.resizeHandler) {
			this.stdout.off("resize", this.resizeHandler);
			this.resizeHandler = null;
		}

		this.currentBuffer = this.createEmptyBuffer();
		this.previousBuffer = this.createEmptyBuffer();
		this.isFirstRender = true;
		// Teardown mirrors setup: every write below is TTY-only, so piped
		// output never gets escape bytes. Leaving the alternate screen must
		// be the final byte written.
		if (!this.isTTY()) return;
		// Reset attributes and blank the alternate screen so no styled frame
		// leaks if the terminal never processes the exit sequence.
		this.write(RESET);
		this.clearScreen();
		this.write(CURSOR_DEFAULT);
		this.showCursor();
		this.disableMouseTracking();
		if (this.defaultBgHex) this.write(OSC_RESET_BACKGROUND);
		this.exitAlternateScreen();
	}

	/** @deprecated Use dispose() instead */
	clear() {
		this.dispose();
	}
}
