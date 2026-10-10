import type { VNode } from "./jsx-runtime.ts";

/**
 * Mark a component as pure so the renderer can skip re-invocation while its
 * props are shallow-equal to the last render, reusing the previous output.
 *
 * Memoized components must be pure functions of their props: no signals, no
 * hooks, no external mutable state, and they must return an element (or null),
 * not a fragment — the renderer stores the memo state on the output instance.
 * Signal-driven components (Spinner, TextInput, ScrollArea, …) must NOT be
 * memoized: a signal read inside them is tracked by the root render effect,
 * and skipping the invocation would drop the update.
 *
 * Props are compared shallowly, so passing fresh object literals (e.g. a new
 * `msg` per fetch) intentionally re-invokes the component.
 */
export function memo<P extends Record<string, unknown>>(
	component: (props: P) => VNode | null,
): (props: P) => VNode | null {
	const wrapped = ((props: P) => component(props)) as typeof component & { memo?: true };
	wrapped.memo = true;
	return wrapped;
}

/** True when the component was wrapped with `memo()`. */
export function isMemoized(component: unknown): boolean {
	return typeof component === "function" && (component as { memo?: true }).memo === true;
}
