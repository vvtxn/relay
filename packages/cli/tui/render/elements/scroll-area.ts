import Y from "yoga-layout";
import { applyAnsi, applyInheritedBackground, toBgAnsi } from "#/tui/core/primitives/color.ts";
import { fillPositions } from "#/tui/core/primitives/fill.ts";
import { theme } from "#/tui/theme.ts";
import type { ElementHandler, Position, ScrollAreaInstance } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";
import { applyBoxPadding } from "./padding.ts";

const FLEX_DIRECTION_MAP = {
	row: Y.FLEX_DIRECTION_ROW,
	column: Y.FLEX_DIRECTION_COLUMN,
	"row-reverse": Y.FLEX_DIRECTION_ROW_REVERSE,
	"column-reverse": Y.FLEX_DIRECTION_COLUMN_REVERSE,
} as const;

const JUSTIFY_CONTENT_MAP = {
	"flex-start": Y.JUSTIFY_FLEX_START,
	center: Y.JUSTIFY_CENTER,
	"flex-end": Y.JUSTIFY_FLEX_END,
	"space-between": Y.JUSTIFY_SPACE_BETWEEN,
	"space-around": Y.JUSTIFY_SPACE_AROUND,
	"space-evenly": Y.JUSTIFY_SPACE_EVENLY,
} as const;

const ALIGN_ITEMS_MAP = {
	"flex-start": Y.ALIGN_FLEX_START,
	center: Y.ALIGN_CENTER,
	"flex-end": Y.ALIGN_FLEX_END,
	stretch: Y.ALIGN_STRETCH,
	baseline: Y.ALIGN_BASELINE,
} as const;

export const ScrollAreaLayout: LayoutHandler<ScrollAreaInstance> = (instance) => {
	const { yogaNode, props } = instance;
	yogaNode.setFlex(props.flex ? Number(props.flex) : undefined);
	yogaNode.setFlexDirection(props.flexDirection ? FLEX_DIRECTION_MAP[props.flexDirection] : Y.FLEX_DIRECTION_COLUMN);
	yogaNode.setJustifyContent(props.justifyContent ? JUSTIFY_CONTENT_MAP[props.justifyContent] : Y.JUSTIFY_FLEX_START);
	yogaNode.setAlignItems(props.alignItems ? ALIGN_ITEMS_MAP[props.alignItems] : Y.ALIGN_STRETCH);
	yogaNode.setGap(Y.GUTTER_ROW, undefined);
	yogaNode.setGap(Y.GUTTER_COLUMN, undefined);
	if (props.gap) {
		const isRow = props.flexDirection === "row" || props.flexDirection === "row-reverse";
		yogaNode.setGap(isRow ? Y.GUTTER_COLUMN : Y.GUTTER_ROW, props.gap);
	}
	applyBoxPadding(yogaNode, props);
	if (props.width !== undefined) yogaNode.setWidth(props.width);
	else yogaNode.setWidthAuto();
	if (props.height !== undefined) yogaNode.setHeight(props.height);
	else yogaNode.setHeightAuto();
	yogaNode.setOverflow(Y.OVERFLOW_SCROLL);
	if (props.scrollbar) {
		// The scrollbar owns a gutter just inside the box's right edge.
		yogaNode.setPadding(Y.EDGE_RIGHT, (props.paddingRight ?? props.paddingX ?? props.padding ?? 0) + 1);
	}
};

/** Natural height of a scroll area's content (unclipped, before the scroll offset). */
export function scrollContentHeight(instance: ScrollAreaInstance): number {
	let contentHeight = 0;
	for (const child of instance.children) {
		const childBottom =
			Math.round(child.yogaNode.getComputedTop()) + Math.round(child.yogaNode.getComputedHeight());
		if (childBottom > contentHeight) contentHeight = childBottom;
	}
	return contentHeight;
}

