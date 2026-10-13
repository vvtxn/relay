import { Duration, Effect, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { encodeSSEFrame } from "@vvtxn/client/sse.ts";
import type { RequestServices } from "./services.ts";
import { type NotFoundError } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

const HEARTBEAT_INTERVAL = Duration.seconds(15);

/**
 * SSE endpoint: streams ServerEvents for a session. Sends a `run_state`
 * snapshot first when a run is in progress so late subscribers catch up, then
 * live events (with heartbeats) until the client disconnects.
 */
export function handleEvents(
	services: RequestServices,
	sessionId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError> {
	return Effect.gen(function* () {
		// Verify the session exists and is owned by the user
		const handle = yield* openSessionHandle(services, sessionId);
		services.runs.attachHandle(sessionId, handle, services.user.id);

		// Immediate comment frame flushes response headers through proxies
		// (e.g. the Vite dev proxy) before the first real event arrives.
		const preamble: Uint8Array[] = [new TextEncoder().encode(": connected\n\n")];
		// Catch-up snapshot for late subscribers
		const snapshot = services.runs.getRunState(sessionId);
		if (snapshot) preamble.push(encodeSSEFrame(snapshot));

		const live = services.runs.subscribeStream(sessionId).pipe(Stream.map((event) => encodeSSEFrame(event)));
		// Heartbeats keep proxies and browsers from timing out the connection
		const heartbeats = Stream.tick(HEARTBEAT_INTERVAL).pipe(
			Stream.map(() => new TextEncoder().encode(": heartbeat\n\n")),
		);

		const body = Stream.concat(Stream.fromIterable(preamble), Stream.merge(live, heartbeats));
		return HttpServerResponse.stream(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	});
}
