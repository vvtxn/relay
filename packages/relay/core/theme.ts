/**
 * Graphite / Silver theme — shared design tokens for every Relay client.
 *
 * A dark, monochrome developer-tool theme:
 * near-black canvas → silver primary information → graphite depth.
 *
 * Deliberately dependency-free and browser-safe: the terminal UI consumes the
 * raw tokens while the web client maps them to CSS custom properties. There is
 * no runtime override — all UI components reference these values instead of
 * hardcoding colors.
 */

export interface Theme {
	brand: string;
	accent: string;

	success: string;
	warning: string;
	error: string;
	info: string;

	text: string;
	textMuted: string;
	textDim: string;
	textFaint: string;

	background: string;
	surface: string;
	surfaceElevated: string;

	border: string;
	borderLabel: string;

	heading1: string;
	heading2: string;
	heading3: string;
	codeInline: string;
	codeBlock: string;
	link: string;
	linkUrl: string;
	blockquote: string;
	listBullet: string;
	hr: string;
}

export const theme: Theme = {
	brand: "#C0C0C0",
	accent: "#D8D8D8",

	success: "#A8B0A8",
	warning: "#B8B0A0",
	error: "#B0A0A0",
	info: "#A8A8B0",

	text: "#F2F2F2",
	textMuted: "#C0C0C0",
	textDim: "#808080",
	textFaint: "#606060",

	background: "#0A0A0A",
	surface: "#101010",
	surfaceElevated: "#181818",

	border: "#303030",
	borderLabel: "#808080",

	heading1: "#FFFFFF",
	heading2: "#D8D8D8",
	heading3: "#C0C0C0",
	codeInline: "#B8B8B8",
	codeBlock: "#C0C0C0",
	link: "#D8D8D8",
	linkUrl: "#808080",
	blockquote: "#808080",
	listBullet: "#808080",
	hr: "#303030",
};

/**
 * Light counterpart built from the same token names: paper canvas → graphite
 * primary information. Used by clients that offer a light/dark switch (the web
 * app); the terminal keeps the dark default.
 */
export const lightTheme: Theme = {
	brand: "#3C3C3C",
	accent: "#1F1F1F",

	success: "#4A6B4A",
	warning: "#7A6A3A",
	error: "#8A3F3F",
	info: "#3F4A6B",

	text: "#1C1C1C",
	textMuted: "#3C3C3C",
	textDim: "#6A6A6A",
	textFaint: "#8C8C8C",

	background: "#FAFAFA",
	surface: "#F2F2F2",
	surfaceElevated: "#E8E8E8",

	border: "#D6D6D6",
	borderLabel: "#8C8C8C",

	heading1: "#000000",
	heading2: "#262626",
	heading3: "#3C3C3C",
	codeInline: "#4A4A4A",
	codeBlock: "#262626",
	link: "#262626",
	linkUrl: "#6A6A6A",
	blockquote: "#6A6A6A",
	listBullet: "#6A6A6A",
	hr: "#D6D6D6",
};

/** Named palettes for clients that let the user pick one. */
export const themes = { dark: theme, light: lightTheme } as const;

export type ThemeName = keyof typeof themes;

const CSS_VARIABLE_PREFIX = "--relay-";

function toKebabCase(key: string): string {
	return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** Map theme tokens to CSS custom properties, e.g. `--relay-text-muted`. */
export function themeToCssVariables(source: Theme = theme): Record<string, string> {
	const variables: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		variables[`${CSS_VARIABLE_PREFIX}${toKebabCase(key)}`] = value;
	}
	return variables;
}