/** Painted scrollbar geometry, in absolute terminal cells. */
export interface ScrollbarMetrics {
	/** Absolute column of the bar. */
	x: number;
	/** Absolute row of the track's first cell. */
	top: number;
	trackHeight: number;
	/** Absolute row of the thumb's first cell. */
	thumbTop: number;
	thumbHeight: number;
	maxScroll: number;
	/** Clamped scroll offset the geometry was computed from. */
	offset: number;
}

/**
 * Resolve the scrollbar's screen geometry from a box rect and content metrics.
 * Shared by the painter and the renderer's pointer hit test so clicks map to
 * exactly the cells that were drawn. Returns null when there is nothing to
 * scroll or the viewport has no rows.
 */
export function scrollbarMetrics(args: {
	x: number;
	y: number;
	width: number;
	height: number;
	contentHeight: number;
	scrollOffset: number;
}): ScrollbarMetrics | null {
	const trackHeight = args.height;
	const maxScroll = Math.max(0, args.contentHeight - trackHeight);
	if (maxScroll <= 0 || trackHeight <= 0) return null;

	const offset = Math.max(0, Math.min(args.scrollOffset, maxScroll));
	const thumbHeight = Math.max(1, Math.floor((trackHeight / args.contentHeight) * trackHeight));
	const thumbTravel = Math.max(0, trackHeight - thumbHeight);
	const thumbTop = args.y + (thumbTravel > 0 ? Math.floor((offset / maxScroll) * thumbTravel) : 0);

	return { x: args.x + args.width - 1, top: args.y, trackHeight, thumbTop, thumbHeight, maxScroll, offset };
}

export const ScrollAreaElement: ElementHandler<ScrollAreaInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());
	const w = Math.round(instance.yogaNode.getComputedWidth());
	const h = Math.round(instance.yogaNode.getComputedHeight());

	const bg = instance.props.bgColor && instance.props.bgColor !== "default" ? toBgAnsi(instance.props.bgColor) : null;

	const backgroundPositions: Position[] = [];
	if (bg) {
		backgroundPositions.push(...fillPositions(x, y, w, h, bg));
	}

	const clipBottom = y + h - 1;
	const contentHeight = scrollContentHeight(instance);
	const maxScroll = Math.max(0, contentHeight - h);
	const scrollOffset = Math.max(0, Math.min(instance.props.scrollOffset ?? 0, maxScroll));

	instance.props.onMetrics?.({ viewportHeight: h, contentHeight, maxScroll });
	if (scrollOffset !== (instance.props.scrollOffset ?? 0)) {
		instance.props.onScrollOffsetChange?.(scrollOffset);
	}

	const clipped: Position[] = [];
	for (const child of instance.children) {
		const childTop = Math.round(child.yogaNode.getComputedTop()) - scrollOffset;
		const childHeight = Math.round(child.yogaNode.getComputedHeight());
		const childBottom = childTop + childHeight - 1;

		if (childBottom < 0 || childTop >= h) continue;

		const childPositions = context.renderInstance(child, x, y - scrollOffset, bg ?? context.inheritedBg);
		for (const pos of childPositions) {
			if (pos.y >= y && pos.y <= clipBottom) {
				clipped.push(pos);
			}
		}
	}

	const scrollbarPositions: Position[] = [];
	const bar = instance.props.scrollbar
		? scrollbarMetrics({
				x,
				y,
				width: w,
				height: h,
				contentHeight,
				scrollOffset,
			})
		: null;
	if (bar) {
		for (let row = bar.top; row < bar.top + bar.trackHeight; row++) {
			const isThumb = row >= bar.thumbTop && row < bar.thumbTop + bar.thumbHeight;
			scrollbarPositions.push({
				x: bar.x,
				y: row,
				text: isThumb ? applyAnsi("█", { fg: theme.textDim }) : applyAnsi("░", { fg: theme.border }),
			});
		}
	}

	if (bg) {
		for (const pos of clipped) pos.text = applyInheritedBackground(pos.text, bg);
		for (const pos of scrollbarPositions) pos.text = applyInheritedBackground(pos.text, bg);
	}

	return [...backgroundPositions, ...clipped, ...scrollbarPositions];
};
