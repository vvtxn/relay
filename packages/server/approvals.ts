import type { ApprovalRequest, StatusResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { BadRequestError, json, NotFoundError, readJsonBody } from "./http.ts";

/** Resolves a pending tool approval for a session. */
export async function handleApprove(
	services: ServerServices,
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

	const resolved = services.runs.resolveApproval(sessionId, body.toolCallId, body.decision);
	if (!resolved) throw new NotFoundError("No pending approval for that tool call");
	return json({ status: "ok" } satisfies StatusResponse);
}

/** Aborts the active run on a session. */
export function handleCancel(services: ServerServices, sessionId: string): Response {
	services.runs.cancel(sessionId);
	// Idempotent: cancelling when nothing is running is fine
	return json({ status: "ok" } satisfies StatusResponse);
}
