import Y, { type Node as YogaNode } from "yoga-layout";
import type { BoxProps } from "../types/index.ts";

/**
 * Apply a box's padding edges to its Yoga node. Every edge resolves
 * independently — explicit side > axis shorthand > all-edge padding — and
 * `extra` cells (e.g. a border's own ring) are added on top. Shared by Box and
 * ScrollArea so both honor the same padding props.
 */
export function applyBoxPadding(yogaNode: YogaNode, props: BoxProps, extra = 0): void {
	yogaNode.setPadding(Y.EDGE_TOP, (props.paddingTop ?? props.paddingY ?? props.padding ?? 0) + extra);
	yogaNode.setPadding(Y.EDGE_BOTTOM, (props.paddingBottom ?? props.paddingY ?? props.padding ?? 0) + extra);
	yogaNode.setPadding(Y.EDGE_LEFT, (props.paddingLeft ?? props.paddingX ?? props.padding ?? 0) + extra);
	yogaNode.setPadding(Y.EDGE_RIGHT, (props.paddingRight ?? props.paddingX ?? props.padding ?? 0) + extra);
}
