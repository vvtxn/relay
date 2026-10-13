import { createSignal } from "solid-js";

/** One edit/write diff shown in the review modal. Captured by value. */
export interface DiffPreview {
	name: string;
	path: string;
	diff: string;
}

// Module-level so an open modal survives re-renders of the message list while a
// turn streams; the tool call row that opened it may be recreated meanwhile.
const [current, setCurrent] = createSignal<DiffPreview | null>(null);
export { current as diffPreview };

export function openDiffPreview(next: DiffPreview): void {
	setCurrent(next);
}

export function closeDiffPreview(): void {
	setCurrent(null);
}
