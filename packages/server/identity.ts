import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import type { ServerServices } from "./services.ts";
import { parseCookies } from "./cookies.ts";

/** Session cookie name; the value is the opaque session token. */
export const SESSION_COOKIE = "relay_session";
/** Short-lived OAuth handshake cookies. */
export const OAUTH_STATE_COOKIE = "relay_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "relay_oauth_verifier";
export const OAUTH_RETURN_COOKIE = "relay_oauth_return";

export function sessionTtlMs(services: ServerServices): number {
	return services.config.sessionTtlDays * 24 * 60 * 60 * 1000;
}

export function readBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 ? token : null;
}

/** Session token from an `Authorization: Bearer` header or the cookie. */
export function readSessionToken(request: Request): string | null {
	return readBearerToken(request) ?? parseCookies(request.headers.get("cookie"))[SESSION_COOKIE] ?? null;
}

/** Resolve the caller from the session cookie or bearer token, if any. */
export async function resolveRequestUser(
	services: ServerServices,
	request: Request,
): Promise<AuthenticatedUser | null> {
	const token = readSessionToken(request);
	if (!token) return null;
	const session = await services.authSessions.resolve(token, sessionTtlMs(services));
	if (!session) return null;
	return await services.userStore.getById(session.userId);
}
