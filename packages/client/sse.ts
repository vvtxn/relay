/**
 * Reads a server-sent event stream from a fetch Response.
 *
 * Parses the standard `data: {json}\n\n` framing. Works in any runtime with
 * fetch + ReadableStream (Deno, browsers) — deliberately not based on
 * EventSource so the CLI can use it too.
 */
export async function* readSSEStream<T>(response: Response): AsyncIterable<T> {
	if (!response.body) throw new Error("Response body is null");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;

			buffer += decoder.decode(value, { stream: true });
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";

			for (const event of events) {
				for (const line of event.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6);
					if (payload === "[DONE]") return;
					try {
						yield JSON.parse(payload) as T;
					} catch {
						// Skip malformed payloads
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Encode a single SSE frame. Used by the server to emit events. */
export function encodeSSEFrame(data: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}
