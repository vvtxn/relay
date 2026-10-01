/**
 * Relay typography — shared font identity for every client.
 *
 * The web client loads the woff2 faces in {@link font.web} via `@font-face`
 * (see `packages/web/src/styles.css`) and applies {@link font.cssStack} as
 * `--relay-font-mono`. A terminal owns its font, so the CLI cannot force one:
 * it installs the ttf/otf files in {@link font.terminal} into the user's font
 * directory (`relay fonts install`) and tells them to select the family.
 *
 * Deliberately dependency-free and browser-safe. To swap the typeface, replace
 * the files under `packages/relay/assets/fonts/` and update this object — the
 * asset file names are stable, so no client code needs to change. The bundled
 * license must be replaced alongside the files.
 */

/** Numeric CSS font weights bundled by the web client. */
export type FontWeight = 400 | 700;

export interface WebFontFace {
	weight: FontWeight;
	style: "normal" | "italic";
	/** File name under `packages/relay/assets/fonts/`. */
	file: string;
}

export interface RelayFont {
	/** Human-readable family name, as terminals list it. */
	family: string;
	/** Full CSS font stack applied by the web client. */
	cssStack: string;
	/** Faces loaded by the web client. */
	web: WebFontFace[];
	/** TTF/OTF files installed for the terminal. */
	terminal: string[];
	/** SPDX license identifier. */
	license: string;
	/** License file name under `packages/relay/assets/fonts/`. */
	licenseFile: string;
	homepage: string;
}

export const font: RelayFont = {
	family: "JetBrains Mono",
	cssStack: [
		'"JetBrains Mono"',
		"ui-monospace",
		"SF Mono",
		"Menlo",
		"Consolas",
		'"Liberation Mono"',
		"monospace",
	].join(", "),
	web: [
		{ weight: 400, style: "normal", file: "relay-mono-regular.woff2" },
		{ weight: 700, style: "normal", file: "relay-mono-bold.woff2" },
		{ weight: 400, style: "italic", file: "relay-mono-italic.woff2" },
	],
	terminal: ["relay-mono-regular.ttf", "relay-mono-bold.ttf", "relay-mono-italic.ttf"],
	license: "OFL-1.1",
	licenseFile: "OFL.txt",
	homepage: "https://www.jetbrains.com/lp/mono/",
};
