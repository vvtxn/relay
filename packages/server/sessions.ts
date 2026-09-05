import { getGitBranch } from "@vvtxn/relay/core/workspace.ts";
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	MeResponse,
	OpenSessionResponse,
	SendMessageRequest,
	SendMessageResponse,
	SessionListResponse,
} from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { BadRequestError, error, json, NotFoundError, readJsonBody } from "./http.ts";
import { RunConflictError } from "./run.ts";

/** Resolve the workspace cwd from the query param or fall back to the server default. */
function resolveCwd(services: ServerServices, url: URL): string {
	return url.searchParams.get("cwd") ?? services.config.defaultCwd;
}

export function handleMe(services: ServerServices): Response {
	const { user } = services;
	return json(
		{
			id: user.id,
			...(user.name && { name: user.name }),
			...(user.provider && { provider: user.provider }),
		} satisfies MeResponse,
	);
}

export async function handleListSessions(services: ServerServices, url: URL): Promise<Response> {
	const cwd = resolveCwd(services, url);
	const sessions = await services.sessionStore.listSummaries({ ownerId: services.user.id, cwd });
	return json({ sessions } satisfies SessionListResponse);
}

export async function handleCreateSession(services: ServerServices, request: Request): Promise<Response> {
	const body = await readJsonBody<CreateSessionRequest>(request);
	const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : services.config.defaultCwd;
	const scope = { ownerId: services.user.id, cwd };
	const handle = services.sessionStore.create(scope);
	services.runs.attachHandle(handle.getHeader().id, handle);
	return json(
		{ id: handle.getHeader().id, header: handle.getHeader() } satisfies CreateSessionResponse,
		201,
	);
}

export async function handleOpenSession(services: ServerServices, sessionId: string): Promise<Response> {
	let handle;
	try {
		handle = await services.sessionStore.open(sessionId, services.user.id);
	} catch {
		throw new NotFoundError(`Session not found: ${sessionId}`);
	}

	services.runs.attachHandle(sessionId, handle);
	const branch = await getGitBranch(handle.getHeader().cwd);

	return json(
		{
			header: handle.getHeader(),
			entries: handle.getEntries(),
			tokens: handle.getTokens(),
			cost: handle.getCost(),
			branch,
			running: services.runs.isRunning(sessionId),
		} satisfies OpenSessionResponse,
	);
}

export async function handleSendMessage(
	services: ServerServices,
	sessionId: string,
	request: Request,
): Promise<Response> {
	const body = await readJsonBody<SendMessageRequest>(request);
	if (typeof body.content !== "string" || !body.content.trim()) {
		throw new BadRequestError("Message content is required");
	}

	// Ensure the handle is open (ownership check happens in open())
	if (!services.runs.hasHandle(sessionId)) {
		try {
			const handle = await services.sessionStore.open(sessionId, services.user.id);
			services.runs.attachHandle(sessionId, handle);
		} catch {
			throw new NotFoundError(`Session not found: ${sessionId}`);
		}
	}

	try {
		services.runs.startMessage(sessionId, body.content);
	} catch (err) {
		if (err instanceof RunConflictError) return error(409, err.message);
		throw err;
	}
	return json({ status: "started", sessionId } satisfies SendMessageResponse, 202);
}
