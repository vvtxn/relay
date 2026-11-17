import type { KeyEvent } from "./input.ts";

/**
 * Routes pointer reports to the mounted render tree. The renderer installs the
 * implementation (its hit test); `input.ts` owns the dispatch order.
 */
export type PointerHandler = (event: KeyEvent) => boolean;

let activeHandler: PointerHandler | null = null;

/** Install (or clear) the renderer's pointer router. */
export function setPointerHandler(handler: PointerHandler | null): void {
	activeHandler = handler;
}

/**
 * Send a pointer report to the active router. Returns `true` when a click
 * target consumed it; `false` lets wheel reports fall through to key handlers.
 */
export function dispatchPointer(event: KeyEvent): boolean {
	return activeHandler?.(event) === true;
}
