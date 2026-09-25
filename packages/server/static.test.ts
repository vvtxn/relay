import { assertEquals } from "@std/assert";
import { serveStatic } from "./static.ts";

Deno.test("serveStatic - serves files from a static dir with SPA fallback", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html>relay");
		await Deno.writeTextFile(`${dir}/app.js`, "console.log(1)");

		const asset = await serveStatic(dir, "/app.js");
		assertEquals(asset.status, 200);
		assertEquals(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

		const fallback = await serveStatic(dir, "/s/abc");
		assertEquals(fallback.status, 200);
		assertEquals(fallback.headers.get("content-type"), "text/html; charset=utf-8");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("serveStatic - never escapes the static dir", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const dir = `${parent}/dist`;
		await Deno.mkdir(dir);
		await Deno.writeTextFile(`${parent}/secret.txt`, "top secret");
		await Deno.writeTextFile(`${dir}/index.html`, "index");

		// `..` is normalized away; the sibling file is never served.
		const response = await serveStatic(dir, "/../secret.txt");
		assertEquals(await response.text(), "index");
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("serveStatic - rejects paths escaping the bundled web dir", async () => {
	// `WEB_DIST_URL` points at `packages/web/dist`; `..` must not escape it.
	assertEquals((await serveStatic(null, "/../package.json")).status, 403);
	assertEquals((await serveStatic(null, "/../../server/main.ts")).status, 403);
});
