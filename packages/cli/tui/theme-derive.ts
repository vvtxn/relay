/**
 * Derive a Relay theme from the terminal's own colors.
 *
 * Neutrals come from the default foreground/background so hierarchy survives:
 * surfaces are small foreground blends into the background, text steps fade
 * toward the background, and borders sit between the two. Semantic accents use
 * the ANSI palette when the terminal reports it (OSC 4); otherwise they fall
 * back to ANSI slot names, which the terminal resolves itself.
 */

import type { Theme } from "@vvtxn/relay/core/theme.ts";
import type { Rgb } from "#/tui/core/terminal-palette.ts";

function clamp(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)));
}

function rgbToHex(color: Rgb): string {
	const channel = (value: number) => clamp(value).toString(16).padStart(2, "0");
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Linear interpolation in sRGB: `amount` 0 = a, 1 = b. */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
	return {
		r: a.r + (b.r - a.r) * amount,
		g: a.g + (b.g - a.g) * amount,
		b: a.b + (b.b - a.b) * amount,
	};
}

function linearChannel(value: number): number {
	const channel = value / 255;
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Rgb): number {
	return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function highestContrast(candidates: Array<Rgb | null | undefined>, background: Rgb): Rgb | null {
	let best: Rgb | null = null;
	let bestRatio = 0;
	for (const candidate of candidates) {
		if (!candidate) continue;
		const ratio = contrastRatio(candidate, background);
		if (ratio > bestRatio) {
			best = candidate;
			bestRatio = ratio;
		}
	}
	return best;
}

/**
 * Push a hue toward the terminal foreground until it is readable on the base
 * background and the surfaces it can appear on. Mixing toward the foreground
 * always improves contrast: it is the terminal's own readable text color.
 */
function ensureReadable(color: Rgb, foreground: Rgb, background: Rgb, surfaces: Rgb[], target = 3.3): Rgb {
	const readable = (candidate: Rgb) =>
		[background, ...surfaces].every((surface) => contrastRatio(candidate, surface) >= target);
	for (const amount of [0.18, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
		const candidate = mix(color, foreground, amount);
		if (readable(candidate)) return candidate;
	}
	return foreground;
}

/**
 * Pick an ANSI foreground for a semantic role. Prefers the normal slot to
 * preserve the hue the terminal theme intended, falling back to the bright slot
 * only when the normal one is too dark to read, and to an ANSI color name when
 * the terminal did not report its palette. The result is blended toward the
 * terminal foreground until it meets the contrast target.
 */
function semantic(
	normalIndex: number,
	brightIndex: number,
	fallback: string,
	ansi: ReadonlyArray<Rgb | null>,
	foreground: Rgb,
	background: Rgb,
	surfaces: Rgb[],
	target = 3.3,
): string {
	const normal = ansi[normalIndex] ?? null;
	const bright = ansi[brightIndex] ?? null;
	// Prefer the normal slot to preserve the hue the terminal theme intended.
	// Some palettes (Solarized) use bright slots for base tones, so switching
	// on contrast alone can turn "green" into the theme's gray. Only fall back
	// to bright when the normal slot is genuinely too dark to read.
	const usable = (color: Rgb) => [background, ...surfaces].every((surface) => contrastRatio(color, surface) >= 2);

	let chosen: Rgb | null = null;
	if (normal && usable(normal)) chosen = normal;
	else if (bright && usable(bright)) chosen = bright;
	else chosen = highestContrast([normal, bright], background);

	if (!chosen) return fallback;
	return rgbToHex(ensureReadable(chosen, foreground, background, surfaces, target));
}

export function deriveTheme(foreground: Rgb, background: Rgb, ansi: ReadonlyArray<Rgb | null>): Theme {
	const dark = relativeLuminance(background) < 0.5;

	const surface = mix(background, foreground, dark ? 0.06 : 0.045);
	const surfaceElevated = mix(background, foreground, dark ? 0.12 : 0.09);
	// Fading toward the background needs different steps on light and dark
	// canvases to keep the same perceived contrast (the light palette's text
	// ramp is compressed because its background is much brighter).
	const textMuted = mix(foreground, background, dark ? 0.22 : 0.15);
	const textDim = mix(foreground, background, dark ? 0.48 : 0.35);
	const textFaint = mix(foreground, background, dark ? 0.66 : 0.5);
	const border = mix(background, foreground, 0.18);
	const borderLabel = mix(foreground, background, dark ? 0.45 : 0.5);

	const brand = mix(foreground, background, dark ? 0.22 : 0.14);
	const accent = foreground;
	const heading2 = mix(foreground, background, dark ? 0.1 : 0.05);
	const heading3 = mix(foreground, background, dark ? 0.22 : 0.14);
	const codeInline = mix(foreground, background, dark ? 0.22 : 0.2);
	const codeBlock = mix(foreground, background, dark ? 0.12 : 0.05);

	const baseSurfaces = [surface];
	const elevatedSurfaces = [surface, surfaceElevated];
	const pick = (normalIndex: number, brightIndex: number, fallback: string, surfaces = baseSurfaces, target = 3.3) =>
		semantic(normalIndex, brightIndex, fallback, ansi, foreground, background, surfaces, target);

	const success = pick(2, 10, "green");
	const warning = pick(3, 11, "yellow");
	const error = pick(1, 9, "red");
	const info = pick(4, 12, "blue", elevatedSurfaces, 3.5);

	return {
		brand: rgbToHex(brand),
		accent: rgbToHex(accent),

		success,
		warning,
		error,
		info,

		text: rgbToHex(foreground),
		textMuted: rgbToHex(textMuted),
		textDim: rgbToHex(textDim),
		textFaint: rgbToHex(textFaint),

		background: rgbToHex(background),
		surface: rgbToHex(surface),
		surfaceElevated: rgbToHex(surfaceElevated),

		border: rgbToHex(border),
		borderLabel: rgbToHex(borderLabel),

		heading1: rgbToHex(foreground),
		heading2: rgbToHex(heading2),
		heading3: rgbToHex(heading3),
		codeInline: rgbToHex(codeInline),
		codeBlock: rgbToHex(codeBlock),
		link: rgbToHex(foreground),
		linkUrl: rgbToHex(textDim),
		mention: pick(6, 14, "cyan"),
		blockquote: rgbToHex(textDim),
		listBullet: rgbToHex(textDim),
		hr: rgbToHex(border),

		toolRead: pick(4, 12, "blue"),
		toolWrite: pick(2, 10, "green"),
		toolEdit: pick(3, 11, "yellow"),
		toolGrep: pick(5, 13, "magenta"),
		toolRun: pick(1, 9, "red"),
	};
}
