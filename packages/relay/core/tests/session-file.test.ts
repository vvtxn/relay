import { assertEquals } from "@std/assert";
import { clearStoredSession, readStoredSession, writeStoredSession } from "@/core/auth/session-file.ts";

function withTempHome(run: () => void): void {
	const home = Deno.makeTempDirSync();
	const original = Deno.env.get("HOME");
	try {
		Deno.env.set("HOME", home);
		run();
	} finally {
		if (original === undefined) Deno.env.delete("HOME");
		else Deno.env.set("HOME", original);
		Deno.removeSync(home, { recursive: true });
	}
}

Deno.test("stored session - round trips and clears", () => {
	withTempHome(() => {
		assertEquals(readStoredSession(), null);

		writeStoredSession({
			serverUrl: "http://127.0.0.1:7433",
			token: "opaque-token",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		assertEquals(readStoredSession(), {
			serverUrl: "http://127.0.0.1:7433",
			token: "opaque-token",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		clearStoredSession();
		assertEquals(readStoredSession(), null);
	});
});

Deno.test("stored session - ignores malformed or empty files", () => {
	withTempHome(() => {
		const dir = Deno.env.get("HOME")!;
		Deno.mkdirSync(`${dir}/.relay`, { recursive: true });
		Deno.writeTextFileSync(`${dir}/.relay/session.json`, "{ not json");
		assertEquals(readStoredSession(), null);

		Deno.writeTextFileSync(`${dir}/.relay/session.json`, JSON.stringify({ serverUrl: "x", token: "" }));
		assertEquals(readStoredSession(), null);
	});
});
