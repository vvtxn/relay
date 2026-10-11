import type { StreamChunk } from "#/api/types.ts";

/**
 * Parses an SSE stream from a fetch Response into an async iterable of StreamChunks.
 *
 * Handles the standard OpenAI-compatible SSE format:
 *   data: {json}\n\n
 *   data: [DONE]\n\n
 */
export async function* parseSSEStream(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Response body is not readable");
	}

	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			// Keep the last potentially incomplete line in the buffer
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				if (trimmed === "data: [DONE]") return;

				if (trimmed.startsWith("data: ")) {
					const json = trimmed.slice(6);
					try {
						yield JSON.parse(json) as StreamChunk;
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
