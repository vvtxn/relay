/** Open a URL in the platform's default browser (best effort, non-blocking). */
export function openBrowser(url: string): void {
	const [command, ...args] = Deno.build.os === "darwin"
		? ["open", url]
		: Deno.build.os === "windows"
		? ["cmd", "/c", "start", "", url]
		: ["xdg-open", url];
	if (!command) return;
	try {
		new Deno.Command(command, { args, stdin: "null", stdout: "null", stderr: "null" }).spawn().unref();
	} catch {
		// Ignore — callers print the URL as a fallback.
	}
}
