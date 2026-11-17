import { type BaseInstance, type ElementHandler, ElementType } from "../types/index.ts";
import { BoxElement, BoxLayout } from "./box.ts";
import { SpinnerElement, SpinnerLayout } from "./spinner.ts";
import { TextElement, TextLayout } from "./text.ts";
import { ScrollAreaElement, ScrollAreaLayout } from "./scroll-area.ts";
import { TextInputElement, TextInputLayout } from "./text-input.ts";

/** Layout function applies Yoga properties to an instance */
export type LayoutHandler<T extends BaseInstance = BaseInstance> = (instance: T) => void;

/** Export ElementType here for clarity */
export { ElementType };

interface ElementDefinition {
	render: ElementHandler<any>;
	layout: LayoutHandler<any>;
	/** If true, children are processed (like box). If false, children stay in props (like text) */
	hasChildren: boolean;
}

const elements: Record<string, ElementDefinition> = {
	[ElementType.BOX]: { render: BoxElement, layout: BoxLayout, hasChildren: true },
	[ElementType.TEXT]: { render: TextElement, layout: TextLayout, hasChildren: false },
	[ElementType.TEXT_INPUT]: { render: TextInputElement, layout: TextInputLayout, hasChildren: false },
	[ElementType.SPINNER]: { render: SpinnerElement, layout: SpinnerLayout, hasChildren: false },
	[ElementType.SCROLL_AREA]: { render: ScrollAreaElement, layout: ScrollAreaLayout, hasChildren: true },
};

/** Get element definition by type */
export function getElement(type: string): ElementDefinition {
	const element = elements[type];
	if (!element) {
		throw new Error(`No element registered for type: ${type}`);
	}
	return element;
}

export { BoxElement, ScrollAreaElement, SpinnerElement, TextElement, TextInputElement };
