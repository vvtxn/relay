import { assertEquals, assertRejects } from "@std/assert";
import { BadRequestError, PayloadTooLargeError, readJsonBody } from "./http.ts";

Deno.test("readJsonBody - parses a valid body", async () => {
	const request = new Request("http://localhost/", { method: "POST", body: JSON.stringify({ a: 1 }) });
	assertEquals(await readJsonBody<{ a: number }>(request), { a: 1 });
});

Deno.test("readJsonBody - rejects a declared oversized body", async () => {
	const request = new Request("http://localhost/", {
		method: "POST",
		headers: { "content-length": String(2 * 1024 * 1024) },
		body: "{}",
	});
	await assertRejects(() => readJsonBody(request), PayloadTooLargeError);
});

Deno.test("readJsonBody - rejects a body that exceeds the cap while streaming", async () => {
	const body = "x".repeat(1024 * 1024 + 1);
	const request = new Request("http://localhost/", { method: "POST", body: JSON.stringify({ body }) });
	await assertRejects(() => readJsonBody(request), PayloadTooLargeError);
});

Deno.test("readJsonBody - rejects invalid JSON", async () => {
	const request = new Request("http://localhost/", { method: "POST", body: "not json" });
	await assertRejects(() => readJsonBody(request), BadRequestError);
});

Deno.test("readJsonBody - rejects an empty body", async () => {
	const request = new Request("http://localhost/", { method: "POST" });
	await assertRejects(() => readJsonBody(request), BadRequestError);
});
