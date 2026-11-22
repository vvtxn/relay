/**
 * Subscription OAuth flows (Claude Pro/Max and ChatGPT plans).
 *
 * These are the same public-client PKCE flows used by Claude Code and the
 * OpenAI Codex CLI. Relay never asks for a password: the user signs in on the
 * provider's site, and the resulting tokens are stored encrypted per user.
 *
 * Claude uses a paste flow (its registered redirect is a code-display page);
 * ChatGPT uses a loopback redirect on `localhost:1455`, matching the Codex
 * client registration.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredential } from "@vvtxn/relay/core/auth/settings.ts";

export type OAuthProvider = "anthropic" | "openai";

export const CLAUDE_PRESET_ID = "claude";
export const CHATGPT_PRESET_ID = "chatgpt";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d852e766";
const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_SCOPES = "user:profile user:inference";

const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CHATGPT_SCOPES = "openid profile email offline_access";
const CHATGPT_CALLBACK_PORT = 1455;

export interface PendingOAuth {
	userId: string;
	provider: OAuthProvider;
	verifier: string;
	state: string;
	redirectUri: string;
	createdAt: number;
}

const PENDING_TTL_MS = 15 * 60_000;
const pending = new Map<string, PendingOAuth>();

export interface OAuthStart {
	url: string;
	flow: "paste" | "redirect";
	instructions?: string;
}

/** Creates a PKCE verifier/challenge pair and a random state token. */
function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function stateToken(): string {
	return randomBytes(24).toString("hex");
}

function pruned(): void {
	const now = Date.now();
	for (const [state, entry] of pending) {
		if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(state);
	}
}

function presetFor(provider: OAuthProvider): string {
	return provider === "anthropic" ? CLAUDE_PRESET_ID : CHATGPT_PRESET_ID;
}

export function oauthPresetId(provider: OAuthProvider): string {
	return presetFor(provider);
}

/** Builds the provider authorize URL and remembers the PKCE verifier. */
export function beginOAuth(provider: OAuthProvider, userId: string): OAuthStart {
	pruned();
	const { verifier, challenge } = pkce();
	const state = stateToken();
	const redirectUri = provider === "anthropic" ? CLAUDE_REDIRECT_URI : CHATGPT_REDIRECT_URI;
	pending.set(state, { userId, provider, verifier, state, redirectUri, createdAt: Date.now() });

	if (provider === "anthropic") {
		const params = new URLSearchParams({
			code: "true",
			client_id: CLAUDE_CLIENT_ID,
			response_type: "code",
			redirect_uri: CLAUDE_REDIRECT_URI,
			scope: CLAUDE_SCOPES,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		return {
			url: `${CLAUDE_AUTH_URL}?${params.toString()}`,
			flow: "paste",
			instructions:
				"Sign in, approve access, then paste the code shown by Anthropic (it looks like `code#state`).",
		};
	}

	const params = new URLSearchParams({
		response_type: "code",
		client_id: CHATGPT_CLIENT_ID,
		redirect_uri: CHATGPT_REDIRECT_URI,
		scope: CHATGPT_SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
	});
	return {
		url: `${CHATGPT_AUTH_URL}?${params.toString()}`,
		flow: "redirect",
		instructions: "Sign in in the browser tab. This window finishes the connection automatically.",
	};
}

/** Removes and returns a pending flow; values are single-use. */
export function takePendingOAuth(state: string): PendingOAuth | null {
	pruned();
	const entry = pending.get(state);
	if (!entry) return null;
	pending.delete(state);
	return entry;
}

/** Resolves the provider's preset id for a completed credential. */
export function presetForProvider(provider: OAuthProvider): string {
	return presetFor(provider);
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
	error?: unknown;
	error_description?: unknown;
}

async function readJson(response: Response): Promise<TokenResponse> {
	const text = await response.text().catch(() => "");
	if (!response.ok) {
		let detail = text;
		try {
			const body = JSON.parse(text) as TokenResponse;
			if (typeof body.error_description === "string") detail = body.error_description;
			else if (typeof body.error === "string") detail = body.error;
		} catch {
			// Keep the raw body.
		}
		throw new Error(`Sign-in failed (${response.status}): ${detail || response.statusText}`);
	}
	try {
		return JSON.parse(text) as TokenResponse;
	} catch {
		throw new Error("The provider returned an unreadable token response");
	}
}

/** Decodes a JWT payload without verifying it (used only for account metadata). */
function jwtClaims(token: unknown): Record<string, unknown> | null {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length < 2 || !parts[1]) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function chatgptAccountId(idToken: unknown): string | null {
	const claims = jwtClaims(idToken);
	const auth = claims?.["https://api.openai.com/auth"];
	if (typeof auth !== "object" || auth === null) return null;
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" ? accountId : null;
}

function credentialFromToken(provider: OAuthProvider, json: TokenResponse): OAuthCredential {
	if (typeof json.access_token !== "string" || json.access_token.length === 0) {
		throw new Error("The provider did not return an access token");
	}
	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;
	return {
		kind: "oauth",
		accessToken: json.access_token,
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
		expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
		accountId: provider === "openai" ? chatgptAccountId(json.id_token) : null,
	};
}

/** Exchanges an authorization code for tokens. */
export async function exchangeOAuthCode(flow: PendingOAuth, rawCode: string): Promise<OAuthCredential> {
	// The Claude callback page shows `code#state`; accept the plain code too.
	const [code, returnedState] = rawCode.trim().split("#");
	if (!code) throw new Error("Enter the code shown by the provider");
	if (returnedState && returnedState !== flow.state) {
		throw new Error("The authorization code does not belong to this sign-in attempt");
	}

	if (flow.provider === "anthropic") {
		const response = await fetch(CLAUDE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: CLAUDE_CLIENT_ID,
				code,
				state: flow.state,
				redirect_uri: flow.redirectUri,
				code_verifier: flow.verifier,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		return credentialFromToken(flow.provider, await readJson(response));
	}

	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: CHATGPT_CLIENT_ID,
		code,
		redirect_uri: flow.redirectUri,
		code_verifier: flow.verifier,
	});
	const response = await fetch(CHATGPT_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
		signal: AbortSignal.timeout(30_000),
	});
	return credentialFromToken(flow.provider, await readJson(response));
}

