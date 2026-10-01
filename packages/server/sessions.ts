import { getGitBranch, resolveWithinRoot } from "@vvtxn/relay/core/workspace.ts";
import { homeDir } from "@vvtxn/relay/core/paths.ts";
import type { SessionHandle } from "@vvtxn/relay/core/sessions/index.ts";
import type {
	ConfigResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	MeResponse,
	OpenSessionResponse,
	SendMessageRequest,
	SendMessageResponse,
	SessionListResponse,
	WorkspacesResponse,
} from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, error, ForbiddenError, json, NotFoundError, readJsonBody } from "./http.ts";
import { RunConflictError } from "./run.ts";

/**
 * Opens a session by id, falling back to the live in-memory handle for
 * sessions that were created in this process but not persisted yet (the
 * database store inserts lazily on first append).
 */
export async function openSessionHandle(services: RequestServices, sessionId: string): Promise<SessionHandle> {
	try {
		return await services.sessionStore.open(sessionId, services.user.id);
	} catch {
		const handle = services.runs.getHandle(sessionId, services.user.id);
		if (handle) return handle;
		throw new NotFoundError(`Session not found: ${sessionId}`);
	}
}

/** Resolve the workspace cwd from the query param or fall back to the server default. */
function resolveCwd(services: RequestServices, url: URL): string {
	return url.searchParams.get("cwd") ?? services.config.defaultCwd;
}

export function handleMe(services: RequestServices): Response {
	const { user } = services;
	return json(
		{
			id: user.id,
			...(user.name && { name: user.name }),
			...(user.provider && { provider: user.provider }),
			...(user.avatarUrl && { avatarUrl: user.avatarUrl }),
		} satisfies MeResponse,
	);
}

/** Model + context info for client status displays. */
export function handleConfig(services: RequestServices): Response {
	const { config } = services;
	return json(
		{
			model: config.model,
			contextTokens: config.maxTokens,
			home: homeDir() ?? "",
			webUrl: config.publicUrl,
		} satisfies ConfigResponse,
	);
}

export async function handleListSessions(services: RequestServices, url: URL): Promise<Response> {
	const cwd = resolveCwd(services, url);
	const sessions = await services.sessionStore.listSummaries({ ownerId: services.user.id, cwd });
	return json({ sessions } satisfies SessionListResponse);
}

/** Distinct workspaces for the user's workspace picker. */
export async function handleListWorkspaces(services: RequestServices): Promise<Response> {
	const summaries = await services.sessionStore.listWorkspaces(services.user.id);
	const byCwd = new Map(summaries.map((summary) => [summary.cwd, summary]));
	// Always surface the server's default workspace (the CLI's cwd) so a freshly
	// launched project appears before its first session.
	if (!byCwd.has(services.config.defaultCwd)) {
		byCwd.set(services.config.defaultCwd, {
			cwd: services.config.defaultCwd,
			sessionCount: 0,
			lastActivity: "",
		});
	}
	return json({ workspaces: [...byCwd.values()] } satisfies WorkspacesResponse);
}

export async function handleCreateSession(services: RequestServices, request: Request): Promise<Response> {
	const body = await readJsonBody<CreateSessionRequest>(request);
	const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : services.config.defaultCwd;
	if (services.config.workspaceRoots.length > 0) {
		const allowed = services.config.workspaceRoots.some((root) => resolveWithinRoot(root, cwd) !== null);
		if (!allowed) throw new ForbiddenError("Workspace is outside the allowed roots");
	}
	const scope = { ownerId: services.user.id, cwd };
	const handle = services.sessionStore.create(scope);
	services.runs.attachHandle(handle.getHeader().id, handle, services.user.id);
	return json(
		{ id: handle.getHeader().id, header: handle.getHeader() } satisfies CreateSessionResponse,
		201,
	);
}

export async function handleOpenSession(services: RequestServices, sessionId: string): Promise<Response> {
	const handle = await openSessionHandle(services, sessionId);

	services.runs.attachHandle(sessionId, handle, services.user.id);
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
	services: RequestServices,
	sessionId: string,
	request: Request,
): Promise<Response> {
	const body = await readJsonBody<SendMessageRequest>(request);
	if (typeof body.content !== "string" || !body.content.trim()) {
		throw new BadRequestError("Message content is required");
	}

	// Ensure the handle is open. `hasHandle` is owner-scoped, so a request from
	// another user never skips the ownership check in `openSessionHandle`.
	if (!services.runs.hasHandle(sessionId, services.user.id)) {
		services.runs.attachHandle(sessionId, await openSessionHandle(services, sessionId), services.user.id);
	}

	try {
		services.runs.startMessage(sessionId, body.content);
	} catch (err) {
		if (err instanceof RunConflictError) return error(409, err.message);
		throw err;
	}
	return json({ status: "started", sessionId } satisfies SendMessageResponse, 202);
}
