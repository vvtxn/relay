/**
 * Trimmed `@pierre/theming/themes` replacement, aliased in `vite.config.ts`.
 *
 * `@pierre/diffs` imports this entry to register theme loaders: `pierreThemes`
 * for the ten first-party themes and `shikiThemes` for the 65 bundled Shiki
 * themes. The app only ever uses `pierre-dark` and `pierre-light` (see
 * `highlight.ts`), yet the full registry emits a lazy chunk per theme, so this
 * module keeps just those two and leaves the Shiki collection empty.
 *
 * Theme resolution never falls back to `shikiThemes` for `pierre-*` names:
 * `prepareThemeResolution` checks the resolver, which `shared_highlighter`
 * seeds from `pierreThemes` on import.
 */

import { createThemeCollection, type ThemeCollection, type ThemeLike, type ThemeLoader } from "@pierre/theming";
import { normalizeTheme, type ThemeRegistrationAny, type ThemeRegistrationResolved } from "shiki/core";

function unwrapDefault<T>(value: T | { default: T }): T {
	return typeof value === "object" && value !== null && "default" in value ? value.default : value;
}

/** Same contract as `@pierre/theming`'s `createTheme`, kept local to this file. */
export function createTheme(options: {
	name: string;
	load: ThemeLoader;
	colorScheme?: "light" | "dark";
	collection?: string;
	displayName?: string;
}): {
	name: string;
	load: () => Promise<ThemeRegistrationResolved>;
	colorScheme?: "light" | "dark";
	collection?: string;
	displayName?: string;
} {
	const { name, load, colorScheme, collection, displayName } = options;
	return {
		name,
		load: async () => normalizeTheme(unwrapDefault(await load()) as ThemeRegistrationAny),
		...(colorScheme === undefined ? {} : { colorScheme }),
		...(collection === undefined ? {} : { collection }),
		...(displayName === undefined ? {} : { displayName }),
	};
}

/** The only first-party themes this app renders. */
const PIERRE_THEMES = [
	{
		name: "pierre-dark",
		colorScheme: "dark",
		displayName: "Pierre Dark",
		load: () => import("@pierre/theme/pierre-dark"),
	},
	{
		name: "pierre-light",
		colorScheme: "light",
		displayName: "Pierre Light",
		load: () => import("@pierre/theme/pierre-light"),
	},
] as const;

export const pierreThemes: ThemeCollection = createThemeCollection({
	themes: PIERRE_THEMES.map((theme) => createTheme({ ...theme })),
});

/** Bundled Shiki themes are unused; an empty collection keeps their chunks out. */
export const shikiThemes: ThemeCollection = createThemeCollection<ThemeLike>({ themes: [] });
