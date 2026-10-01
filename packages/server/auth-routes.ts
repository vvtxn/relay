import {
	authenticate,
	clearStoredSession,
	GitHubAuthProvider,
	type GitHubProfile,
	readStoredSession,
	writeStoredSession,
} from "@vvtxn/relay/core/index.ts";
import type { StatusResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { error, json } from "./http.ts";
import { clearCookie, isSecureOrigin, parseCookies, serializeCookie } from "./cookies.ts";
import { isLoopbackHost } from "./config.ts";
import {
	OAUTH_RETURN_COOKIE,
	OAUTH_STATE_COOKIE,
	OAUTH_VERIFIER_COOKIE,
	readSessionToken,
	SESSION_COOKIE,
	sessionTtlMs,
} from "./identity.ts";
import { buildAuthorizeUrl, createPkce, createState, exchangeCode, fetchGitHubProfile } from "./github-oauth.ts";

const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const SECONDS_PER_DAY = 86_400;

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { Location: location } });
}

function cookieOptions(services: ServerServices) {
	return {
		httpOnly: true,
		sameSite: "Lax" as const,
		secure: isSecureOrigin(services.config.publicUrl),
		path: "/",
	};
}

/**
 * Only allow same-origin relative paths as post-login destinations.
 *
 * Rejects protocol-relative (`//evil`), backslash-normalized (`/\evil`, which
 * browsers treat as `//evil`), control characters, and absurdly long values.
 */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value || value.length > 2048 || !value.startsWith("/")) return "/";
	if (value.length > 1 && (value[1] === "/" || value[1] === "\\")) return "/";
	// deno-lint-ignore no-control-regex -- reject control chars in redirect targets
	if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
	return value;
}

/** Match a GitHub profile against the allowlist of logins or numeric ids. */
export function isGithubAllowed(allowed: string[], profile: GitHubProfile): boolean {
	if (allowed.length === 0) return true;
	const id = profile.id === undefined || profile.id === null ? "" : String(profile.id);
	const login = (profile.login ?? "").toLowerCase();
	return allowed.some((entry) => entry === id || entry === login);
}

export async function handleLogin(services: ServerServices, url: URL): Promise<Response> {
	const { config } = services;
	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

	const { verifier, challenge } = await createPkce();
	const state = createState();
	const redirectUri = `${config.publicUrl}/api/auth/callback`;
	const authorizeUrl = buildAuthorizeUrl({
		clientId: config.githubClientId,
		redirectUri,
		state,
		challenge,
	});

	const response = redirect(authorizeUrl);
	const options = { ...cookieOptions(services), maxAgeSeconds: OAUTH_COOKIE_MAX_AGE_SECONDS };
	response.headers.append("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, state, options));
	response.headers.append("Set-Cookie", serializeCookie(OAUTH_VERIFIER_COOKIE, verifier, options));
	response.headers.append("Set-Cookie", serializeCookie(OAUTH_RETURN_COOKIE, returnTo, options));
	return response;
}

export async function handleCallback(services: ServerServices, request: Request, url: URL): Promise<Response> {
	const { config } = services;

	const oauthError = url.searchParams.get("error");
	if (oauthError) return error(400, url.searchParams.get("error_description") ?? oauthError);

	const cookies = parseCookies(request.headers.get("cookie"));
	const expectedState = cookies[OAUTH_STATE_COOKIE];
	const verifier = cookies[OAUTH_VERIFIER_COOKIE];
	const returnTo = safeReturnTo(cookies[OAUTH_RETURN_COOKIE]);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");

	if (!code || !state || !expectedState || state !== expectedState || !verifier) {
		return error(400, "Invalid OAuth callback");
	}

	try {
		const accessToken = await exchangeCode({
			clientId: config.githubClientId,
			clientSecret: config.githubClientSecret,
			code,
			redirectUri: `${config.publicUrl}/api/auth/callback`,
			verifier,
		});
		const profile = await fetchGitHubProfile(accessToken);
		if (!isGithubAllowed(config.allowedGithub, profile)) {
			return error(403, "GitHub account is not authorized");
		}
		const user = await authenticate(new GitHubAuthProvider(), profile, services.userStore);
		const { token } = await services.authSessions.create(user.id, sessionTtlMs(services));

		// Hand the session to the local CLI so it acts as the same user (browsers
		// and the terminal don't share cookies). Loopback-only.
		if (isLoopbackHost(config.hostname)) {
			writeStoredSession({ serverUrl: config.publicUrl, token, createdAt: new Date().toISOString() });
		}

		const response = redirect(returnTo);
		response.headers.append(
			"Set-Cookie",
			serializeCookie(SESSION_COOKIE, token, {
				...cookieOptions(services),
				maxAgeSeconds: config.sessionTtlDays * SECONDS_PER_DAY,
			}),
		);
		for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_RETURN_COOKIE]) {
			response.headers.append("Set-Cookie", clearCookie(name));
		}
		return response;
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : "GitHub authentication failed");
	}
}

export async function handleLogout(services: ServerServices, request: Request): Promise<Response> {
	const token = readSessionToken(request);
	if (token) {
		await services.authSessions.revoke(token);
		if (readStoredSession()?.token === token) clearStoredSession();
	}
	const response = json({ status: "ok" } satisfies StatusResponse);
	response.headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
	return response;
}

/** Dispatch `/api/auth/*`; returns null when the path is not an auth route. */
export async function handleAuthRoutes(
	services: ServerServices,
	request: Request,
	url: URL,
): Promise<Response | null> {
	const path = url.pathname;
	if (path === "/api/auth/login" && request.method === "GET") return await handleLogin(services, url);
	if (path === "/api/auth/callback" && request.method === "GET") {
		return await handleCallback(services, request, url);
	}
	if (path === "/api/auth/logout" && request.method === "POST") return await handleLogout(services, request);
	return null;
}
