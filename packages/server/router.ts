import { Cause, Effect, Layer, Option } from "effect";
import {
	Etag,
	Headers as HttpHeaders,
	HttpRouter,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
	HttpStaticServer,
} from "effect/http";
import { fileURLToPath } from "node:url";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VERSION } from "@vvtxn/relay/version.ts";
import { causeMessage } from "@vvtxn/relay/core/effect.ts";
import type { HealthResponse } from "@vvtxn/client/protocol.ts";
import { handleCallback, handleLogin, handleLogout } from "./auth-routes.ts";
import { resolveRequestUser } from "./identity.ts";
import {
	BadRequestError,
	error,
	ForbiddenError,
	json,
	NotFoundError,
	PayloadTooLargeError,
	requestUrl,
	UnauthorizedError,
} from "./http.ts";
import type { RequestServices, ServerServices } from "./services.ts";
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
import {
	handleRegisterWorkspace,
	handleUnregisterWorkspace,
	handleValidateWorkspace,
	handleWorkspace,
} from "./workspace.ts";
import { handleGetSettings, handleSetApiKey } from "./settings.ts";
import { isLoopbackHost } from "./config.ts";

/** Route handlers may read the request service (and matched route context). */
type RouteEffect = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	unknown,
	HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
>;

/** Maps typed handler errors to status codes; anything else is a 500. */
function respond(effect: RouteEffect) {
	return effect.pipe(
		Effect.catchCause((cause) => {
			const failure = Cause.findErrorOption(cause);
			if (Option.isSome(failure)) {
				const err = failure.value;
				if (err instanceof UnauthorizedError) return Effect.succeed(error(401, err.message));
				if (err instanceof BadRequestError) return Effect.succeed(error(400, err.message));
				if (err instanceof ForbiddenError) return Effect.succeed(error(403, err.message));
				if (err instanceof NotFoundError) return Effect.succeed(error(404, err.message));
				if (err instanceof PayloadTooLargeError) return Effect.succeed(error(413, err.message));
			}
			return Effect.sync(() => {
				console.error("Unhandled server error:", causeMessage(cause));
				return error(500, "Internal server error");
			});
		}),
	);
}

function health(): HttpServerResponse.HttpServerResponse {
	return json({ status: "ok", version: VERSION } satisfies HealthResponse);
}

function isStateChanging(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * CSRF guard for browser requests: when an `Origin` header is present it must
 * match the configured public origin or the request's own origin. The CLI and
 * curl send no `Origin`, so they are unaffected.
 */
function originAllowed(services: ServerServices, request: HttpServerRequest.HttpServerRequest): boolean {
	const origin = Option.getOrUndefined(HttpHeaders.get(request.headers, "origin"));
	if (!origin) return true;
	let publicOrigin = "";
	try {
		publicOrigin = new URL(services.config.publicUrl).origin;
	} catch {
		publicOrigin = "";
	}
	return origin === publicOrigin || origin === requestUrl(request).origin;
}

/** Rejects cross-origin state-changing requests (all routes here live under /api). */
function withCsrf(services: ServerServices, effect: RouteEffect): RouteEffect {
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (isStateChanging(request.method) && !originAllowed(services, request)) {
			return error(403, "Cross-origin request rejected");
		}
		return yield* effect;
	});
}

/** Resolves the caller for this request (401 when unauthenticated) and runs the handler. */
function authenticated(services: ServerServices, build: (services: RequestServices) => RouteEffect): RouteEffect {
	return withCsrf(
		services,
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			// Local auth has no token; restrict it to loopback so a DNS-rebinding
			// page cannot drive the agent through 127.0.0.1.
			if (services.config.authMode === "local" && !isLoopbackHost(requestUrl(request).hostname)) {
				return error(403, "Local mode only accepts loopback requests");
			}
			const user = yield* resolveRequestUser(services, request);
			if (!user) return error(401, "Unauthorized");
			return yield* build({ ...services, user });
		}),
	);
}

/** Binds a handler that reads the current request. */
function withRequest<E>(
	build: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest> {
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		return yield* build(request);
	});
}

/** Reads the current route's `:id` path parameter. */
function withSessionId<E>(
	build: (id: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest>,
) {
	return Effect.gen(function* () {
		const params = yield* HttpRouter.params;
		const id = params.id ?? "";
		if (!id) return error(404, "Not found");
		return yield* build(id);
	});
}

/** The static root: an explicit override, or the built web app next to the source. */
function staticRoot(services: ServerServices): string {
	return services.config.staticDir ?? fileURLToPath(new URL("../web/dist/", import.meta.url));
}

/**
 * `HttpStaticServer` reports a miss as `RouteNotFound` (so an enclosing router
 * can fall through); standing alone it means a plain 404.
 */
function isRouteNotFound(error: unknown): boolean {
	return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound";
}

const platformLive = Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer);

/**
 * Builds the HTTP application: routes, auth gate, CSRF guard, error mapping,
 * and the static SPA fallback for non-API GET requests.
 *
 * Composed as a Layer so the same definition serves production
 * (`HttpRouter.serve`) and in-process tests (`HttpRouter.toWebHandler`).
 */
