import { spawnCommand } from "@vvtxn/relay/core/command.ts";

/** Open a URL in the platform's default browser (best effort, non-blocking). */
export function openBrowser(url: string): void {
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	if (!command) return;
	try {
		spawnCommand(command, { args, stdin: "null", stdout: "null", stderr: "null" }).unref();
	} catch {
		// Ignore — callers print the URL as a fallback.
	}
}
