import { effect, type Signal, signal } from "@preact/signals-core";

/** Effect body: may return a cleanup that runs before each re-run and at unmount. */
export type EffectFn = () => undefined | (() => void);

export interface HookStore {
	signals: Map<number, Signal<unknown>>;
	effects: Map<number, () => void>;
	/** Latest effect callback per slot; effects call through so re-runs see fresh closures. */
	effectFns: Map<number, EffectFn>;
	hookIndex: number;
}

export function createHookStore(): HookStore {
	return { signals: new Map(), effects: new Map(), effectFns: new Map(), hookIndex: 0 };
}

export function disposeHookStore(store: HookStore) {
	for (const cleanup of store.effects.values()) {
		cleanup();
	}
	store.effects.clear();
	store.effectFns.clear();
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

/**
 * A signal that always holds the latest-render value. Read it inside
 * once-registered handlers and effects to reach current options instead of
 * capturing the first render's closure.
 *
 * Writes are unconditional, so primitives are effectively written once
 * (unchanged values are `Object.is` no-ops and do not notify), while a fresh
 * object identity bumps the signal on every render — an effect that reads an
 * object-valued ref re-runs per render.
 */
export function useLatest<T>(value: T): Signal<T> {
	const ref = useSignal(value);
	ref.value = value;
	return ref;
}

/**
 * Run `fn` as a reactive effect owned by the current component.
 *
 * The body runs immediately at mount — synchronously inside the render
 * commit's flush, closer to a mid-commit layout effect than a post-commit
 * one — and re-runs when signals read inside it change. Each render stores
 * its callback and re-runs invoke the latest one, so an effect never observes
 * a stale first-render closure.
 *
 * Effects re-run only on tracked signal reads: props are not reactive, so a
 * value an effect must react to has to be read through `useLatest` or a
 * signal. The optional return value is a cleanup that runs before each re-run
 * and once at unmount (`disposeHookStore`).
 */
export function useSignalEffect(fn: EffectFn): void {
	const store = getCurrentStore();
	const idx = store.hookIndex++;
	store.effectFns.set(idx, fn);
	if (!store.effects.has(idx)) {
		const cleanup = effect(() => {
			const live = store.effectFns.get(idx);
			const result = live?.();
			if (typeof result === "function") {
				return result;
			}
		});
		store.effects.set(idx, cleanup);
	}
}
