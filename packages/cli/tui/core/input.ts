import process from "node:process";
import { batch } from "@preact/signals-core";
import { CSI } from "#/tui/core/ansi.ts";
import { dispatchPointer } from "#/tui/core/pointer.ts";

/** Decoded SGR mouse report. Coordinates are 0-based terminal cells. */
export interface MouseInfo {
	x: number;
	y: number;
	/** Pressed/released button; `null` for motion-free reports and wheel events. */
	button: "left" | "middle" | "right" | null;
	action: "press" | "release" | "move";
	shift: boolean;
	ctrl: boolean;
	meta: boolean;
}

export interface KeyEvent {
	/** Key name. Mouse reports use `mouse` (or `wheelup`/`wheeldown`/…) and carry `mouse`. */
	key: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	mouse?: MouseInfo;
}

export type KeyHandler = (event: KeyEvent) => boolean | void;

/** CSI final byte range (0x40–0x7e). */
function isFinalByte(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

/** True for an OSC body we asked the terminal about (10/11/4 replies). */
function isTerminalReply(body: string): boolean {
	return /^(10|11|4);/.test(body);
}

/** True while an incomplete OSC body could still become a terminal reply. */
function isReplyPrefix(body: string): boolean {
	return (
		body === "" ||
		body === "1" ||
		body === "10" ||
		body === "11" ||
		body === "4" ||
		body.startsWith("10;") ||
		body.startsWith("11;") ||
		body.startsWith("4;")
	);
}

/** SGR modifier bits (`button` field). */
const MOUSE_SHIFT = 4;
const MOUSE_META = 8;
const MOUSE_CTRL = 16;
/** Motion-while-pressed flag; set by terminals with button-event tracking. */
const MOUSE_MOTION = 32;
/** Wheel flag: the low two bits then select the wheel direction. */
const MOUSE_WHEEL = 64;

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;
const WHEEL_KEYS = ["wheelup", "wheeldown", "wheelleft", "wheelright"] as const;

/**
 * Parse an SGR mouse report (`\x1b[<button;x;yM` press/motion, `…m` release).
 * Wheel reports keep their `wheelup`/`wheeldown` keys so the existing scroll
 * handlers keep working, and every report carries coordinates for the
 * renderer's pointer router.
 */
function parseMouse(seq: string): KeyEvent {
	const final = seq[seq.length - 1];
	const [codePart = "", xPart = "", yPart = ""] = seq.slice(3, -1).split(";");
	const code = Number.parseInt(codePart, 10);
	// SGR coordinates are 1-based; the render grid is 0-based.
	const x = Math.max(0, (Number.parseInt(xPart, 10) || 1) - 1);
	const y = Math.max(0, (Number.parseInt(yPart, 10) || 1) - 1);
	const shift = (code & MOUSE_SHIFT) !== 0;
	const meta = (code & MOUSE_META) !== 0;
	const ctrl = (code & MOUSE_CTRL) !== 0;
	const action = final === "m" ? "release" : (code & MOUSE_MOTION) !== 0 ? "move" : "press";
	const buttonIndex = code & 0b11;
	const wheelKey = WHEEL_KEYS[buttonIndex] ?? "wheelup";

	if ((code & MOUSE_WHEEL) !== 0) {
		return {
			key: wheelKey,
			ctrl,
			meta,
			shift,
			mouse: { x, y, button: null, action: "press", ctrl, meta, shift },
		};
	}

	return {
		key: "mouse",
		ctrl,
		meta,
		shift,
		mouse: { x, y, button: MOUSE_BUTTONS[buttonIndex] ?? null, action, ctrl, meta, shift },
	};
}

class InputManager {
	private globalHandlers: Set<KeyHandler> = new Set();
	private handlers: Set<KeyHandler> = new Set();
	private isRawMode = false;
	/** Incomplete escape sequence carried across stdin chunks. */
	private pending = "";

	start() {
		if (this.isRawMode) return;
		this.pending = "";

		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", this.handleData);
		this.isRawMode = true;
	}

	stop() {
		if (!this.isRawMode) return;

		process.stdin.off("data", this.handleData);
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		this.isRawMode = false;
	}

	private handleData = (data: string) => {
		const sequences = this.splitSequences(data);
		// One render commit per stdin chunk: a single key handler often writes
		// several signals (text + cursor) and a paste arrives as a burst of
		// key events, so batch the whole dispatch instead of committing per
		// signal write.
		batch(() => {
			for (const seq of sequences) {
				this.dispatch(this.parseKey(seq));
			}
		});
	};

	/**
	 * Global handlers first (an open palette/overlay is modal), then the
	 * renderer's click targets, then the focus-registered key handlers.
	 */
	private dispatch(event: KeyEvent) {
		for (const handler of this.globalHandlers) {
			if (handler(event) === true) return;
		}
		if (event.mouse && dispatchPointer(event)) return;
		for (const handler of this.handlers) {
			if (handler(event) === true) return;
		}
	}

	splitSequences(data: string): string[] {
		const input = this.pending + data;
		this.pending = "";
		const sequences: string[] = [];
		let i = 0;
		while (i < input.length) {
			if (input[i] !== "\x1b") {
				sequences.push(input[i] ?? "");
				i++;
				continue;
			}

			const kind = input[i + 1];

			if (kind === "[") {
				let end = i + 2;
				while (end < input.length && !isFinalByte(input.charCodeAt(end))) {
					end++;
				}
				if (end >= input.length) {
					this.pending = input.slice(i);
					break;
				}
				const sequence = input.slice(i, end + 1);
				// Device reports (DA1/DA2, and any other private CSI reply) are
				// terminal chatter, not user input.
				if (!sequence.startsWith("\x1b[?") && !sequence.startsWith("\x1b[>")) {
					sequences.push(sequence);
				}
				i = end + 1;
				continue;
			}

			if (kind === "]") {
				let end = -1;
				for (let cursor = i + 2; cursor < input.length; cursor++) {
					if (input[cursor] === "\x07") {
						end = cursor + 1;
						break;
					}
					if (input[cursor] === "\x1b" && input[cursor + 1] === "\\") {
						end = cursor + 2;
						break;
					}
				}
				if (end < 0) {
					// Only hold the chunk when the partial body could still be a
					// color reply; otherwise this is Alt+] or another key chord.
					if (isReplyPrefix(input.slice(i + 2))) {
						this.pending = input.slice(i);
						break;
					}
					sequences.push(input[i] ?? "");
					i++;
					continue;
				}
				const terminatedByBel = input[end - 1] === "\x07";
				const body = input.slice(i + 2, terminatedByBel ? end - 1 : end - 2);
				if (isTerminalReply(body)) {
					// A late reply to the startup palette query: discard it.
					i = end;
					continue;
				}
				sequences.push(input[i] ?? "");
				i++;
				continue;
			}

			sequences.push(input[i] ?? "");
			i++;
		}
		return sequences;
	}

	parseKey(seq: string): KeyEvent {
		if (seq.startsWith("\x1b[<")) {
			return parseMouse(seq);
		}
		if (seq.startsWith(CSI)) {
			const body = seq.slice(2);
			switch (body) {
				case "A":
					return { key: "up", ctrl: false, meta: false, shift: false };
				case "B":
					return { key: "down", ctrl: false, meta: false, shift: false };
				case "C":
					return { key: "right", ctrl: false, meta: false, shift: false };
				case "D":
					return { key: "left", ctrl: false, meta: false, shift: false };
				case "H":
				case "1~":
					return { key: "home", ctrl: false, meta: false, shift: false };
				case "F":
				case "4~":
					return { key: "end", ctrl: false, meta: false, shift: false };
				case "3~":
					return { key: "delete", ctrl: false, meta: false, shift: false };
				case "5~":
					return { key: "pageup", ctrl: false, meta: false, shift: false };
				case "6~":
					return { key: "pagedown", ctrl: false, meta: false, shift: false };
			}
		}

		const code = seq.charCodeAt(0);

		if (code === 3) {
			return { key: "c", ctrl: true, meta: false, shift: false };
		}
		if (code === 13) {
			return { key: "enter", ctrl: false, meta: false, shift: false };
		}
		if (code === 127 || code === 8) {
			return { key: "backspace", ctrl: false, meta: false, shift: false };
		}
		if (code === 27) {
			return { key: "escape", ctrl: false, meta: false, shift: false };
		}
		if (code === 9) {
			return { key: "tab", ctrl: false, meta: false, shift: false };
		}
		if (code >= 1 && code <= 26) {
			return {
				key: String.fromCharCode(code + 96),
				ctrl: true,
				meta: false,
				shift: false,
			};
		}

		return { key: seq, ctrl: false, meta: false, shift: false };
	}

	onKeyGlobal(handler: KeyHandler): () => void {
		this.globalHandlers.add(handler);
		return () => this.globalHandlers.delete(handler);
	}

	onKey(handler: KeyHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}
}

export const inputManager = new InputManager();

export function useInput(handler: KeyHandler) {
	return inputManager.onKey(handler);
}
