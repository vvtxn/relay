import { assertEquals } from "@std/assert";
import { handleRequest } from "./router.ts";
import type { ServerServices } from "./services.ts";

function services(): ServerServices {
	return {
		config: { publicUrl: "http://127.0.0.1:7433", authProvider: "github", allowLocalAuth: false },
		authSessions: { revoke: () => Promise.resolve() },
	} as unknown as ServerServices;
}

Deno.test("handleRequest - rejects cross-origin state-changing requests", async () => {
	const request = new Request("http://127.0.0.1:7433/api/auth/logout", {
		method: "POST",
		headers: { origin: "http://evil.example" },
	});
	const response = await handleRequest(services(), request);
	assertEquals(response.status, 403);
});

Deno.test("handleRequest - allows the configured public origin", async () => {
	const request = new Request("http://127.0.0.1:7433/api/auth/logout", {
		method: "POST",
		headers: { origin: "http://127.0.0.1:7433" },
	});
	const response = await handleRequest(services(), request);
	assertEquals(response.status, 200);
});

Deno.test("handleRequest - allows requests without an Origin (CLI)", async () => {
	const request = new Request("http://127.0.0.1:7433/api/auth/logout", { method: "POST" });
	const response = await handleRequest(services(), request);
	assertEquals(response.status, 200);
});

Deno.test("handleRequest - does not apply the Origin check to GET", async () => {
	const request = new Request("http://127.0.0.1:7433/api/health", {
		headers: { origin: "http://evil.example" },
	});
	const response = await handleRequest(services(), request);
	assertEquals(response.status, 200);
});
