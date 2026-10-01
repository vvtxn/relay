import { assertEquals, assertRejects } from "@std/assert";
import { parseSSEStream } from "@/api/streaming/stream.ts";
import type { StreamChunk } from "@/api/types.ts";

function mockResponse(data: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(data));
				controller.close();
			},
		}),
	);
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

const validChunk: StreamChunk = {
	id: "1",
	object: "chat.completion.chunk",
	created: 0,
	model: "test",
	choices: [],
};

Deno.test("parseSSEStream - parses a single valid SSE chunk", async () => {
	const response = mockResponse(`data: ${JSON.stringify(validChunk)}\n\n`);
	const chunks = await collect(parseSSEStream(response));
	assertEquals(chunks.length, 1);
	assertEquals(chunks[0], validChunk);
});

Deno.test("parseSSEStream - parses multiple chunks separated by double newlines", async () => {
	const chunk2: StreamChunk = { ...validChunk, id: "2" };
	const chunk3: StreamChunk = { ...validChunk, id: "3" };
	const data = `data: ${JSON.stringify(validChunk)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: ${
		JSON.stringify(chunk3)
	}\n\n`;
	const chunks = await collect(parseSSEStream(mockResponse(data)));
	assertEquals(chunks.length, 3);
	assertEquals(chunks[0], validChunk);
	assertEquals(chunks[1], chunk2);
	assertEquals(chunks[2], chunk3);
});

Deno.test("parseSSEStream - stops at data: [DONE] and ignores data after it", async () => {
	const chunk2: StreamChunk = { ...validChunk, id: "2" };
	const data = `data: ${JSON.stringify(validChunk)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(chunk2)}\n\n`;
	const chunks = await collect(parseSSEStream(mockResponse(data)));
	assertEquals(chunks.length, 1);
	assertEquals(chunks[0], validChunk);
});

Deno.test("parseSSEStream - skips malformed JSON lines silently", async () => {
	const data = `data: {invalid json}\n\ndata: ${JSON.stringify(validChunk)}\n\ndata: not-json-at-all\n\n`;
	const chunks = await collect(parseSSEStream(mockResponse(data)));
	assertEquals(chunks.length, 1);
	assertEquals(chunks[0], validChunk);
});

Deno.test("parseSSEStream - skips empty lines and non-data lines", async () => {
	const data = `: OPENROUTER PROCESSING\n\n\n\ndata: ${JSON.stringify(validChunk)}\n\n`;
	const chunks = await collect(parseSSEStream(mockResponse(data)));
	assertEquals(chunks.length, 1);
	assertEquals(chunks[0], validChunk);
});

Deno.test("parseSSEStream - throws when response body is null", async () => {
	const response = new Response(null);
	// Force body to null by constructing a response without a body
	Object.defineProperty(response, "body", { value: null });
	await assertRejects(
		async () => {
			await collect(parseSSEStream(response));
		},
		Error,
		"Response body is not readable",
	);
});

Deno.test("parseSSEStream - handles data split across multiple reads", async () => {
	const json = JSON.stringify(validChunk);
	const fullData = `data: ${json}\n\n`;
	const splitPoint = Math.floor(fullData.length / 2);
	const part1 = fullData.slice(0, splitPoint);
	const part2 = fullData.slice(splitPoint);
	const encoder = new TextEncoder();

	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(part1));
				controller.enqueue(encoder.encode(part2));
				controller.close();
			},
		}),
	);

	const chunks = await collect(parseSSEStream(response));
	assertEquals(chunks.length, 1);
	assertEquals(chunks[0], validChunk);
});

Deno.test("parseSSEStream - handles chunk with usage data in final message", async () => {
	const chunkWithUsage: StreamChunk = {
		...validChunk,
		id: "usage",
		usage: {
			prompt_tokens: 10,
			completion_tokens: 20,
			total_tokens: 30,
		},
	};
	const data = `data: ${JSON.stringify(validChunk)}\n\ndata: ${JSON.stringify(chunkWithUsage)}\n\ndata: [DONE]\n\n`;
	const chunks = await collect(parseSSEStream(mockResponse(data)));
	assertEquals(chunks.length, 2);
	assertEquals(chunks[0], validChunk);
	assertEquals(chunks[1], chunkWithUsage);
	assertEquals(chunks[1]!.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
});
