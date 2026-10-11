import type { Signal } from "@preact/signals-core";

import { inputManager, type KeyEvent } from "../../core/input.ts";
import { getHookKey, hasCleanup, setCleanup, useSignal } from "./signals.ts";
import {
	deleteBackward,
	deleteForward,
	deleteToEnd,
	deleteToStart,
	deleteWordBackward,
	insertChar,
	moveCursor,
	setCursor,
	type TextState,
	toggleCaseAt,
} from "./text-utils.ts";

export type VimMode = "NORMAL" | "INSERT";

interface UseTextInputOptions {
	value: Signal<string>;
	cursorPosition: Signal<number>;
	focused?: boolean;
	onChange?: (value: string) => void;
	onSubmit?: (value: string) => void;
	/** Called after a printable character is inserted */
	onCharInserted?: (char: string, cursorPosition: number) => void;
	/** If provided, enables vim mode with NORMAL/INSERT states */
	mode?: Signal<VimMode>;
	onModeChange?: (mode: VimMode) => void;
}

function handleInsertMode(event: KeyEvent, state: TextState, options: UseTextInputOptions): boolean {
	if (options.mode && event.key === "escape") {
		options.mode.value = "NORMAL";
		options.onModeChange?.("NORMAL");
		moveCursor(state, -1);
		return true;
	}

	if (event.key === "enter") {
		options.onSubmit?.(state.value.value);
		return true;
	}

	if (event.key === "backspace") {
		const newValue = deleteBackward(state);
		if (newValue !== null) options.onChange?.(newValue);
		return true;
	}

	if (event.key === "delete" || (event.ctrl && event.key === "d")) {
		const newValue = deleteForward(state);
		if (newValue !== null) options.onChange?.(newValue);
		return true;
	}

	if (event.key === "tab") {
		const newValue = insertChar(state, "\t");
		options.onChange?.(newValue);
		return true;
	}

	if (event.key === "left") {
		moveCursor(state, -1);
		return true;
	}

	if (event.key === "right") {
		moveCursor(state, 1);
		return true;
	}

	if (event.key === "home" || (event.ctrl && event.key === "a")) {
		setCursor(state, 0);
		return true;
	}

	if (event.key === "end" || (event.ctrl && event.key === "e")) {
		setCursor(state, state.value.value.length);
		return true;
	}

	if (event.ctrl && event.key === "w") {
		const newValue = deleteWordBackward(state);
		if (newValue !== null) options.onChange?.(newValue);
		return true;
	}

	if (event.ctrl && event.key === "u") {
		const newValue = deleteToStart(state);
		if (newValue !== null) options.onChange?.(newValue);
		return true;
	}

	if (event.ctrl && event.key === "k") {
		const newValue = deleteToEnd(state);
		if (newValue !== null) options.onChange?.(newValue);
		return true;
	}

	if (event.key.length === 1 && !event.ctrl && !event.meta) {
		const newValue = insertChar(state, event.key);
		options.onChange?.(newValue);
		options.onCharInserted?.(event.key, state.cursorPosition.value);
		return true;
	}

	return false;
}

function handleNormalMode(event: KeyEvent, state: TextState, options: UseTextInputOptions): boolean {
	const mode = options.mode!;
	const value = state.value.value;
	const cursor = state.cursorPosition.value;

	const enterInsert = (cursorDelta = 0) => {
		mode.value = "INSERT";
		options.onModeChange?.("INSERT");
		if (cursorDelta) {
			moveCursor(state, cursorDelta);
		}
	};

	switch (event.key) {
		case "i":
			enterInsert();
			return true;
		case "a":
			enterInsert(cursor < value.length ? 1 : 0);
			return true;
		case "A":
			mode.value = "INSERT";
			options.onModeChange?.("INSERT");
			setCursor(state, value.length);
			return true;
		case "I":
			mode.value = "INSERT";
			options.onModeChange?.("INSERT");
			setCursor(state, 0);
			return true;
		case "h":
			moveCursor(state, -1);
			return true;
		case "l":
			if (cursor < value.length - 1) moveCursor(state, 1);
			return true;
		case "0":
			setCursor(state, 0);
			return true;
		case "$":
			setCursor(state, Math.max(0, value.length - 1));
			return true;
		case "w": {
			const rest = value.slice(cursor);
			const match = rest.match(/^\s*\S*\s*/);
			if (match?.[0]) {
				setCursor(state, Math.min(cursor + match[0].length, value.length - 1));
			}
			return true;
		}
		case "b": {
			const before = value.slice(0, cursor);
			const match = before.match(/\S+\s*$/);
			setCursor(state, match ? cursor - match[0].length : 0);
			return true;
		}
		case "x": {
			const newValue = deleteForward(state);
			if (newValue !== null) {
				options.onChange?.(newValue);
				if (cursor >= newValue.length && cursor > 0) {
					moveCursor(state, -1);
				}
			}
			return true;
		}
		case "e": {
			const rest = value.slice(cursor);
			const match = rest.match(/^.?\s*\S*/);
			if (match?.[0] && match[0].length > 1) {
				setCursor(state, Math.min(cursor + match[0].length - 1, value.length - 1));
			}
			return true;
		}
		case "~": {
			const newValue = toggleCaseAt(state);
			if (newValue !== null) options.onChange?.(newValue);
			return true;
		}
		case "D": {
			const newValue = deleteToEnd(state);
			if (newValue !== null) {
				options.onChange?.(newValue);
				if (cursor > 0) moveCursor(state, -1);
			}
			return true;
		}
		case "C": {
			const newValue = deleteToEnd(state);
			if (newValue !== null) options.onChange?.(newValue);
			mode.value = "INSERT";
			options.onModeChange?.("INSERT");
			return true;
		}
		default:
			return false;
	}
}

export function useTextInput(options: UseTextInputOptions) {
	// The key handler is registered once; route it through a ref signal so it
	// always sees the latest callbacks instead of the first render's closure.
	const optionsRef = useSignal(options);
	optionsRef.value = options;

	const key = getHookKey();

	if (!hasCleanup(key) && options.focused !== false) {
		const cleanup = inputManager.onKey((event: KeyEvent) => {
			const current = optionsRef.value;
			if (current.focused === false) return false;

			const state: TextState = { value: current.value, cursorPosition: current.cursorPosition };
			if (current.mode?.value === "NORMAL") {
				return handleNormalMode(event, state, current);
			}
			return handleInsertMode(event, state, current);
		});

		setCleanup(key, cleanup);
	}

	return {
		value: options.value,
		cursorPosition: options.cursorPosition,
		mode: options.mode,
	};
}
