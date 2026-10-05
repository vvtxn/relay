import { visibleLength } from "@/tui/core/primitives/char-width.ts";
import { formatText } from "@/tui/core/primitives/format-text.ts";
import { wrapText } from "@/tui/core/primitives/wrap-text.ts";
import type { Children, ElementHandler, Position, TextInstance } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";

function childrenToString(children: Children | undefined): string {
	if (children == null || children === false) return "";
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map((c) => childrenToString(c as Children)).join("");
	return "";
}

export const TextLayout: LayoutHandler<TextInstance> = (instance) => {
	const { width, height, flex } = instance.props;

	instance.yogaNode.setFlex(flex ? Number(flex) : undefined);
	if (width !== undefined) instance.yogaNode.setWidth(width);
	else instance.yogaNode.setWidthAuto();

	if (height !== undefined) {
		instance.yogaNode.unsetMeasureFunc();
		instance.yogaNode.setHeight(height);
	} else {
		instance.yogaNode.setHeightAuto();
		instance.yogaNode.setMeasureFunc((availableWidth) => {
			const text = childrenToString(instance.props.children);
			const w = Math.floor(availableWidth);
			if (w <= 0 || !Number.isFinite(availableWidth)) {
				return { width: text.length, height: 1 };
			}
			const lines = wrapText(text, w);
			const maxLineWidth = Math.max(...lines.map((l) => visibleLength(l)));
			return { width: maxLineWidth, height: lines.length };
		});
	}
};

export const TextElement: ElementHandler<TextInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());
	const width = Math.round(instance.yogaNode.getComputedWidth());
	const height = Math.round(instance.yogaNode.getComputedHeight());
	const text = childrenToString(instance.props.children);

	const lines = wrapText(text, width);

	const positions: Position[] = [];
	const displayLines = lines.slice(0, height);

	for (let i = 0; i < displayLines.length; i++) {
		const line = displayLines[i];
		const formattedLine = formatText({
			...instance,
			props: { ...instance.props, children: line },
		});

		positions.push({
			x,
			y: y + i,
			text: formattedLine,
		});
	}

	return positions;
};
