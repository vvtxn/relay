import type { Instance } from "#/tui/render/types/index.ts";
import { applyAnsi } from "./color.ts";

function childrenToString(children: unknown): string {
	if (children == null || children === false) return "";
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(childrenToString).join("");
	return "";
}

export const formatText = (instance: Instance): string => {
	if (instance.type !== "text") return "";
	const text = childrenToString(instance.props.children);
	return applyAnsi(text, {
		fg: typeof instance.props.color === "string" ? instance.props.color : undefined,
		bg: typeof instance.props.bgColor === "string" ? instance.props.bgColor : undefined,
		bold: instance.props.bold,
		italic: instance.props.italic,
		underline: instance.props.underline,
		strikethrough: instance.props.strikethrough,
	});
};
