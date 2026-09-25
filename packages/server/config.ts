/** Server configuration — read once from the environment at startup. */

import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";
import { relayDir } from "@vvtxn/relay/core/paths.ts";

/** How callers are authenticated. */
export type AuthProviderKind = "local" | "github";

/** Deployment mode selected by `RELAY_ENV`. */
export type RelayEnv = "development" | "production";

export interface ServerConfig {
	/** Deployment mode (informational; `development` by default). */
	relayEnv: RelayEnv;
	/** Port to listen on. */
	port: number;
	/** Hostname to bind. Localhost-only by default (single-user local server). */
	hostname: string;
	/** API key for the LLM provider. */
	apiKey: string;
	/** Base URL for the LLM provider. */
	baseURL: string;
	/** Model passed to the provider. */
	model: string;
	/** Sampling temperature. */
	temperature: number;
	/** Context window budget for trimming. */
	maxTokens: number;
	/** Turns to preserve when trimming context. */
	preserveRecentTurns: number;
	/** Max completion tokens per LLM message. */
	maxCompletionTokens: number;
	/** Turso database URL. */
	tursoUrl: string;
	/** Turso database auth token. */
	tursoToken: string;
	/** Authentication mode. */
	authProvider: AuthProviderKind;
	/** Local development auth subject (required when authProvider is "local"). */
	devAuthSubject: string | null;
	/** GitHub App client id (required when authProvider is "github"). */
	githubClientId: string | null;
	/** GitHub App client secret (required when authProvider is "github"). */
	githubClientSecret: string | null;
	/** Public base URL of this server, used to build the OAuth redirect URI. */
	publicUrl: string;
	/** Session lifetime in days (sliding). */
	sessionTtlDays: number;
	/** Allow CLI/local requests to authenticate with a local subject header. */
	allowLocalAuth: boolean;
	/** Default workspace cwd when a client doesn't specify one (server's cwd). */
	defaultCwd: string;
	/** Absolute roots a session workspace must sit within (empty = allow any). */
	workspaceRoots: string[];
	/** Allowed GitHub logins or numeric ids (empty = allow any). */
	allowedGithub: string[];
	/** Directory containing the built web app to serve statically, when present. */
	staticDir: string | null;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "moonshotai/kimi-k2.6";
const DEFAULT_SESSION_TTL_DAYS = 30;

function required(env: Record<string, string | undefined>, key: string): string {
	const value = env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
}

function parseAuthProvider(value: string | undefined): AuthProviderKind {
	if (!value) return "local";
	if (value === "local" || value === "github") return value;
	throw new Error(`AUTH_PROVIDER must be "local" or "github" (got "${value}")`);
}

/** Comma-separated list, trimmed and without empties. */
function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Parse a positive integer env var, throwing on malformed values. */
function positiveInt(value: string | undefined, fallback: number, name: string, max: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
		throw new Error(`${name} must be a positive integer <= ${max} (got "${value}")`);
	}
	return parsed;
}

/** True for hostnames that only accept local connections. */
export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/** Reads the API key from the CLI's auth file (~/.relay/auth.json). Returns null when absent. */
function readApiKeyFromAuthFile(): string | null {
	try {
		const raw = Deno.readTextFileSync(join(relayDir(), "auth.json"));
		const parsed = JSON.parse(raw) as { apiKey?: unknown };
		return typeof parsed.apiKey === "string" && parsed.apiKey.length > 0 ? parsed.apiKey : null;
	} catch {
		return null;
	}
}

function resolveApiKey(env: Record<string, string | undefined>, readApiKey: () => string | null): string {
	const fromEnv = env.LLM_API_KEY;
	if (fromEnv) return fromEnv;
	const fromFile = readApiKey();
	if (fromFile) return fromFile;
	throw new Error("LLM_API_KEY is required (or run the CLI once to create ~/.relay/auth.json)");
}

export function serverConfigFromEnv(
	env: Record<string, string | undefined> = Deno.env.toObject(),
	readApiKey: () => string | null = readApiKeyFromAuthFile,
): ServerConfig {
	const port = positiveInt(env.RELAY_PORT, DEFAULT_PORT, "RELAY_PORT", 65_535);
	const hostname = env.RELAY_HOST ?? DEFAULT_HOSTNAME;
	const authProvider = parseAuthProvider(env.AUTH_PROVIDER);
	const devAuthSubject = env.DEV_AUTH_SUBJECT ?? null;
	// GitHub App credentials. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are
	// accepted as fallbacks for setups configured before the App switch.
	const githubClientId = env.GITHUB_APP_CLIENT_ID ?? env.GITHUB_CLIENT_ID ?? null;
	const githubClientSecret = env.GITHUB_APP_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET ?? null;
	const workspaceRoots = parseList(env.RELAY_WORKSPACE_ROOTS).map((root) => resolve(root));
	const allowedGithub = parseList(env.AUTH_ALLOWED_GITHUB).map((entry) => entry.toLowerCase());

	if (authProvider === "local" && !devAuthSubject) {
		throw new Error("DEV_AUTH_SUBJECT is required when AUTH_PROVIDER=local");
	}
	if (authProvider === "github") {
		if (!githubClientId) throw new Error("GITHUB_APP_CLIENT_ID is required when AUTH_PROVIDER=github");
		if (!githubClientSecret) throw new Error("GITHUB_APP_CLIENT_SECRET is required when AUTH_PROVIDER=github");
		// Exposing the server beyond loopback requires explicit allowlists, so an
		// unrestricted agent can never be reachable by accident.
		if (!isLoopbackHost(hostname)) {
			if (allowedGithub.length === 0) {
				throw new Error(
					"AUTH_ALLOWED_GITHUB is required when AUTH_PROVIDER=github binds a non-loopback host",
				);
			}
			if (workspaceRoots.length === 0) {
				throw new Error(
					"RELAY_WORKSPACE_ROOTS is required when AUTH_PROVIDER=github binds a non-loopback host",
				);
			}
		}
	}

	return {
		relayEnv: env.RELAY_ENV === "production" ? "production" : "development",
		port,
		hostname,
		apiKey: resolveApiKey(env, readApiKey),
		baseURL: env.LLM_BASE_URL ?? DEFAULT_BASE_URL,
		model: env.LLM_MODEL ?? DEFAULT_MODEL,
		temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
		maxTokens: Number(env.LLM_MAX_TOKENS ?? 350_000),
		preserveRecentTurns: Number(env.LLM_PRESERVE_RECENT_TURNS ?? 6),
		maxCompletionTokens: Number(env.LLM_MAX_COMPLETION_TOKENS ?? 16_384),
		tursoUrl: required(env, "TURSO_DB_URL"),
		tursoToken: required(env, "TURSO_DB_TOKEN"),
		authProvider,
		devAuthSubject,
		githubClientId,
		githubClientSecret,
		publicUrl: (env.RELAY_PUBLIC_URL ?? `http://${hostname}:${port}`).replace(/\/+$/, ""),
		sessionTtlDays: positiveInt(env.AUTH_SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS, "AUTH_SESSION_TTL_DAYS", 365),
		allowLocalAuth: env.AUTH_ALLOW_LOCAL ? env.AUTH_ALLOW_LOCAL === "true" : authProvider === "local",
		defaultCwd: env.RELAY_WORKSPACE ?? Deno.cwd(),
		workspaceRoots,
		allowedGithub,
		staticDir: env.RELAY_STATIC_DIR ?? null,
	};
}
