import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import { resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { getGitBranch, validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import { attempt, type StoreError } from "@vvtxn/relay/core/effect.ts";
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
import { BadRequestError, error, ForbiddenError, json, NotFoundError, readJsonBody, requestUrl } from "./http.ts";
import { RunConflictError } from "./run.ts";

/**
 * Opens a session by id, falling back to the live in-memory handle for
 * sessions that were created in this process but not persisted yet (the
 * database store inserts lazily on first append).
 */
export function openSessionHandle(
	services: RequestServices,
	sessionId: string,
): Effect.Effect<SessionHandle, NotFoundError> {
	return services.sessionStore.open(sessionId, services.user.id).pipe(
		Effect.catchCause(() => {
			const handle = services.runs.getHandle(sessionId, services.user.id);
			if (handle) return Effect.succeed(handle);
			return Effect.fail(new NotFoundError(`Session not found: ${sessionId}`));
		}),
	);
}

/**
 * Resolve the workspace cwd from the query param or fall back to the server
 * default. Reads canonicalize like writes (symlinks resolved when the path
 * exists), so a client that passes a symlinked directory still matches the
 * stored workspace; a deleted directory keeps its resolved path so its
 * sessions stay listable.
 */
function resolveCwd(services: RequestServices, url: URL): Effect.Effect<string> {
	const raw = url.searchParams.get("cwd");
	if (!raw) return Effect.succeed(services.config.defaultCwd);
	const abs = resolve(raw);
	return attempt(() => realpath(abs)).pipe(Effect.catchCause(() => Effect.succeed(abs)));
}

/** True when `path` is an existing directory. */
function directoryExists(path: string): Effect.Effect<boolean> {
	return attempt(() => stat(path)).pipe(
		Effect.map((info) => info.isDirectory()),
		Effect.catchCause(() => Effect.succeed(false)),
	);
}

export function handleMe(services: RequestServices): Effect.Effect<HttpServerResponse.HttpServerResponse> {
	const { user } = services;
	return Effect.succeed(
		json({
			id: user.id,
			...(user.name && { name: user.name }),
			...(user.provider && { provider: user.provider }),
			...(user.avatarUrl && { avatarUrl: user.avatarUrl }),
		} satisfies MeResponse),
	);
}

/** Model + context info for client status displays. */
export function handleConfig(services: RequestServices): Effect.Effect<HttpServerResponse.HttpServerResponse> {
	const { config } = services;
	return Effect.succeed(
		json({
			model: config.model,
			contextTokens: config.maxTokens,
			home: homeDir() ?? "",
			webUrl: config.publicUrl,
		} satisfies ConfigResponse),
	);
}

export function handleListSessions(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError> {
	return Effect.gen(function* () {
		const cwd = yield* resolveCwd(services, requestUrl(request));
		const sessions = yield* services.sessionStore.listSummaries({ ownerId: services.user.id, cwd });
		return json({ sessions } satisfies SessionListResponse);
	});
}

/** Distinct workspaces for the user's workspace picker. */
export function handleListWorkspaces(
	services: RequestServices,
): Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError> {
	return Effect.gen(function* () {
		const summaries = yield* services.sessionStore.listWorkspaces(services.user.id);
		const byCwd = new Map(summaries.map((summary) => [summary.cwd, summary]));
		// Surface the server's default workspace only when nothing else is known,
		// so a freshly launched project has an anchor and a stale daemon cwd does
		// not linger in the picker. A hidden default stays hidden.
		if (byCwd.size === 0) {
			const hidden = yield* services.sessionStore.isWorkspaceHidden({
				ownerId: services.user.id,
				cwd: services.config.defaultCwd,
			});
			if (!hidden) {
				byCwd.set(services.config.defaultCwd, {
					cwd: services.config.defaultCwd,
					sessionCount: 0,
					lastActivity: "",
				});
			}
		}
		// Mark directories that have since been deleted/renamed so clients can flag
		// them instead of failing later.
		const workspaces = yield* Effect.forEach([...byCwd.values()], (summary) =>
			directoryExists(summary.cwd).pipe(Effect.map((exists) => ({ ...summary, exists }))),
		);
		return json({ workspaces } satisfies WorkspacesResponse);
	});
}

export function handleCreateSession(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | ForbiddenError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<CreateSessionRequest>(request);
		const raw = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : services.config.defaultCwd;
		const validation = yield* attempt(() => validateWorkspacePath(raw, services.config.workspaceRoots));
		if (!validation.ok) {
			if (validation.reason === "outside-roots") {
				return yield* Effect.fail(new ForbiddenError(validation.message));
			}
			return yield* Effect.fail(new BadRequestError(validation.message));
		}
		const scope = { ownerId: services.user.id, cwd: validation.path };
		// Register eagerly so the workspace appears in the picker before the first
		// append persists the session row.
		yield* services.sessionStore.registerWorkspace(scope);
		// Reuse an idle, never-used session instead of piling up blank ones: the
		// session is not persisted until its first message, so this check is in
		// memory. Repeated "New chat" clicks and `relay` launches land on the same
		// blank thread until something is sent.
		const empty = services.runs.findIdleEmpty(services.user.id, validation.path);
		const handle = empty ?? services.sessionStore.create(scope);
		services.runs.attachHandle(handle.getHeader().id, handle, services.user.id);
		return json({ id: handle.getHeader().id, header: handle.getHeader() } satisfies CreateSessionResponse, 201);
	});
}

export function handleOpenSession(
	services: RequestServices,
	sessionId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError> {
	return Effect.gen(function* () {
		const handle = yield* openSessionHandle(services, sessionId);
		services.runs.attachHandle(sessionId, handle, services.user.id);
		const branch = yield* attempt(() => getGitBranch(handle.getHeader().cwd)).pipe(
			Effect.catchCause(() => Effect.succeed(null)),
		);

		return json({
			header: handle.getHeader(),
			entries: handle.getEntries(),
			tokens: handle.getTokens(),
			cost: handle.getCost(),
			branch,
			running: services.runs.isRunning(sessionId),
		} satisfies OpenSessionResponse);
	});
}

export function handleSendMessage(
	services: RequestServices,
	sessionId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | NotFoundError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<SendMessageRequest>(request);
		if (typeof body.content !== "string" || !body.content.trim()) {
			return yield* Effect.fail(new BadRequestError("Message content is required"));
		}

		// Ensure the handle is open. `hasHandle` is owner-scoped, so a request from
		// another user never skips the ownership check in `openSessionHandle`.
		if (!services.runs.hasHandle(sessionId, services.user.id)) {
			services.runs.attachHandle(sessionId, yield* openSessionHandle(services, sessionId), services.user.id);
		}

		// Fail fast with a clear message rather than starting a run that can only
		// error out: a provider cannot be built without the user's API key.
		const apiKey = yield* services.userSettings
			.getApiKey(services.user.id)
			.pipe(
				Effect.catchTag("StoreError", (storeError) =>
					Effect.fail(new BadRequestError(`Stored API key could not be read: ${storeError.message}`)),
				),
			);
		if (!apiKey) {
			return error(400, "No API key configured. Add one in Settings.");
		}

		try {
			services.runs.startMessage(sessionId, body.content);
		} catch (err) {
			if (err instanceof RunConflictError) return error(409, err.message);
			throw err;
		}
		return json({ status: "started", sessionId } satisfies SendMessageResponse, 202);
	});
}
