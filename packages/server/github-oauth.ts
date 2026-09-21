import type { GitHubProfile } from "@vvtxn/relay/core/index.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
const REQUEST_TIMEOUT_MS = 10_000;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return base64Url(buffer);
}

async function sha256(input: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return new Uint8Array(digest);
}

/** PKCE verifier + S256 challenge (GitHub recommends PKCE for all flows). */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = randomToken(32);
	const challenge = base64Url(await sha256(verifier));
	return { verifier, challenge };
}

export function createState(): string {
	return randomToken(16);
}

/**
 * GitHub App user-authorization URL.
 *
 * GitHub Apps use fine-grained permissions configured on the App itself, so
 * no `scope` parameter is sent (unlike OAuth apps). PKCE is still required.
 */
export function buildAuthorizeUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
}): string {
	const params = new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		state: options.state,
		code_challenge: options.challenge,
		code_challenge_method: "S256",
	});
	return `${AUTHORIZE_URL}?${params}`;
}

/** Exchange the authorization code for a user access token. */
export async function exchangeCode(options: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
	verifier: string;
}): Promise<string> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: options.clientId,
			client_secret: options.clientSecret,
			code: options.code,
			redirect_uri: options.redirectUri,
			code_verifier: options.verifier,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const data = await response.json() as { access_token?: string; error?: string; error_description?: string };
	if (!response.ok || !data.access_token) {
		throw new Error(data.error_description ?? data.error ?? `GitHub token exchange failed (${response.status})`);
	}
	return data.access_token;
}

/** Fetch the profile, filling in the primary verified email when hidden. */
export async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "relay",
	};

	const userResponse = await fetch(USER_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!userResponse.ok) throw new Error(`GitHub user request failed (${userResponse.status})`);
	const profile = await userResponse.json() as GitHubProfile;

	if (!profile.email) {
		const emailResponse = await fetch(EMAILS_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (emailResponse.ok) {
			const emails = await emailResponse.json() as { email: string; primary: boolean; verified: boolean }[];
			const primary = emails.find((entry) => entry.primary && entry.verified) ??
				emails.find((entry) => entry.verified);
			if (primary) profile.email = primary.email;
		}
	}
	return profile;
}
