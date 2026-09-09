/**
 * Graphite / Silver theme for the Relay CLI.
 *
 * A dark, monochrome developer-tool theme:
 * near-black canvas → silver primary information → graphite depth.
 * See graphite-silver-coding-agent-theme.md for the full design tokens.
 *
 * The theme is fixed — there is no runtime override. All UI components
 * must reference these values instead of hardcoding colors.
 */

export interface Theme {
	// Brand / accent
	brand: string;
	accent: string;

	// Semantic
	success: string;
	warning: string;
	error: string;
	info: string;

	// Text
	text: string;
	textMuted: string;
	textDim: string;

	// UI chrome
	border: string;
	borderLabel: string;

	// Markdown
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
	// Brand / accent — silver primary (#C0C0C0), highlight (#D8D8D8)
	brand: "#C0C0C0",
	accent: "#D8D8D8",

	// Semantic — desaturated agent states, never neon
	success: "#A8B0A8",
	warning: "#B8B0A0",
	error: "#B0A0A0",
	info: "#A8A8B0",

	// Text — primary / secondary / metadata
	text: "#F2F2F2",
	textMuted: "#C0C0C0",
	textDim: "#808080",

	// UI chrome — thin graphite borders
	border: "#303030",
	borderLabel: "#808080",

	// Markdown — grayscale luminance hierarchy
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
