import type { ApprovalRequest, StatusResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, json, NotFoundError, readJsonBody } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

/** Resolves a pending tool approval for a session. */
export async function handleApprove(
	services: RequestServices,
	sessionId: string,
	request: Request,
): Promise<Response> {
	const body = await readJsonBody<ApprovalRequest>(request);
	if (typeof body.toolCallId !== "string" || !body.toolCallId) {
		throw new BadRequestError("toolCallId is required");
	}
	if (!["allow", "always", "deny"].includes(body.decision)) {
		throw new BadRequestError("decision must be allow, always, or deny");
	}

	// Ownership check: never act on another user's session.
	await openSessionHandle(services, sessionId);

	const resolved = services.runs.resolveApproval(sessionId, body.toolCallId, body.decision);
	if (!resolved) throw new NotFoundError("No pending approval for that tool call");
	return json({ status: "ok" } satisfies StatusResponse);
}

/** Aborts the active run on a session. */
export async function handleCancel(services: RequestServices, sessionId: string): Promise<Response> {
	// Ownership check: never abort another user's run.
	await openSessionHandle(services, sessionId);
	services.runs.cancel(sessionId);
	// Idempotent: cancelling when nothing is running is fine
	return json({ status: "ok" } satisfies StatusResponse);
}
