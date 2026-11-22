import type { Signal } from "@preact/signals-core";
import { inputManager, type KeyEvent } from "../../core/input.ts";
import { getHookKey, hasCleanup, setCleanup, useLatest, useSignal } from "./signals.ts";

export interface CommandPaletteItem {
	id: string;
	title: string;
	description?: string;
	keywords?: string[];
}

export type VimMode = "NORMAL" | "INSERT";

export interface UseCommandPaletteOptions {
	items: CommandPaletteItem[];
	/** Key to open the palette. Set to `null` to disable keyboard-triggered open (use openPalette() instead). */
	openKey?: string | null;
	maxResults?: number;
	onSelect?: (item: CommandPaletteItem) => void;
	/** Called when the palette is dismissed via Escape */
	onDismiss?: () => void;
	/** If provided, the palette will only open when the text input is in NORMAL mode */
	mode?: Signal<VimMode>;
}

function filterItems(items: CommandPaletteItem[], query: string, maxResults: number): CommandPaletteItem[] {
	if (!query) return items.slice(0, maxResults);
	const lower = query.toLowerCase();
	return items
		.filter((item) => {
			if (item.title.toLowerCase().includes(lower)) return true;
			if (item.description?.toLowerCase().includes(lower)) return true;
			if (item.keywords?.some((k) => k.toLowerCase().includes(lower))) return true;
			return false;
		})
		.slice(0, maxResults);
}

export function useCommandPalette(options: UseCommandPaletteOptions) {
	const open = useSignal(false);
	const query = useSignal("");
	const cursor = useSignal(0);
	const selectedIndex = useSignal(0);
	const optionsRef = useLatest(options);

	const maxResults = options.maxResults ?? 10;
	const matches = filterItems(options.items, query.value, maxResults);

	const key = getHookKey();

	if (!hasCleanup(key)) {
		const cleanup = inputManager.onKeyGlobal((event: KeyEvent) => {
			const opts = optionsRef.value;
			const openKey = opts.openKey === undefined ? "/" : opts.openKey;
			const max = opts.maxResults ?? 10;

			if (!open.value) {
				if (openKey !== null && event.key === openKey && !event.ctrl && !event.meta) {
					// Only open palette if mode is not provided (no vim mode) or if in NORMAL mode
					if (opts.mode && opts.mode.value !== "NORMAL") {
						return false;
					}
					open.value = true;
					query.value = "";
					cursor.value = 0;
					selectedIndex.value = 0;
					return true;
				}
				return false;
			}

			if (event.key === "escape") {
				open.value = false;
				query.value = "";
				cursor.value = 0;
				selectedIndex.value = 0;
				opts.onDismiss?.();
				return true;
			}

			const currentMatches = filterItems(opts.items, query.value, max);

			if (event.key === "up") {
				selectedIndex.value = Math.max(0, selectedIndex.value - 1);
				return true;
			}

			if (event.key === "down") {
				selectedIndex.value = Math.min(currentMatches.length - 1, selectedIndex.value + 1);
				return true;
			}

			if (event.key === "enter") {
				const selected = currentMatches[selectedIndex.value];
				if (selected) {
					open.value = false;
					query.value = "";
					cursor.value = 0;
					selectedIndex.value = 0;
					opts.onSelect?.(selected);
				}
				return true;
			}

			if (event.key === "backspace") {
				if (cursor.value > 0) {
					query.value = query.value.slice(0, cursor.value - 1) + query.value.slice(cursor.value);
					cursor.value = cursor.value - 1;
					selectedIndex.value = 0;
				}
				return true;
			}

			if (event.key === "left") {
				cursor.value = Math.max(0, cursor.value - 1);
				return true;
			}

			if (event.key === "right") {
				cursor.value = Math.min(query.value.length, cursor.value + 1);
				return true;
			}

			if (event.ctrl && event.key === "w") {
				const before = query.value.slice(0, cursor.value);
				const match = before.match(/\s*\S*$/);
				const deleteCount = match ? match[0].length : 0;
				if (deleteCount > 0) {
					query.value = query.value.slice(0, cursor.value - deleteCount) + query.value.slice(cursor.value);
					cursor.value = cursor.value - deleteCount;
					selectedIndex.value = 0;
				}
				return true;
			}

			if (event.ctrl && event.key === "u") {
				query.value = query.value.slice(cursor.value);
				cursor.value = 0;
				selectedIndex.value = 0;
				return true;
			}

			if (event.key.length === 1 && !event.ctrl && !event.meta) {
				query.value = query.value.slice(0, cursor.value) + event.key + query.value.slice(cursor.value);
				cursor.value = cursor.value + 1;
				selectedIndex.value = 0;
				return true;
			}

			return true;
		});

		setCleanup(key, cleanup);
	}

	const openPalette = () => {
		open.value = true;
		query.value = "";
		cursor.value = 0;
		selectedIndex.value = 0;
	};

	const closePalette = () => {
		open.value = false;
		query.value = "";
		cursor.value = 0;
		selectedIndex.value = 0;
	};

	return {
		open,
		query,
		cursor,
		selectedIndex,
		matches,
		openPalette,
		closePalette,
	};
}
