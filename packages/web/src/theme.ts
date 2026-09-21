import { themeToCssVariables } from "@vvtxn/relay/core/theme.ts";

/** Apply the shared Graphite/Silver tokens as CSS custom properties. */
export function applyTheme(): void {
	const root = document.documentElement;
	for (const [name, value] of Object.entries(themeToCssVariables())) {
		root.style.setProperty(name, value);
	}
}