export function createAppLayer(services: ServerServices) {
	return HttpRouter.use((router) =>
		Effect.gen(function* () {
			const staticApp = yield* HttpStaticServer.make({
				root: staticRoot(services),
				index: "index.html",
				spa: true,
			});

			// Health is always public. OAuth routes only exist in GitHub mode;
			// local auth has no login or logout.
			yield* router.add("GET", "/api/health", respond(Effect.succeed(health())));
			if (services.config.authMode === "github") {
				yield* router.add(
					"GET",
					"/api/auth/login",
					respond(
						withCsrf(
							services,
							withRequest((request) => handleLogin(services, request)),
						),
					),
				);
				yield* router.add(
					"GET",
					"/api/auth/callback",
					respond(
						withCsrf(
							services,
							withRequest((request) => handleCallback(services, request)),
						),
					),
				);
				yield* router.add(
					"POST",
					"/api/auth/logout",
					respond(
						withCsrf(
							services,
							withRequest((request) => handleLogout(services, request)),
						),
					),
				);
			}

			// Account and settings
			yield* router.add("GET", "/api/me", respond(authenticated(services, (rs) => handleMe(rs))));
			yield* router.add("GET", "/api/config", respond(authenticated(services, (rs) => handleConfig(rs))));
			yield* router.add("GET", "/api/settings", respond(authenticated(services, (rs) => handleGetSettings(rs))));
			yield* router.add(
				"PUT",
				"/api/settings/api-key",
				respond(authenticated(services, (rs) => withRequest((request) => handleSetApiKey(rs, request)))),
			);

			// Workspaces
			yield* router.add("GET", "/api/workspace", respond(authenticated(services, (rs) => handleWorkspace(rs))));
			yield* router.add(
				"GET",
				"/api/workspaces",
				respond(authenticated(services, (rs) => handleListWorkspaces(rs))),
			);
			yield* router.add(
				"GET",
				"/api/workspaces/validate",
				respond(
					authenticated(services, (rs) => withRequest((request) => handleValidateWorkspace(rs, request))),
				),
			);
			yield* router.add(
				"POST",
				"/api/workspaces",
				respond(
					authenticated(services, (rs) => withRequest((request) => handleRegisterWorkspace(rs, request))),
				),
			);
			yield* router.add(
				"DELETE",
				"/api/workspaces",
				respond(
					authenticated(services, (rs) => withRequest((request) => handleUnregisterWorkspace(rs, request))),
				),
			);

			// Sessions
			yield* router.add(
				"GET",
				"/api/sessions",
				respond(authenticated(services, (rs) => withRequest((request) => handleListSessions(rs, request)))),
			);
			yield* router.add(
				"POST",
				"/api/sessions",
				respond(authenticated(services, (rs) => withRequest((request) => handleCreateSession(rs, request)))),
			);
			yield* router.add(
				"GET",
				"/api/sessions/:id",
				respond(authenticated(services, (rs) => withSessionId((id) => handleOpenSession(rs, id)))),
			);
			yield* router.add(
				"POST",
				"/api/sessions/:id/messages",
				respond(
					authenticated(services, (rs) =>
						withSessionId((id) => withRequest((request) => handleSendMessage(rs, id, request))),
					),
				),
			);
			yield* router.add(
				"POST",
				"/api/sessions/:id/approve",
				respond(
					authenticated(services, (rs) =>
						withSessionId((id) => withRequest((request) => handleApprove(rs, id, request))),
					),
				),
			);
			yield* router.add(
				"POST",
				"/api/sessions/:id/cancel",
				respond(authenticated(services, (rs) => withSessionId((id) => handleCancel(rs, id)))),
			);
			yield* router.add(
				"GET",
				"/api/sessions/:id/events",
				respond(authenticated(services, (rs) => withSessionId((id) => handleEvents(rs, id)))),
			);
			yield* router.add(
				"GET",
				"/api/sessions/:id/files",
				respond(authenticated(services, (rs) => withSessionId((id) => handleListFiles(rs, id)))),
			);

			// Everything else: API fallbacks (JSON 404/405) and the static SPA for
			// non-API GET requests.
			yield* router.add(
				"*",
				"/*",
				respond(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const url = requestUrl(request);
						if (url.pathname.startsWith("/api/")) {
							// The old central dispatcher checked CSRF before routing, so
							// unknown state-changing API paths need it too.
							if (isStateChanging(request.method) && !originAllowed(services, request)) {
								return error(403, "Cross-origin request rejected");
							}
							const sessionMatch = url.pathname.match(
								/^\/api\/sessions\/([^/]+)(?:\/(messages|approve|cancel|events|files))?$/,
							);
							if (sessionMatch) return error(405, "Method not allowed");
							return error(404, "Not found");
						}
						if (request.method === "GET") {
							return yield* staticApp.pipe(
								Effect.catchIf(isRouteNotFound, () => Effect.succeed(error(404, "Not found"))),
							);
						}
						return error(404, "Not found");
					}),
				),
			);
		}),
	);
}

// ---------------------------------------------------------------------------
// In-process adapter (tests and internal callers)
// ---------------------------------------------------------------------------

type WebHandler = (request: Request) => Promise<Response>;

const webHandlers = new WeakMap<ServerServices, WebHandler>();

/**
 * Runs a request through the app without binding a socket — the shape the
 * characterization tests and `mod.ts` consumers use. The web handler is built
 * once per services instance.
 */
export async function handleRequest(services: ServerServices, request: Request): Promise<Response> {
	let handler = webHandlers.get(services);
	if (!handler) {
		const app = createAppLayer(services).pipe(Layer.provide(platformLive));
		handler = HttpRouter.toWebHandler(app, { disableLogger: true }).handler;
		webHandlers.set(services, handler);
	}
	return await handler(request);
}
