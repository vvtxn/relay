import type { StreamChunk } from "#/api/types.ts";
import { ProviderError } from "../errors.ts";

/**
 * Parses an SSE stream from a fetch Response into an async iterable of StreamChunks.
 *
 * Handles the standard OpenAI-compatible SSE format:
 *   data: {json}\n\n
 *   data: [DONE]\n\n
 *
 * Transport failures propagate as thrown values; the provider maps them into
 * `ProviderError`s (see `providers/completions.ts`).
 */
export async function* parseSSEStream(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ProviderError({ message: "Response body is not readable", retryable: false });
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
