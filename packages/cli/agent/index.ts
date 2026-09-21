import { startServer } from "@vvtxn/server/main.ts";

const command = Deno.args[0];

try {
	if (command === "serve") {
		startServer();
	} else {
		await import("./app.tsx");
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
