import type { Node as YogaNode } from "yoga-layout";
import type { HookStore } from "../hooks/signals.ts";
import type { VNode } from "../jsx-runtime.ts";

/** Primitive children that render as text */
export type PrimitiveChild = string | number;

/** What gets stored in VNode after JSX compilation */
export type VNodeChild = { type: unknown; props: Record<string, unknown> };

/** Valid child types for components */
export type Child = VNodeChild | VNodeChild[] | PrimitiveChild | null | undefined | false;

/** Children prop type - what JSX accepts */
export type Children = Child | Child[];

/** Normalized child type stored in instances (after renderer processing) */
export type InstanceChild = Instance | PrimitiveChild;

export interface Cell {
	char: string;
	style: string;
	/** True for the trailing cell of a double-width character (skipped when flushing). */
	cont?: boolean;
}

export interface Position {
	x: number;
	y: number;
	text: string;
}

export interface RenderContext {
	parentX: number;
	parentY: number;
	renderInstance: (instance: Instance, parentX: number, parentY: number) => Position[];
}

export type ElementHandler<T extends Instance = Instance> = (instance: T, context: RenderContext) => Position[];

export interface BaseProps {
	/** Child elements */
	children?: Children;
	/** Unique key for reconciliation */
	key?: string | number;
}

export interface BoxProps extends BaseProps {
	/** Flex grow factor or boolean to enable flex */
	flex?: number | boolean;
	/** Direction of flex layout */
	flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
	/** Space between child elements */
	gap?: number;
	/** Inner padding */
	padding?: number;
	/** Width of the element */
	width?: number;
	/** Height of the element */
	height?: number;
	/** Alignment along the main axis */
	justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
	/** Alignment along the cross axis */
	alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
	/** Whether flex items wrap */
	flexWrap?: "wrap" | "wrap-reverse" | "nowrap";
	/** Background color of the box */
	bgColor?: string;
	/** Position type for overlay behavior */
	position?: "relative" | "absolute";
	/** Top edge offset (for absolute positioning) */
	top?: number;
	/** left edge offset (for absolute positioning) */
	left?: number;
	/** Right edge offset (for absolute positioning) */
	right?: number;
	/** Bottom edge offset (for absolute positioning) */
	bottom?: number;
}

export interface TextProps extends BaseProps {
	/** Text color */
	color?: string;
	/** Background color */
	bgColor?: string;
	/** Whether text is bold */
	bold?: boolean;
	/** Whether text is italic */
	italic?: boolean;
	/** Whether text is underlined */
	underline?: boolean;
	/** Whether text has strikethrough */
	strikethrough?: boolean;
	/** Maximum width for text wrapping */
	width?: number;
	/** Maximum height for text (number of lines) */
	height?: number;
	/** Flex grow factor */
	flex?: number | boolean;
}

export interface TextInputProps extends BaseProps {
	/** Current value of the input */
	value?: string;
	/** Callback when value changes */
	onChange?: (value: string) => void;
	/** Placeholder text when empty */
	placeholder?: string;
	/** Width of the input field */
	width?: number;
	/** Fixed height in lines. If not set, height auto-scales based on content. */
	height?: number;
	/** Whether the input is focused */
	focused?: boolean;
	/** Cursor position within the input */
	cursorPosition?: number;
	/** Text color */
	color?: string;
	/** Placeholder text color */
	placeholderColor?: string;
}

export interface SpinnerProps extends BaseProps {
	/** Color of the spinner */
	color?: string;
	/** Frame interval in milliseconds (default: 80) */
	interval?: number;
	/** Current animation frame index (managed by Spinner component) */
	frame?: number;
}

export interface MarkdownProps extends BaseProps {
	/** Width constraint for text wrapping (inherits from parent Box if not set) */
	width?: number;
	/** Height constraint (inherits from parent Box if not set) */
	height?: number;
	/** Flex grow factor */
	flex?: number | boolean;
}

export interface ScrollAreaProps extends BoxProps {
	/** Current scroll offset (controlled by useScrollArea hook) */
	scrollOffset?: number;
	/** Whether the scroll area is focused for keyboard input */
	focused?: boolean;
	/** Show a scrollbar indicator */
	scrollbar?: boolean;
	/** Number of lines to scroll per step (default: 1) */
	scrollStep?: number;
	/** Callback when scroll metrics are computed during render */
	onMetrics?: (metrics: ScrollMetrics) => void;
	/** Callback to clamp scroll offset to valid range */
	onScrollOffsetChange?: (offset: number) => void;
}

export interface ScrollMetrics {
	viewportHeight: number;
	contentHeight: number;
	maxScroll: number;
}

/**
 * Element registry - single source of truth for all element types.
 * Extend via module augmentation to add custom elements.
 */
export interface ElementRegistry {
	box: { props: BoxProps; instance: BaseInstance<"box", BoxProps> };
	text: { props: TextProps; instance: BaseInstance<"text", TextProps> };
	textInput: { props: TextInputProps; instance: BaseInstance<"textInput", TextInputProps> };
	spinner: { props: SpinnerProps; instance: BaseInstance<"spinner", SpinnerProps> };
	scrollArea: { props: ScrollAreaProps; instance: BaseInstance<"scrollArea", ScrollAreaProps> };
}

/** Base instance structure - all elements extend this */
export interface BaseInstance<T extends string = string, P extends BaseProps = BaseProps> {
	type: T;
	props: P;
	children: Instance[];
	yogaNode: YogaNode;
	/** The function component that produced this instance (for reconciliation identity) */
	componentType?: unknown;
	/** Hook state store for function components */
	hookStore?: HookStore;
	/**
	 * `memo()` identity for this instance's owner. Kept separate from
	 * `componentType` (which nested reconcilation may overwrite with an inner
	 * wrapper like `Box`) so the memo check stays stable. See `memo.ts`.
	 */
	memoComponent?: unknown;
	/** Props of the last memoized invocation (memo components only) */
	memoProps?: Record<string, unknown>;
	/** Direct output VNode of the last memoized invocation (memo components only) */
	memoOutput?: VNode | null;
}

/** All valid element type strings */
export type ElementTypeName = keyof ElementRegistry;

/** Union of all known instances - derived from registry */
export type Instance = ElementRegistry[keyof ElementRegistry]["instance"];

/** Type helper to extract instance by type name */
export type InstanceOfType<T extends ElementTypeName> = ElementRegistry[T]["instance"];

/** Props map for JSX type inference - derived from registry */
export type ElementPropsMap = { [K in ElementTypeName]: ElementRegistry[K]["props"] };

/** Convenience type aliases for specific instances */
export type BoxInstance = InstanceOfType<"box">;
export type TextInstance = InstanceOfType<"text">;
export type TextInputInstance = InstanceOfType<"textInput">;
export type SpinnerInstance = InstanceOfType<"spinner">;
export type ScrollAreaInstance = InstanceOfType<"scrollArea">;

/** Element type constants */
export const ElementType = {
	BOX: "box",
	TEXT: "text",
	TEXT_INPUT: "textInput",
	SPINNER: "spinner",
	SCROLL_AREA: "scrollArea",
} as const satisfies Record<string, ElementTypeName>;
