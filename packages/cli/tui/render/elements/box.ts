import Y from "yoga-layout";
import type { Node as YogaNode } from "yoga-layout";
import { applyInheritedBackground, toBgAnsi } from "@/tui/core/primitives/color.ts";
import { fillPositions } from "@/tui/core/primitives/fill.ts";
import type { BoxInstance, BoxProps, ElementHandler, Position } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";

/**
 * Apply box padding to a Yoga node, resolving the edge overrides.
 *
 * `padding` sets every edge, `paddingX` / `paddingY` override an axis, and the
 * per-edge props override both. This lets a full-bleed surface keep a wide
 * horizontal gutter while staying tight vertically — one number for both made
 * surfaces either cramped or bloated. `extraRight` reserves additional space on
 * the right (e.g. a scrollbar).
 */
export function applyBoxPadding(yogaNode: YogaNode, props: BoxProps, extraRight = 0) {
	const all = props.padding ?? 0;
	const x = props.paddingX ?? all;
	const y = props.paddingY ?? all;
	yogaNode.setPadding(Y.EDGE_LEFT, props.paddingLeft ?? x);
	yogaNode.setPadding(Y.EDGE_RIGHT, (props.paddingRight ?? x) + extraRight);
	yogaNode.setPadding(Y.EDGE_TOP, props.paddingTop ?? y);
	yogaNode.setPadding(Y.EDGE_BOTTOM, props.paddingBottom ?? y);
}

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

const FLEX_WRAP_MAP = {
	wrap: Y.WRAP_WRAP,
	"wrap-reverse": Y.WRAP_WRAP_REVERSE,
	nowrap: Y.WRAP_NO_WRAP,
} as const;

export const BoxLayout: LayoutHandler<BoxInstance> = (instance) => {
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
	yogaNode.setFlexWrap(props.flexWrap ? FLEX_WRAP_MAP[props.flexWrap] : Y.WRAP_NO_WRAP);
	yogaNode.setPositionType(props.position === "absolute" ? Y.POSITION_TYPE_ABSOLUTE : Y.POSITION_TYPE_RELATIVE);
	if (props.top !== undefined) yogaNode.setPosition(Y.EDGE_TOP, props.top);
	else yogaNode.setPositionAuto(Y.EDGE_TOP);
	if (props.left !== undefined) yogaNode.setPosition(Y.EDGE_LEFT, props.left);
	else yogaNode.setPositionAuto(Y.EDGE_LEFT);
	if (props.right !== undefined) yogaNode.setPosition(Y.EDGE_RIGHT, props.right);
	else yogaNode.setPositionAuto(Y.EDGE_RIGHT);
	if (props.bottom !== undefined) yogaNode.setPosition(Y.EDGE_BOTTOM, props.bottom);
	else yogaNode.setPositionAuto(Y.EDGE_BOTTOM);
};

export const BoxElement: ElementHandler<BoxInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());
	const w = Math.round(instance.yogaNode.getComputedWidth());
	const h = Math.round(instance.yogaNode.getComputedHeight());
	const positions: Position[] = [];

	const bg = instance.props.bgColor && instance.props.bgColor !== "default" ? toBgAnsi(instance.props.bgColor) : null;
	if (bg) {
		positions.push(...fillPositions(x, y, w, h, bg));
	}

	const childPositions = instance.children.flatMap((child) => context.renderInstance(child, x, y));
	if (bg) {
		for (const pos of childPositions) {
			pos.text = applyInheritedBackground(pos.text, bg);
		}
	}
	positions.push(...childPositions);

	return positions;
};
