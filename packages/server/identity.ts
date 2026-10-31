import { Effect, Option } from "effect";
import { Headers as HttpHeaders, type HttpServerRequest } from "effect/http";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import type { StoreError } from "@vvtxn/relay/core/effect.ts";
import type { ServerServices } from "./services.ts";

/** GitHub-mode session cookie; local mode never uses cookies. */
export const SESSION_COOKIE = "relay_cloud_session";
/** Short-lived OAuth handshake cookies. */
export const OAUTH_STATE_COOKIE = "relay_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "relay_oauth_verifier";
export const OAUTH_RETURN_COOKIE = "relay_oauth_return";

export function sessionTtlMs(services: ServerServices): number {
	return services.config.sessionTtlDays * 24 * 60 * 60 * 1000;
}

export function readBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
	const header = Option.getOrUndefined(HttpHeaders.get(request.headers, "authorization"));
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 ? token : null;
}

/** Session token from an `Authorization: Bearer` header or the cookie. */
export function readSessionToken(request: HttpServerRequest.HttpServerRequest): string | null {
	return readBearerToken(request) ?? request.cookies[SESSION_COOKIE] ?? null;
}

/** Resolve the caller from the session cookie or bearer token, if any. */
export function resolveRequestUser(
	services: ServerServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<AuthenticatedUser | null, StoreError> {
	if (services.config.authMode === "local") return Effect.succeed(services.localUser);
	const token = readSessionToken(request);
	if (!token) return Effect.succeed(null);
	return Effect.gen(function* () {
		const session = yield* services.authSessions.resolve(token, sessionTtlMs(services));
		if (!session) return null;
		return yield* services.userStore.getById(session.userId);
	});
}
