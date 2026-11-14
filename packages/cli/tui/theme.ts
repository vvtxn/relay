/**
 * Active theme for the Relay CLI.
 *
 * The tokens live in `@vvtxn/relay/core/theme.ts` so the terminal and web
 * clients share one source of truth. The terminal starts from the dark
 * Graphite palette and may replace it in place once at startup — before the
 * app imports its components — with a palette derived from the terminal's own
 * colors (`auto`) or one of the built-in palettes.
 */

import { lightTheme, theme as darkTheme, type Theme } from "@vvtxn/relay/core/theme.ts";

/** Palettes selectable by name (`--theme`, `RELAY_THEME`, config). */
export const builtinThemes = { dark: darkTheme, light: lightTheme } as const;

/** Active CLI palette. Mutated once during startup, before the first render. */
export const theme: Theme = { ...darkTheme };

/**
 * Replace every token of the active palette in place. Importers hold a
 * reference to `theme`, so this must run before component modules capture
 * colors (the CLI applies it before importing `app.tsx`).
 */
export function setTheme(next: Theme): void {
	Object.assign(theme, next);
}

export { themeToCssVariables } from "@vvtxn/relay/core/theme.ts";
export type { Theme } from "@vvtxn/relay/core/theme.ts";
