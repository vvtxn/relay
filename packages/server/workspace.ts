import { isAbsolute, resolve } from "@std/path";
import { validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import type {
	RegisterWorkspaceRequest,
	RegisterWorkspaceResponse,
	StatusResponse,
	WorkspaceResponse,
	WorkspaceValidateResponse,
} from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, ForbiddenError, json, readJsonBody } from "./http.ts";

/** Returns the server's default workspace directory. */
export function handleWorkspace(services: RequestServices): Response {
	return json({ cwd: services.config.defaultCwd } satisfies WorkspaceResponse);
}

/**
 * Validates a candidate workspace path without creating or registering
 * anything. Always 200 — `ok` carries the outcome so clients can render
 * `message` verbatim.
 */
export async function handleValidateWorkspace(services: RequestServices, url: URL): Promise<Response> {
	const result = await validateWorkspacePath(url.searchParams.get("cwd"), services.config.workspaceRoots);
	return json(
		{
			ok: result.ok,
			...(result.ok ? { path: result.path } : { reason: result.reason, message: result.message }),
			roots: services.config.workspaceRoots,
		} satisfies WorkspaceValidateResponse,
	);
}

/** Registers an existing, allowed workspace directory so it appears in the picker. */
export async function handleRegisterWorkspace(services: RequestServices, request: Request): Promise<Response> {
	const body = await readJsonBody<RegisterWorkspaceRequest>(request);
	const validation = await validateWorkspacePath(body.cwd, services.config.workspaceRoots);
	if (!validation.ok) {
		if (validation.reason === "outside-roots") throw new ForbiddenError(validation.message);
		throw new BadRequestError(validation.message);
	}
	await services.sessionStore.registerWorkspace({ ownerId: services.user.id, cwd: validation.path });
	return json(
		{
			workspace: { cwd: validation.path, sessionCount: 0, lastActivity: "", exists: true },
		} satisfies RegisterWorkspaceResponse,
		201,
	);
}

/**
 * Removes a workspace registration. The directory need not still exist, so the
 * stored key is normalized but not stat'd. Sessions for the cwd are untouched.
 */
export async function handleUnregisterWorkspace(services: RequestServices, url: URL): Promise<Response> {
	const raw = url.searchParams.get("cwd")?.trim();
	if (!raw || !isAbsolute(raw)) throw new BadRequestError("An absolute cwd query parameter is required");
	await services.sessionStore.unregisterWorkspace({ ownerId: services.user.id, cwd: resolve(raw) });
	return json({ status: "ok" } satisfies StatusResponse);
}
