import Y from "yoga-layout";
import { applyAnsi, applyInheritedBackground, toBgAnsi } from "@/tui/core/primitives/color.ts";
import { fillPositions } from "@/tui/core/primitives/fill.ts";
import { theme } from "@/tui/theme.ts";
import type { ElementHandler, Position, ScrollAreaInstance } from "../types/index.ts";
import { applyBoxPadding } from "./box.ts";
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
	applyBoxPadding(yogaNode, props, props.scrollbar ? 1 : 0);
	if (props.width !== undefined) yogaNode.setWidth(props.width);
	else yogaNode.setWidthAuto();
	if (props.height !== undefined) yogaNode.setHeight(props.height);
	else yogaNode.setHeightAuto();
	yogaNode.setOverflow(Y.OVERFLOW_SCROLL);
};

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

	const clipTop = y;
	const clipBottom = y + h - 1;

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
		const barX = x + w - 1;
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

	if (bg) {
		for (const pos of clipped) pos.text = applyInheritedBackground(pos.text, bg);
		for (const pos of scrollbarPositions) pos.text = applyInheritedBackground(pos.text, bg);
	}

	return [...backgroundPositions, ...clipped, ...scrollbarPositions];
};
