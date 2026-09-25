import { assertEquals, assertRejects } from "@std/assert";
import { readSSEStream } from "./sse.ts";
import { RelayApiError, RelayClient } from "./client.ts";
import type { ServerEvent } from "./protocol.ts";

function sseResponse(...frames: unknown[]): Response {
	const parts: string[] = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
	const body = new Blob(parts).stream();
	return new Response(body, { status: 200 });
}

Deno.test("readSSEStream - parses multiple frames", async () => {
	const events: ServerEvent[] = [
		{ type: "text_delta", content: "hello" },
		{ type: "run_finished", reason: "completed" },
	];
	const collected: ServerEvent[] = [];
	for await (const event of readSSEStream<ServerEvent>(sseResponse(...events))) {
		collected.push(event);
	}
	assertEquals(collected, events);
});

Deno.test("readSSEStream - stops at [DONE]", async () => {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text_delta", content: "a" })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text_delta", content: "b" })}\n\n`));
			controller.close();
		},
	});
	const response = new Response(body);
	const collected: ServerEvent[] = [];
	for await (const event of readSSEStream<ServerEvent>(response)) collected.push(event);
	assertEquals(collected, [{ type: "text_delta", content: "a" }]);
});

Deno.test("readSSEStream - skips malformed frames", async () => {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("data: not-json\n\n"));
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "run_finished", reason: "cancelled" })}\n\n`),
			);
			controller.close();
		},
	});
	const response = new Response(body);
	const collected: ServerEvent[] = [];
	for await (const event of readSSEStream<ServerEvent>(response)) collected.push(event);
	assertEquals(collected, [{ type: "run_finished", reason: "cancelled" }]);
});

Deno.test("readSSEStream - throws when body is null", async () => {
	const response = new Response(null, { status: 200 });
	await assertRejects(
		async () => {
			for await (const _ of readSSEStream(response)) { /* unreachable */ }
		},
		Error,
		"body is null",
	);
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return ((input: string | URL | Request, init?: RequestInit) =>
		Promise.resolve(handler(typeof input === "string" ? input : input.toString(), init))) as typeof fetch;
}

Deno.test("RelayClient - builds correct request URLs", async () => {
	const calls: { url: string; method: string }[] = [];
	const client = new RelayClient({
		baseUrl: "http://localhost:7433/",
		fetch: mockFetch((url, init) => {
			calls.push({ url, method: init?.method ?? "GET" });
			return new Response("{}", { status: 200 });
		}),
	});

	await client.health();
	await client.me();
	await client.listSessions("/home/user/project");
	await client.listWorkspaces();
	await client.createSession("/home/user/project");
	await client.openSession("abc123");
	await client.listFiles("abc123");
	await client.sendMessage("abc123", "hello");
	await client.approve("abc123", "tool-1", "allow");
	await client.cancel("abc123");

	assertEquals(calls, [
		{ url: "http://localhost:7433/api/health", method: "GET" },
		{ url: "http://localhost:7433/api/me", method: "GET" },
		{ url: "http://localhost:7433/api/sessions?cwd=%2Fhome%2Fuser%2Fproject", method: "GET" },
		{ url: "http://localhost:7433/api/workspaces", method: "GET" },
		{ url: "http://localhost:7433/api/sessions", method: "POST" },
		{ url: "http://localhost:7433/api/sessions/abc123", method: "GET" },
		{ url: "http://localhost:7433/api/sessions/abc123/files", method: "GET" },
		{ url: "http://localhost:7433/api/sessions/abc123/messages", method: "POST" },
		{ url: "http://localhost:7433/api/sessions/abc123/approve", method: "POST" },
		{ url: "http://localhost:7433/api/sessions/abc123/cancel", method: "POST" },
	]);
});

Deno.test("RelayClient - throws RelayApiError with server message on error responses", async () => {
	const client = new RelayClient({
		baseUrl: "http://localhost:7433",
		fetch: mockFetch(() => new Response(JSON.stringify({ error: "session not found" }), { status: 404 })),
	});
	const error = await assertRejects(() => client.openSession("nope"), RelayApiError);
	assertEquals(error.status, 404);
	assertEquals(error.message, "session not found");
});

Deno.test("RelayClient - falls back to status text for non-JSON errors", async () => {
	const client = new RelayClient({
		baseUrl: "http://localhost:7433",
		fetch: mockFetch(() => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" })),
	});
	const error = await assertRejects(() => client.health(), RelayApiError);
	assertEquals(error.status, 502);
	assertEquals(error.message, "bad gateway");
});

Deno.test("RelayClient - subscribe yields server events", async () => {
	const events: ServerEvent[] = [
		{ type: "text_delta", content: "hi" },
		{ type: "run_finished", reason: "completed" },
	];
	const client = new RelayClient({
		baseUrl: "http://localhost:7433",
		fetch: mockFetch(() => sseResponse(...events)),
	});
	const collected: ServerEvent[] = [];
	for await (const event of client.subscribe("s1")) collected.push(event);
	assertEquals(collected, events);
});
