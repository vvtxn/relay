import process from "node:process";
import { signal } from "@preact/signals-core";
import { CSI } from "@/tui/core/ansi.ts";

export interface KeyEvent {
	key: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
}

export type KeyHandler = (event: KeyEvent) => boolean | void;

function isDigit(char: string | undefined): boolean {
	return char !== undefined && char >= "0" && char <= "9";
}

class InputManager {
	private globalHandlers: Set<KeyHandler> = new Set();
	private handlers: Set<KeyHandler> = new Set();
	private isRawMode = false;

	start() {
		if (this.isRawMode) return;

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
		for (const seq of sequences) {
			const event = this.parseKey(seq);
			let consumed = false;
			for (const handler of this.globalHandlers) {
				if (handler(event) === true) {
					consumed = true;
					break;
				}
			}
			if (consumed) continue;
			for (const handler of this.handlers) {
				if (handler(event) === true) break;
			}
		}
	};

	splitSequences(data: string): string[] {
		const sequences: string[] = [];
		let i = 0;
		while (i < data.length) {
			if (data[i] === "\x1b" && data[i + 1] === "[") {
				let end = i + 2;
				while (end < data.length && isDigit(data[end])) {
					end++;
				}
				if (data[end] === ";") {
					end++;
					while (end < data.length && isDigit(data[end])) {
						end++;
					}
				}
				if (end < data.length) {
					end++;
				}
				sequences.push(data.slice(i, end));
				i = end;
			} else {
				sequences.push(data[i] ?? "");
				i++;
			}
		}
		return sequences;
	}

	parseKey(seq: string): KeyEvent {
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

export const cursorPosition = signal<{ x: number; y: number } | null>(null);
