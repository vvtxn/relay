import { RESET } from "@/tui/core/ansi.ts";
import { toAnsi } from "@/tui/core/primitives/color.ts";
import type { ElementHandler, Position, SpinnerInstance } from "../types/index.ts";
import type { LayoutHandler } from "./index.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SpinnerLayout: LayoutHandler<SpinnerInstance> = (instance) => {
	instance.yogaNode.setWidth(1);
	instance.yogaNode.setHeight(1);
};

export const SpinnerElement: ElementHandler<SpinnerInstance> = (instance, context): Position[] => {
	const x = context.parentX + Math.round(instance.yogaNode.getComputedLeft());
	const y = context.parentY + Math.round(instance.yogaNode.getComputedTop());

	const { color = "#C0C0C0", frame = 0 } = instance.props;
	const char = BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length];

	const baseColor = toAnsi(color) ?? "\x1b[37m";
	const resetCode = RESET;

	return [{ x, y, text: `${baseColor}${char}${resetCode}` }];
};
