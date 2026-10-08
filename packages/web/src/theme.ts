import { type ThemeName, themes, themeToCssVariables } from "@vvtxn/relay/core/theme.ts";
import { font } from "@vvtxn/relay/core/fonts.ts";

/** Apply the chosen palette and font stack as CSS custom properties. */
export function applyTheme(mode: ThemeName = "dark"): void {
	const root = document.documentElement;
	for (const [name, value] of Object.entries(themeToCssVariables(themes[mode]))) {
		root.style.setProperty(name, value);
	}
	root.style.setProperty("--relay-font-mono", font.cssStack);
	// Keep native form controls and scrollbars in step with the palette.
	root.style.colorScheme = mode;
	root.dataset.theme = mode;
}
