import type { BoxProps, ScrollAreaProps, SpinnerProps, TextInputProps, TextProps } from "./types/index.ts";

export interface VNode<P = any> {
	type: string | ((props: P) => VNode);
	props: P & { children?: VNode | VNode[] | string | number };
}

export function jsx<P>(
	type: string | ((props: P) => VNode),
	props: P & { children?: VNode | VNode[] | string | number },
): VNode<P> {
	return { type, props };
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment({ children }: { children?: VNode | VNode[] }): VNode {
	return { type: "fragment", props: { children } };
}

declare global {
	namespace JSX {
		/**
		 * Attributes accepted by every element/component. The custom runtime
		 * passes `key` through in props (it is not stripped like React's), and
		 * reconciliation reads it from there.
		 */
		interface IntrinsicAttributes {
			key?: string | number;
		}
		interface IntrinsicElements {
			box: BoxProps;
			text: TextProps;
			textInput: TextInputProps;
			spinner: SpinnerProps;
			scrollArea: ScrollAreaProps;
		}
		type Element = VNode;
		interface ElementChildrenAttribute {
			children: unknown;
		}
	}
}
