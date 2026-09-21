import { encodeSSEFrame } from "@vvtxn/client/sse.ts";
import type { ServerEvent } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { openSessionHandle } from "./sessions.ts";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE endpoint: streams ServerEvents for a session. Sends a `run_state`
 * snapshot first when a run is in progress so late subscribers catch up,
 * then live events until the client disconnects.
 */
export async function handleEvents(services: RequestServices, sessionId: string, request: Request): Promise<Response> {
	// Verify the session exists and is owned by the user
	const handle = await openSessionHandle(services, sessionId);
	services.runs.attachHandle(sessionId, handle, services.user.id);

	const { runs } = services;
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: ServerEvent) => {
				try {
					controller.enqueue(encodeSSEFrame(event));
				} catch {
					// Stream already closed
				}
			};

			// Immediate comment frame flushes response headers through proxies
			// (e.g. the Vite dev proxy) before the first real event arrives.
			try {
				controller.enqueue(encoder.encode(": connected\n\n"));
			} catch {
				// Stream already closed
			}

			// Catch-up snapshot for late subscribers
			const snapshot = runs.getRunState(sessionId);
			if (snapshot) send(snapshot);

			unsubscribe = runs.subscribe(sessionId, send);

			// Heartbeat keeps proxies and browsers from timing out the connection
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": heartbeat\n\n"));
				} catch {
					// Stream already closed
				}
			}, HEARTBEAT_INTERVAL_MS);

			request.signal.addEventListener("abort", () => {
				if (heartbeat) clearInterval(heartbeat);
				unsubscribe?.();
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}, { once: true });
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		},
	});
}
