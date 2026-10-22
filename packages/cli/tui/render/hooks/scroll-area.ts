import type { Signal } from "@preact/signals-core";
import { useInput } from "#/tui/core/input.ts";
import type { ScrollMetrics } from "../types/index.ts";
import { useSignal, useSignalEffect } from "./signals.ts";

export interface ScrollAreaState {
	scrollOffset: Signal<number>;
	onMetrics: (metrics: ScrollMetrics) => void;
	onScrollOffsetChange: (offset: number) => void;
}

export function useScrollArea(options?: {
	focused?: boolean | undefined;
	scrollStep?: number | undefined;
	autoScroll?: boolean | undefined;
}): ScrollAreaState {
	const scrollOffset = useSignal(0);
	const viewportHeight = useSignal(0);
	const maxScroll = useSignal(0);

	// The input handler is registered once, so route it through a signal that
	// always holds the latest options: focus can move to a modal while this
	// ScrollArea stays mounted (e.g. the diff review overlay).
	const optionsRef = useSignal(options);
	optionsRef.value = options;

	useSignalEffect(() => {
		return useInput((event) => {
			const current = optionsRef.value;
			if (current?.focused === false) return false;
			const step = current?.scrollStep ?? 1;

			if (event.key === "up") {
				scrollOffset.value = Math.max(0, scrollOffset.value - step);
				return true;
			}
			if (event.key === "down") {
				scrollOffset.value = Math.min(maxScroll.value, scrollOffset.value + step);
				return true;
			}
			if (event.key === "wheelup") {
				scrollOffset.value = Math.max(0, scrollOffset.value - step * 3);
				return true;
			}
			if (event.key === "wheeldown") {
				scrollOffset.value = Math.min(maxScroll.value, scrollOffset.value + step * 3);
				return true;
			}
			if (event.key === "pageup") {
				scrollOffset.value = Math.max(0, scrollOffset.value - Math.max(1, viewportHeight.value));
				return true;
			}
			if (event.key === "pagedown") {
				scrollOffset.value = Math.min(maxScroll.value, scrollOffset.value + Math.max(1, viewportHeight.value));
				return true;
			}
			return false;
		});
	});

	return {
		scrollOffset,
		onMetrics: (metrics: ScrollMetrics) => {
			const wasAtBottom = scrollOffset.value >= maxScroll.value;
			viewportHeight.value = metrics.viewportHeight;
			maxScroll.value = metrics.maxScroll;
			if (optionsRef.value?.autoScroll && wasAtBottom) {
				scrollOffset.value = metrics.maxScroll;
			}
		},
		onScrollOffsetChange: (offset: number) => {
			scrollOffset.value = offset;
		},
	};
}
