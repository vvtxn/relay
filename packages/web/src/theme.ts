import { themeToCssVariables } from "@vvtxn/relay/core/theme.ts";
import { font } from "@vvtxn/relay/core/fonts.ts";

/** Apply the shared Graphite/Silver tokens and font stack as CSS custom properties. */
export function applyTheme(): void {
	const root = document.documentElement;
	for (const [name, value] of Object.entries(themeToCssVariables())) {
		root.style.setProperty(name, value);
	}
	root.style.setProperty("--relay-font-mono", font.cssStack);
}
