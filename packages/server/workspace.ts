import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import { isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import { attempt } from "@vvtxn/relay/core/effect.ts";
import type {
	RegisterWorkspaceRequest,
	RegisterWorkspaceResponse,
	StatusResponse,
	WorkspaceResponse,
	WorkspaceValidateResponse,
} from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, ForbiddenError, json, readJsonBody, requestUrl } from "./http.ts";

/** Returns the server's default workspace directory. */
export function handleWorkspace(services: RequestServices): Effect.Effect<HttpServerResponse.HttpServerResponse> {
	return Effect.succeed(json({ cwd: services.config.defaultCwd } satisfies WorkspaceResponse));
}

/**
 * Validates a candidate workspace path without creating or registering
 * anything. Always 200 — `ok` carries the outcome so clients can render
 * `message` verbatim.
 */
export function handleValidateWorkspace(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, Error> {
	return Effect.gen(function* () {
		const result = yield* attempt(() =>
			validateWorkspacePath(requestUrl(request).searchParams.get("cwd"), services.config.workspaceRoots),
		);
		return json({
			ok: result.ok,
			...(result.ok ? { path: result.path } : { reason: result.reason, message: result.message }),
			roots: services.config.workspaceRoots,
		} satisfies WorkspaceValidateResponse);
	});
}

/** Registers an existing, allowed workspace directory so it appears in the picker. */
export function handleRegisterWorkspace(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | ForbiddenError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<RegisterWorkspaceRequest>(request);
		const validation = yield* attempt(() => validateWorkspacePath(body.cwd, services.config.workspaceRoots));
		if (!validation.ok) {
			if (validation.reason === "outside-roots") {
				return yield* Effect.fail(new ForbiddenError(validation.message));
			}
			return yield* Effect.fail(new BadRequestError(validation.message));
		}
		yield* services.sessionStore.registerWorkspace({ ownerId: services.user.id, cwd: validation.path });
		return json(
			{
				workspace: { cwd: validation.path, sessionCount: 0, lastActivity: "", exists: true },
			} satisfies RegisterWorkspaceResponse,
			201,
		);
	});
}

/**
 * Hides a workspace registration. The directory need not still exist, so the
 * stored key is normalized but not stat'd. Sessions for the cwd are untouched
 * and stay reachable; the workspace reappears in the picker once it is
 * re-registered or a new session is created in it.
 */
export function handleUnregisterWorkspace(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const raw = requestUrl(request).searchParams.get("cwd")?.trim();
		if (!raw || !isAbsolute(raw))
			return yield* Effect.fail(new BadRequestError("An absolute cwd query parameter is required"));
		// Canonicalize like reads and writes so a symlinked path hides the same
		// workspace the sessions were stored under; a deleted directory falls
		// back to its resolved path.
		const abs = resolve(raw);
		const cwd = yield* attempt(() => realpath(abs)).pipe(Effect.catchCause(() => Effect.succeed(abs)));
		yield* services.sessionStore.unregisterWorkspace({ ownerId: services.user.id, cwd });
		return json({ status: "ok" } satisfies StatusResponse);
	});
}
