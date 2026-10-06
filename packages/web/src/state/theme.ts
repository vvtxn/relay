import { createSignal } from "solid-js";
import { readStoredTheme, type ThemePreference, writeStoredTheme } from "@/api/storage.ts";
import { applyTheme } from "@/theme.ts";

const [theme, setThemeSignal] = createSignal<ThemePreference>(readStoredTheme());
export { theme };

/** Apply the persisted palette at startup (before the first render). */
export function applyStoredTheme(): void {
	applyTheme(theme());
}

/** Switch palettes and persist the choice for the next visit. */
export function setTheme(next: ThemePreference): void {
	if (next === theme()) return;
	setThemeSignal(next);
	writeStoredTheme(next);
	applyTheme(next);
}
