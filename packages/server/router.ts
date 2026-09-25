import type { HealthResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices, ServerServices } from "./services.ts";
import { BadRequestError, error, ForbiddenError, NotFoundError } from "./http.ts";
import { handleAuthRoutes } from "./auth-routes.ts";
import { resolveRequestUser } from "./identity.ts";
import {
	handleConfig,
	handleCreateSession,
	handleListSessions,
	handleListWorkspaces,
	handleMe,
	handleOpenSession,
	handleSendMessage,
} from "./sessions.ts";
import { handleEvents } from "./sse.ts";
import { handleListFiles } from "./files.ts";
import { handleApprove, handleCancel } from "./approvals.ts";
import { handleWorkspace } from "./workspace.ts";
import { serveStatic } from "./static.ts";

const VERSION = "0.1.0";

function health(): Response {
	return new Response(JSON.stringify({ status: "ok", version: VERSION } satisfies HealthResponse), {
		headers: { "Content-Type": "application/json" },
	});
}

function isStateChanging(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * CSRF guard for browser requests: when an `Origin` header is present it must
 * match the configured public origin or the request's own origin. The CLI and
 * curl send no `Origin`, so they are unaffected.
 */
function originAllowed(services: ServerServices, request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	let publicOrigin = "";
	try {
		publicOrigin = new URL(services.config.publicUrl).origin;
	} catch {
		publicOrigin = "";
	}
	return origin === publicOrigin || origin === new URL(request.url).origin;
}

/**
 * Central request handler. Routes are matched manually — no framework — so
 * the surface stays explicit and dependency-free.
 *
 * `/api/health` and `/api/auth/*` are public; every other API route resolves
 * the caller first and returns 401 when unauthenticated.
 */
export async function handleRequest(
	services: ServerServices,
	request: Request,
	info?: Deno.ServeHandlerInfo,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	try {
		if (path.startsWith("/api/") && isStateChanging(method) && !originAllowed(services, request)) {
			return error(403, "Cross-origin request rejected");
		}

		if (method === "GET" && path === "/api/health") return health();

		if (path.startsWith("/api/auth/")) {
			const response = await handleAuthRoutes(services, request, url);
			if (response) return response;
		}

		if (path.startsWith("/api/")) {
			const user = await resolveRequestUser(services, request, info);
			if (!user) return error(401, "Unauthorized");
			return await routeApi({ ...services, user }, request, url, path, method);
		}

		// Static web app (bundled dist or RELAY_STATIC_DIR) with SPA fallback.
		if (method === "GET") {
			return await serveStatic(services.config.staticDir, path);
		}

		return error(404, "Not found");
	} catch (err) {
		if (err instanceof BadRequestError) return error(400, err.message);
		if (err instanceof ForbiddenError) return error(403, err.message);
		if (err instanceof NotFoundError) return error(404, err.message);
		console.error("Unhandled server error:", err);
		return error(500, "Internal server error");
	}
}

async function routeApi(
	services: RequestServices,
	request: Request,
	url: URL,
	path: string,
	method: string,
): Promise<Response> {
	if (method === "GET" && path === "/api/me") return handleMe(services);
	if (method === "GET" && path === "/api/config") return handleConfig(services);
	if (method === "GET" && path === "/api/workspace") return handleWorkspace(services);
	if (method === "GET" && path === "/api/workspaces") return await handleListWorkspaces(services);

	// Sessions collection
	if (method === "GET" && path === "/api/sessions") return await handleListSessions(services, url);
	if (method === "POST" && path === "/api/sessions") return await handleCreateSession(services, request);

	// Session-scoped routes: /api/sessions/:id[/action]
	const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|approve|cancel|events|files))?$/);
	if (sessionMatch) {
		const sessionId = sessionMatch[1];
		const action = sessionMatch[2];
		if (!sessionId) return error(404, "Not found");
		if (!action && method === "GET") return await handleOpenSession(services, sessionId);
		if (action === "messages" && method === "POST") {
			return await handleSendMessage(services, sessionId, request);
		}
		if (action === "approve" && method === "POST") return await handleApprove(services, sessionId, request);
		if (action === "cancel" && method === "POST") return await handleCancel(services, sessionId);
		if (action === "events" && method === "GET") return await handleEvents(services, sessionId, request);
		if (action === "files" && method === "GET") return await handleListFiles(services, sessionId);
		return error(405, "Method not allowed");
	}

	return error(404, "Not found");
}
