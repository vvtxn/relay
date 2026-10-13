import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ApprovalRequest, StatusResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, json, NotFoundError, readJsonBody } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

/** Resolves a pending tool approval for a session. */
export function handleApprove(
	services: RequestServices,
	sessionId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | NotFoundError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<ApprovalRequest>(request);
		if (typeof body.toolCallId !== "string" || !body.toolCallId) {
			return yield* Effect.fail(new BadRequestError("toolCallId is required"));
		}
		if (!["allow", "always", "deny"].includes(body.decision)) {
			return yield* Effect.fail(new BadRequestError("decision must be allow, always, or deny"));
		}

		// Ownership check: never act on another user's session.
		yield* openSessionHandle(services, sessionId);

		const resolved = services.runs.resolveApproval(sessionId, body.toolCallId, body.decision);
		if (!resolved) return yield* Effect.fail(new NotFoundError("No pending approval for that tool call"));
		return json({ status: "ok" } satisfies StatusResponse);
	});
}

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
