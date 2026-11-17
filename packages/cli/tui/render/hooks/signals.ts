import { effect, type Signal, signal } from "@preact/signals-core";

export interface HookStore {
	signals: Map<number, Signal<unknown>>;
	effects: Map<number, () => void>;
	hookIndex: number;
}

export function createHookStore(): HookStore {
	return { signals: new Map(), effects: new Map(), hookIndex: 0 };
}

export function disposeHookStore(store: HookStore) {
	for (const cleanup of store.effects.values()) {
		cleanup();
	}
	store.effects.clear();
	store.signals.clear();
}

let currentStore: HookStore | null = null;

export function setCurrentStore(store: HookStore) {
	currentStore = store;
	store.hookIndex = 0;
}

export function clearCurrentStore() {
	currentStore = null;
}

function getCurrentStore(): HookStore {
	if (!currentStore) {
		throw new Error("Hook called outside of a component render");
	}
	return currentStore;
}

/**
 * Reserve the next hook slot in the current component and return its index.
 * Slots are positional, so callers must invoke hooks in a stable order.
 */
export function getHookKey(): number {
	const store = getCurrentStore();
	return store.hookIndex++;
}

export function hasCleanup(key: number): boolean {
	const store = getCurrentStore();
	return store.effects.has(key);
}

export function setCleanup(key: number, cleanup: () => void) {
	const store = getCurrentStore();
	store.effects.set(key, cleanup);
}

export function useSignal<T>(initialValue: T): Signal<T> {
	const store = getCurrentStore();
	const idx = store.hookIndex++;
	if (!store.signals.has(idx)) {
		store.signals.set(idx, signal(initialValue));
	}
	return store.signals.get(idx) as Signal<T>;
}

export function useSignalEffect(fn: () => undefined | (() => void)): void {
	const store = getCurrentStore();
	const idx = store.hookIndex++;
	if (!store.effects.has(idx)) {
		const cleanup = effect(() => {
			const result = fn();
			if (typeof result === "function") {
				return result;
			}
		});
		store.effects.set(idx, cleanup);
	}
}
