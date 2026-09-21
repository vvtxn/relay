import type { Signal } from "@preact/signals-core";
import { useInput } from "@/tui/core/input.ts";
import type { ScrollMetrics } from "../types/index.ts";
import { useSignal, useSignalEffect } from "./signals.ts";

export interface ScrollAreaState {
	scrollOffset: Signal<number>;
	onMetrics: (metrics: ScrollMetrics) => void;
	onScrollOffsetChange: (offset: number) => void;
}

export function useScrollArea(
	options?: { focused?: boolean | undefined; scrollStep?: number | undefined; autoScroll?: boolean | undefined },
): ScrollAreaState {
	const scrollOffset = useSignal(0);
	const viewportHeight = useSignal(0);
	const maxScroll = useSignal(0);

	useSignalEffect(() => {
		return useInput((event) => {
			if (options?.focused === false) return false;
			const step = options?.scrollStep ?? 1;

			if (event.key === "up") {
				scrollOffset.value = Math.max(0, scrollOffset.value - step);
				return true;
			}
			if (event.key === "down") {
				scrollOffset.value = Math.min(maxScroll.value, scrollOffset.value + step);
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
			if (options?.autoScroll && wasAtBottom) {
				scrollOffset.value = metrics.maxScroll;
			}
		},
		onScrollOffsetChange: (offset: number) => {
			scrollOffset.value = offset;
		},
	};
}
