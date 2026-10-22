import { Duration, Effect } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import {
	authenticate,
	clearStoredSession,
	GitHubAuthProvider,
	type GitHubProfile,
	readStoredSession,
	writeStoredSession,
} from "@vvtxn/relay/core/index.ts";
import { attempt, causeMessage, type StoreError } from "@vvtxn/relay/core/effect.ts";
import type { StatusResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { error, json, requestUrl } from "./http.ts";
import { isSecureOrigin } from "./cookies.ts";
import { isLoopbackHost } from "./config.ts";
import { readSessionToken, SESSION_COOKIE, sessionTtlMs } from "./identity.ts";
import { OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "./identity.ts";
import { buildAuthorizeUrl, createPkce, createState, exchangeCode, fetchGitHubProfile } from "./github-oauth.ts";

const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const SECONDS_PER_DAY = 86_400;

function cookieOptions(services: ServerServices) {
	return {
		httpOnly: true,
		sameSite: "lax" as const,
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
	// oxlint-disable-next-line no-control-regex -- reject control chars in redirect targets
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

export function handleLogin(
	services: ServerServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, Error> {
	return Effect.gen(function* () {
		const { config } = services;
		const returnTo = safeReturnTo(requestUrl(request).searchParams.get("returnTo"));

		const { verifier, challenge } = yield* attempt(() => createPkce());
		const state = createState();
		const redirectUri = `${config.publicUrl}/api/auth/callback`;
		const authorizeUrl = buildAuthorizeUrl({
			clientId: config.githubClientId,
			redirectUri,
			state,
			challenge,
		});

		const options = { ...cookieOptions(services), maxAge: Duration.seconds(OAUTH_COOKIE_MAX_AGE_SECONDS) };
		let response = HttpServerResponse.redirect(authorizeUrl);
		response = HttpServerResponse.setCookieUnsafe(response, OAUTH_STATE_COOKIE, state, options);
		response = HttpServerResponse.setCookieUnsafe(response, OAUTH_VERIFIER_COOKIE, verifier, options);
		response = HttpServerResponse.setCookieUnsafe(response, OAUTH_RETURN_COOKIE, returnTo, options);
		return response;
	});
}

export function handleCallback(
	services: ServerServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
	const run = Effect.gen(function* () {
		const { config } = services;
		const url = requestUrl(request);

		const oauthError = url.searchParams.get("error");
		if (oauthError) return error(400, url.searchParams.get("error_description") ?? oauthError);

		const expectedState = request.cookies[OAUTH_STATE_COOKIE];
		const verifier = request.cookies[OAUTH_VERIFIER_COOKIE];
		const returnTo = safeReturnTo(request.cookies[OAUTH_RETURN_COOKIE]);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");

		if (!code || !state || !expectedState || state !== expectedState || !verifier) {
			return error(400, "Invalid OAuth callback");
		}

		const accessToken = yield* attempt(() =>
			exchangeCode({
				clientId: config.githubClientId,
				clientSecret: config.githubClientSecret,
				code,
				redirectUri: `${config.publicUrl}/api/auth/callback`,
				verifier,
			}),
		);
		const profile = yield* attempt(() => fetchGitHubProfile(accessToken));
		if (!isGithubAllowed(config.allowedGithub, profile)) {
			return error(403, "GitHub account is not authorized");
		}
		const user = yield* authenticate(new GitHubAuthProvider(), profile, services.userStore);
		const { token } = yield* services.authSessions.create(user.id, sessionTtlMs(services));

		// Hand the session to the local CLI so it acts as the same user (browsers
		// and the terminal don't share cookies). Loopback-only.
		if (isLoopbackHost(config.hostname)) {
			writeStoredSession({ serverUrl: config.publicUrl, token, createdAt: new Date().toISOString() });
		}

		let response = HttpServerResponse.redirect(returnTo);
		response = HttpServerResponse.setCookieUnsafe(response, SESSION_COOKIE, token, {
			...cookieOptions(services),
			maxAge: Duration.seconds(config.sessionTtlDays * SECONDS_PER_DAY),
		});
		response = HttpServerResponse.expireCookieUnsafe(response, OAUTH_STATE_COOKIE, cookieOptions(services));
		response = HttpServerResponse.expireCookieUnsafe(response, OAUTH_VERIFIER_COOKIE, cookieOptions(services));
		response = HttpServerResponse.expireCookieUnsafe(response, OAUTH_RETURN_COOKIE, cookieOptions(services));
		return response;
	});

	return run.pipe(
		Effect.catchCause((cause) => Effect.succeed(error(400, causeMessage(cause) || "GitHub authentication failed"))),
	);
}

export function handleLogout(
	services: ServerServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError> {
	return Effect.gen(function* () {
		const token = readSessionToken(request);
		if (token) {
			yield* services.authSessions.revoke(token);
			if (readStoredSession()?.token === token) clearStoredSession();
		}
		const response = json({ status: "ok" } satisfies StatusResponse);
		return HttpServerResponse.expireCookieUnsafe(response, SESSION_COOKIE, cookieOptions(services));
	});
}
