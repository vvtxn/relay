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
