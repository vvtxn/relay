import { Effect } from "effect";
import type { HttpServerResponse } from "effect/http";
import type { StatusResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { json, NotFoundError } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

/** Aborts the active run on a session. */
export function handleCancel(
	services: RequestServices,
	sessionId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError> {
	return Effect.gen(function* () {
		// Ownership check: never abort another user's run.
		yield* openSessionHandle(services, sessionId);
		services.runs.cancel(sessionId);
		// Idempotent: cancelling when nothing is running is fine
		return json({ status: "ok" } satisfies StatusResponse);
	});
}
