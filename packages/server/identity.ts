import { authenticate, type AuthenticatedUser, LocalAuthProvider } from "@vvtxn/relay/core/index.ts";
import type { ServerServices } from "./services.ts";
import { parseCookies } from "./cookies.ts";

/** Session cookie name; the value is the opaque session token. */
export const SESSION_COOKIE = "relay_session";
/** Header the CLI uses to authenticate in local mode. */
export const LOCAL_SUBJECT_HEADER = "x-relay-local-subject";
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

/** True when the client address is loopback (the CLI bridge is local-only). */
function isLoopback(addr: Deno.Addr | undefined): boolean {
	if (!addr || !("hostname" in addr)) return false;
	const host = addr.hostname;
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}

/**
 * Resolve the caller for a request:
 * - local mode: always the configured dev subject
 * - github mode: session cookie/bearer token, else an explicit local header
 *   when `AUTH_ALLOW_LOCAL` is enabled **and** the request is from loopback
 *   (the CLI bridge)
 */
export async function resolveRequestUser(
	services: ServerServices,
	request: Request,
	info?: Deno.ServeHandlerInfo,
): Promise<AuthenticatedUser | null> {
	if (services.config.authProvider === "local") {
		return await localUser(services, services.config.devAuthSubject ?? "local");
	}

	const token = readSessionToken(request);
	if (token) {
		const session = await services.authSessions.resolve(token, sessionTtlMs(services));
		if (session) {
			const user = await services.userStore.getById(session.userId);
			if (user) return user;
		}
	}

	if (services.config.allowLocalAuth && isLoopback(info?.remoteAddr)) {
		const subject = request.headers.get(LOCAL_SUBJECT_HEADER);
		if (subject) return await localUser(services, subject);
	}

	return null;
}

async function localUser(services: ServerServices, subject: string): Promise<AuthenticatedUser> {
	return await authenticate(new LocalAuthProvider(subject), undefined, services.userStore);
}