/** Refreshes an expired access token, preserving the refresh token. */
export async function refreshOAuthCredential(
	provider: OAuthProvider,
	credential: OAuthCredential,
): Promise<OAuthCredential> {
	if (!credential.refreshToken) throw new Error("The subscription sign-in has expired; reconnect it in Settings");

	if (provider === "anthropic") {
		const response = await fetch(CLAUDE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: CLAUDE_CLIENT_ID,
				refresh_token: credential.refreshToken,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const json = await readJson(response);
		return {
			...credentialFromToken(provider, json),
			refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : credential.refreshToken,
			accountId: credential.accountId,
		};
	}

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: CHATGPT_CLIENT_ID,
		refresh_token: credential.refreshToken,
		scope: "openid profile email",
	});
	const response = await fetch(CHATGPT_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
		signal: AbortSignal.timeout(30_000),
	});
	const json = await readJson(response);
	const refreshed = credentialFromToken(provider, json);
	return {
		...refreshed,
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : credential.refreshToken,
		accountId: refreshed.accountId ?? credential.accountId,
	};
}

/**
 * Starts the one-shot loopback listener used by the ChatGPT flow. The listener
 * closes after the first callback (success or failure) and after a timeout.
 * Starting a new sign-in closes any listener left over from an abandoned one.
 */
let activeLoopback: Server | null = null;

export function startChatGptLoopback(
	state: string,
	onCode: (code: string) => Promise<void>,
	onError: (message: string) => void,
): Promise<Server> {
	if (activeLoopback) {
		activeLoopback.close();
		activeLoopback = null;
	}
	return new Promise((resolve, reject) => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://localhost:${CHATGPT_CALLBACK_PORT}`);
			if (url.pathname !== "/auth/callback") {
				response.writeHead(404).end("Not found");
				return;
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			const returnedState = url.searchParams.get("state");
			const finish = (title: string, message: string): void => {
				response
					.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
					.end(
						`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
							`<body style="font-family:system-ui;max-width:40rem;margin:15vh auto;padding:0 1.5rem">` +
							`<h1>${title}</h1><p>${message}</p><p>You can close this tab.</p></body>`,
					);
			};
			const close = (): void => {
				server.close();
			};
			if (error) {
				onError(`Sign-in was cancelled or failed: ${error}`);
				finish("Sign-in failed", "Relay could not connect your ChatGPT subscription.");
				close();
				return;
			}
			if (!code || returnedState !== state) {
				onError("The provider returned an invalid sign-in callback.");
				finish("Sign-in failed", "The callback did not include a valid authorization code.");
				close();
				return;
			}
			onCode(code)
				.then(() => finish("Connected", "Your ChatGPT subscription is now connected to Relay."))
				.catch((cause: unknown) => {
					onError(cause instanceof Error ? cause.message : String(cause));
					finish("Sign-in failed", "Relay could not complete the connection. Check the app for details.");
				})
				.finally(close);
		});
		server.on("error", (error) => reject(error));
		server.on("close", () => {
			if (activeLoopback === server) activeLoopback = null;
		});
		server.listen(CHATGPT_CALLBACK_PORT, "localhost", () => {
			activeLoopback = server;
			const timer = setTimeout(() => {
				server.close();
				onError("The ChatGPT sign-in timed out. Try connecting again.");
			}, PENDING_TTL_MS);
			timer.unref();
			resolve(server);
		});
	});
}
