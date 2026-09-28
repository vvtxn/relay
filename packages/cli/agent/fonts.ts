import { fromFileUrl, join } from "@std/path";
import { font } from "@vvtxn/relay/core/fonts.ts";
import { homeDir } from "@vvtxn/relay/core/paths.ts";

/**
 * `relay fonts` — install the shared Relay font for the terminal.
 *
 * Unlike the web client, a terminal cannot load a font at runtime: the user
 * selects one in their terminal emulator. This command copies the bundled
 * ttf/otf files into the platform's user font directory and prints what to
 * select. Files are resolved relative to this module, so the same code works
 * from a source checkout and from the compiled binary (which embeds
 * `packages/relay/assets` via `scripts/build.ts`).
 */

const FONT_ASSET_DIR = new URL("../../relay/assets/fonts/", import.meta.url);

const USAGE = `Usage: relay fonts <command>

Commands:
  install   Install the bundled font for your terminal
  status    Show whether the bundled font is installed
  path      Print the bundled font directory

Terminals own their font: after installing, select "${font.family}" in your
terminal settings. The web client loads the same font automatically.`;

export interface FontEnv {
	/** Linux: user data base (defaults to `~/.local/share`). */
	XDG_DATA_HOME?: string;
	/** Windows: local app data (defaults to `~/AppData/Local`). */
	LOCALAPPDATA?: string;
}

/** User-level font directory for the given platform. */
export function fontInstallDir(platform: string, home: string, env: FontEnv = {}): string {
	switch (platform) {
		case "darwin":
			return join(home, "Library", "Fonts");
		case "win32":
			return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts");
		default:
			return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "fonts");
	}
}

function currentEnv(): FontEnv {
	const env: FontEnv = {};
	const xdg = Deno.env.get("XDG_DATA_HOME");
	if (xdg) env.XDG_DATA_HOME = xdg;
	const localAppData = Deno.env.get("LOCALAPPDATA");
	if (localAppData) env.LOCALAPPDATA = localAppData;
	return env;
}

function requireHome(): string {
	const home = homeDir();
	if (!home) throw new Error("Cannot determine your home directory (HOME is not set).");
	return home;
}

async function exists(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Refresh fontconfig's cache so terminals pick the new files up without a logout. */
async function refreshFontCache(): Promise<void> {
	try {
		const { success } = await new Deno.Command("fc-cache", {
			args: ["-f"],
			stdout: "null",
			stderr: "null",
		}).output();
		if (success) console.log("Refreshed the system font cache (fc-cache).");
	} catch {
		// fontconfig is unavailable; most terminals still pick the font up after a restart.
	}
}

async function install(): Promise<void> {
	const dir = fontInstallDir(Deno.build.os, requireHome(), currentEnv());
	await Deno.mkdir(dir, { recursive: true });
	for (const file of font.terminal) {
		const data = await Deno.readFile(new URL(file, FONT_ASSET_DIR));
		await Deno.writeFile(join(dir, file), data);
	}
	if (Deno.build.os === "linux") await refreshFontCache();

	console.log(`Installed ${font.family} (${font.license}) to ${dir}`);
	console.log(`Select "${font.family}" in your terminal settings, then restart the terminal.`);
}

async function status(): Promise<void> {
	console.log(`${font.family} (${font.license})`);
	console.log(`  Homepage: ${font.homepage}`);
	console.log(`  Bundled:  ${fromFileUrl(FONT_ASSET_DIR)}`);

	const home = homeDir();
	if (!home) {
		console.log("  Installed: unknown (HOME is not set)");
		return;
	}

	const dir = fontInstallDir(Deno.build.os, home, currentEnv());
	console.log(`  Font dir: ${dir}`);

	let missing = 0;
	for (const file of font.terminal) {
		const present = await exists(join(dir, file));
		if (!present) missing++;
		console.log(`  ${present ? "installed" : "missing  "}  ${file}`);
	}
	if (missing > 0) console.log(`Run \`relay fonts install\` to install ${font.family}.`);
}

export async function runFontsCommand(args: string[]): Promise<void> {
	switch (args[0]) {
		case "install":
			await install();
			break;
		case "status":
			await status();
			break;
		case "path":
			console.log(fromFileUrl(FONT_ASSET_DIR));
			break;
		default:
			console.log(USAGE);
	}
}
