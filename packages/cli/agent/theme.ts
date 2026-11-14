import { config, isThemeMode, type ThemeMode } from "./config.ts";
import { queryTerminalPalette } from "#/tui/core/terminal-palette.ts";
import { builtinThemes, setTheme, type Theme } from "#/tui/theme.ts";
import { deriveTheme } from "#/tui/theme-derive.ts";

/** Parse a `--theme` flag value, rejecting anything outside the three modes. */
export function parseThemeMode(value: string | undefined): ThemeMode {
	if (!isThemeMode(value)) throw new Error("--theme requires auto, dark, or light");
	return value;
}

/** Resolve the palette preference: flag > environment > config > auto. */
function resolveThemeMode(override?: ThemeMode | null): ThemeMode {
	if (override) return override;
	const environment = process.env.RELAY_THEME;
	if (isThemeMode(environment)) return environment;
	return config.theme;
}

/**
 * `COLORFGBG` is set by several terminals (rxvt, Konsole, xterm) as
 * `foreground;background` ANSI indices. It is only a hint for the silent-
 * terminal fallback; the real colors come from OSC queries.
 */
function lightBackgroundHint(): boolean {
	const value = process.env.COLORFGBG;
	if (!value) return false;
	const parts = value.split(";");
	const background = Number.parseInt(parts[parts.length - 1] ?? "", 10);
	return background === 7 || (background >= 9 && background <= 15);
}

function fallbackTheme(): Theme {
	return lightBackgroundHint() ? builtinThemes.light : builtinThemes.dark;
}

/**
 * Apply the palette before the TUI imports its components. `auto` asks the
 * terminal for its colors and derives a matching theme; a terminal that does
 * not answer falls back to the built-in dark (or, when `COLORFGBG` indicates a
 * light background, light) palette.
 */
export async function prepareTheme(override?: ThemeMode | null): Promise<void> {
	const mode = resolveThemeMode(override);

	if (mode === "dark") {
		setTheme(builtinThemes.dark);
		return;
	}
	if (mode === "light") {
		setTheme(builtinThemes.light);
		return;
	}

	try {
		const palette = await queryTerminalPalette();
		if (palette?.foreground && palette.background) {
			setTheme(deriveTheme(palette.foreground, palette.background, palette.ansi));
			return;
		}
	} catch {
		/* a failed probe must never block the TUI */
	}

	setTheme(fallbackTheme());
}
