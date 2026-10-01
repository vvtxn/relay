import Y from "yoga-layout";
import { drawBox } from "@/tui/core/primitives/draw-box.ts";
import { applyAnsi } from "@/tui/core/primitives/color.ts";
import { theme } from "@/tui/theme.ts";
import type { ElementHandler, Position, ScrollAreaInstance } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";

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
	const basePadding = props.padding ?? 0;
	yogaNode.setPadding(Y.EDGE_ALL, basePadding || undefined);
	if (props.width !== undefined) yogaNode.setWidth(props.width);
	else yogaNode.setWidthAuto();
	if (props.height !== undefined) yogaNode.setHeight(props.height);
	else yogaNode.setHeightAuto();
	yogaNode.setBorder(Y.EDGE_ALL, props.border ? 1 : undefined);
	yogaNode.setOverflow(Y.OVERFLOW_SCROLL);
	if (props.scrollbar) {
		yogaNode.setPadding(Y.EDGE_RIGHT, basePadding + 1);
	}
};

export const ScrollAreaElement: ElementHandler<ScrollAreaInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());
	const w = Math.round(instance.yogaNode.getComputedWidth());
	const h = Math.round(instance.yogaNode.getComputedHeight());

	const borderPositions: Position[] = [];
	if (instance.props.border) {
		borderPositions.push(
			...drawBox(
				x,
				y,
				w,
				h,
				instance.props.border,
				instance.props.borderColor,
				instance.props.borderLabel,
				instance.props.borderLabelColor,
				instance.props.bgColor,
			),
		);
	}

	const borderW = instance.props.border ? 1 : 0;
	const clipTop = y + borderW;
	const clipBottom = y + h - borderW - 1;

	let contentHeight = 0;
	for (const child of instance.children) {
		const childBottom = Math.round(child.yogaNode.getComputedTop()) +
			Math.round(child.yogaNode.getComputedHeight());
		if (childBottom > contentHeight) contentHeight = childBottom;
	}

	const viewportHeight = clipBottom - clipTop + 1;
	const maxScroll = Math.max(0, contentHeight - viewportHeight);
	const scrollOffset = Math.max(0, Math.min(instance.props.scrollOffset ?? 0, maxScroll));

	instance.props.onMetrics?.({ viewportHeight, contentHeight, maxScroll });
	if (scrollOffset !== (instance.props.scrollOffset ?? 0)) {
		instance.props.onScrollOffsetChange?.(scrollOffset);
	}

	const clipped: Position[] = [];
	for (const child of instance.children) {
		const childTop = Math.round(child.yogaNode.getComputedTop()) - scrollOffset;
		const childHeight = Math.round(child.yogaNode.getComputedHeight());
		const childBottom = childTop + childHeight - 1;

		if (childBottom < 0 || childTop >= viewportHeight) continue;

		const childPositions = context.renderInstance(child, x, y - scrollOffset);
		for (const pos of childPositions) {
			if (pos.y >= clipTop && pos.y <= clipBottom) {
				clipped.push(pos);
			}
		}
	}

	const scrollbarPositions: Position[] = [];
	if (instance.props.scrollbar && contentHeight > viewportHeight) {
		const barX = x + w - borderW - 1;
		const trackHeight = viewportHeight;
		const thumbHeight = Math.max(1, Math.floor(viewportHeight / contentHeight * trackHeight));
		const thumbTop = maxScroll > 0
			? clipTop + Math.floor(scrollOffset / maxScroll * (trackHeight - thumbHeight))
			: clipTop;

		for (let row = clipTop; row <= clipBottom; row++) {
			const isThumb = row >= thumbTop && row < thumbTop + thumbHeight;
			scrollbarPositions.push({
				x: barX,
				y: row,
				text: isThumb ? applyAnsi("█", { fg: theme.textDim }) : applyAnsi("░", { fg: theme.border }),
			});
		}
	}

	return [...borderPositions, ...clipped, ...scrollbarPositions];
};
