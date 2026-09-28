import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fontInstallDir } from "./fonts.ts";

Deno.test("fontInstallDir - macOS uses the user Library", () => {
	assertEquals(fontInstallDir("darwin", "/home/u"), join("/home/u", "Library", "Fonts"));
});

Deno.test("fontInstallDir - Linux uses XDG data home", () => {
	assertEquals(fontInstallDir("linux", "/home/u"), join("/home/u", ".local", "share", "fonts"));
	assertEquals(
		fontInstallDir("linux", "/home/u", { XDG_DATA_HOME: "/data" }),
		join("/data", "fonts"),
	);
});

Deno.test("fontInstallDir - Windows uses LOCALAPPDATA", () => {
	assertEquals(
		fontInstallDir("win32", join("C:", "Users", "u")),
		join("C:", "Users", "u", "AppData", "Local", "Microsoft", "Windows", "Fonts"),
	);
	assertEquals(
		fontInstallDir("win32", join("C:", "Users", "u"), { LOCALAPPDATA: join("D:", "Local") }),
		join("D:", "Local", "Microsoft", "Windows", "Fonts"),
	);
});
