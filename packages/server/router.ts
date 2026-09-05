import type { HealthResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { BadRequestError, error, NotFoundError } from "./http.ts";
import {
	handleConfig,
	handleCreateSession,
	handleListSessions,
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

/**
 * Central request handler. Routes are matched manually — no framework — so
 * the surface stays explicit and dependency-free.
 */
export async function handleRequest(services: ServerServices, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	try {
		// Health + identity
		if (method === "GET" && path === "/api/health") {
			return new Response(JSON.stringify({ status: "ok", version: VERSION } satisfies HealthResponse), {
				headers: { "Content-Type": "application/json" },
			});
		}
		if (method === "GET" && path === "/api/me") return await handleMe(services);
		if (method === "GET" && path === "/api/config") return handleConfig(services);
		if (method === "GET" && path === "/api/workspace") return handleWorkspace(services);

		// Sessions collection
		if (method === "GET" && path === "/api/sessions") return await handleListSessions(services, url);
		if (method === "POST" && path === "/api/sessions") return await handleCreateSession(services, request);

		// Session-scoped routes: /api/sessions/:id[/action]
		const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|approve|cancel|events|files))?$/);
		if (sessionMatch) {
			const [, sessionId, action] = sessionMatch;
			if (!action && method === "GET") return await handleOpenSession(services, sessionId);
			if (action === "messages" && method === "POST") {
				return await handleSendMessage(services, sessionId, request);
			}
			if (action === "approve" && method === "POST") return await handleApprove(services, sessionId, request);
			if (action === "cancel" && method === "POST") return handleCancel(services, sessionId);
			if (action === "events" && method === "GET") return await handleEvents(services, sessionId, request);
			if (action === "files" && method === "GET") return await handleListFiles(services, sessionId);
			return error(405, "Method not allowed");
		}

		// Static web app (production build) — falls through to 404 when absent
		if (method === "GET" && services.config.staticDir) {
			return await serveStatic(services.config.staticDir, path);
		}

		return error(404, "Not found");
	} catch (err) {
		if (err instanceof BadRequestError) return error(400, err.message);
		if (err instanceof NotFoundError) return error(404, err.message);
		console.error("Unhandled server error:", err);
		return error(500, err instanceof Error ? err.message : "Internal server error");
	}
}
