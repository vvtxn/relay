/** Server configuration — read once from the environment at startup. */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homeDir, relayDir } from "@vvtxn/relay/core/paths.ts";
import { validateWorkspacePathSync } from "@vvtxn/relay/core/workspace.ts";

/** Deployment mode selected by `RELAY_ENV`. */
export type RelayEnv = "development" | "production";

/** Product defaults. `local` is the single-user desktop mode. */
export type RelayFlavor = "local" | "cloud";

/** Authentication transport. Local mode is loopback-only. */
export type AuthMode = "local" | "github";

/** Backend holding per-user settings (the LLM API key). */
export type SettingsStoreBackend = "file" | "database";

/** Local SQLite file or a remote Turso/libSQL database. */
export type DatabaseBackend =
	| { kind: "local"; path: string; url: string }
	| { kind: "turso"; url: string; authToken: string };

export interface ServerConfig {
	/** Deployment mode (informational; `development` by default). */
	relayEnv: RelayEnv;
	/** Product flavor. Unset means infer from the environment. */
	flavor: RelayFlavor | null;
	/** Port to listen on. */
	port: number;
	/** Hostname to bind. Localhost-only by default (single-user local server). */
	hostname: string;
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
	/** Database backend and its connection details. */
	database: DatabaseBackend;
	/** Authentication transport. */
	authMode: AuthMode;
	/** GitHub App client id (empty in local auth mode). */
	githubClientId: string;
	/** GitHub App client secret (empty in local auth mode). */
	githubClientSecret: string;
	/** Public base URL of this server, used to build the OAuth redirect URI. */
	publicUrl: string;
	/** Session lifetime in days (sliding). */
	sessionTtlDays: number;
	/** Default workspace cwd when a client doesn't specify one (server's cwd). */
	defaultCwd: string;
	/** Absolute roots a session workspace must sit within (empty = allow any). */
	workspaceRoots: string[];
	/** Maximum persisted sessions kept per owner and workspace. `0` = unlimited. */
	maxSessionsPerWorkspace: number;
	/** Allowed GitHub logins or numeric ids (empty = allow any). */
	allowedGithub: string[];
	/** Backend storing per-user API keys: local files (default) or the database. */
	settingsStore: SettingsStoreBackend;
	/** Directory for local state: settings files and the generated master key. */
	dataDir: string;
	/** Master key (base64url/hex, 32 bytes) for encrypting per-user secrets. */
	secretKey: string | null;
	/** File holding the master key; used when `secretKey` is unset. */
	secretKeyFile: string | null;
	/** Directory containing the built web app to serve statically, when present. */
	staticDir: string | null;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_MAX_SESSIONS_PER_WORKSPACE = 10;

/** Trimmed, non-empty env value. Empty values count as unset. */
function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

/** Resolve a path, expanding a leading `~` when the home directory is known. */
function expandHomePath(value: string): string {
	if (value === "~" || value.startsWith("~/")) {
		const home = homeDir();
		if (home) return resolve(home, value.slice(2));
	}
	return resolve(value);
}

/** Comma-separated list, trimmed and without empties. */
function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
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

/** Parse a non-negative integer env var. Zero is meaningful for session limits. */
function nonNegativeInt(value: string | undefined, fallback: number, name: string, max: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
		throw new Error(`${name} must be a non-negative integer <= ${max} (got "${value}")`);
	}
	return parsed;
}

/** True for hostnames that only accept local connections. */
export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/**
 * Effective product mode for health checks and client attachment. An explicit
 * flavor wins; otherwise local SQLite + local auth means local, everything else
 * is a shared/cloud deployment.
 */
export function effectiveFlavor(config: ServerConfig): RelayFlavor {
	if (config.flavor) return config.flavor;
	return config.database.kind === "local" && config.authMode === "local" ? "local" : "cloud";
}

function parseFlavor(env: Record<string, string | undefined>): RelayFlavor | null {
	const value = envValue(env, "RELAY_FLAVOR");
	if (!value) return null;
	if (value !== "local" && value !== "cloud") {
		throw new Error(`RELAY_FLAVOR must be "local" or "cloud" (got "${value}")`);
	}
	return value;
}

/**
 * Resolve the database backend. Local mode writes a SQLite file; cloud mode
 * talks to Turso. `auto` keeps existing deployments working: a configured
 * Turso URL selects remote, otherwise the local file is used.
 */
function parseDatabaseBackend(
	env: Record<string, string | undefined>,
	flavor: RelayFlavor | null,
	dataDir: string,
): DatabaseBackend {
	const configured = envValue(env, "RELAY_DB") ?? "auto";
	if (configured !== "auto" && configured !== "local" && configured !== "turso") {
		throw new Error(`RELAY_DB must be "auto", "local", or "turso" (got "${configured}")`);
	}

	const tursoUrl = envValue(env, "TURSO_DB_URL");
	const tursoToken = envValue(env, "TURSO_DB_TOKEN");
	const useTurso =
		configured === "turso" ||
		(configured === "auto" && (flavor === "cloud" || (flavor !== "local" && tursoUrl !== undefined)));

	if (useTurso) {
		if (!tursoUrl) throw new Error("TURSO_DB_URL is required when using the Turso database");
		if (!tursoToken) throw new Error("TURSO_DB_TOKEN is required when using the Turso database");
		return { kind: "turso", url: tursoUrl, authToken: tursoToken };
	}

	const rawPath = envValue(env, "RELAY_DB_PATH") ?? join(dataDir, "relay.db");
	const path = rawPath === ":memory:" ? rawPath : expandHomePath(rawPath);
	return {
		kind: "local",
		path,
		url: path === ":memory:" ? "file::memory:" : pathToFileURL(path).href,
	};
}

/**
 * Resolve the auth transport. Local auth is loopback-only; any non-loopback
 * bind must use GitHub (or an explicit future token mode).
 */
function parseAuthMode(
	env: Record<string, string | undefined>,
	flavor: RelayFlavor | null,
	hasGithubCredentials: boolean,
	hostname: string,
): AuthMode {
	const configured = envValue(env, "RELAY_AUTH") ?? "auto";
	if (configured !== "auto" && configured !== "local" && configured !== "github") {
		throw new Error(`RELAY_AUTH must be "auto", "local", or "github" (got "${configured}")`);
	}

	const useGithub =
		configured === "github" ||
		(configured === "auto" && (flavor === "cloud" || (flavor !== "local" && hasGithubCredentials)));
	if (useGithub) return "github";

	if (!isLoopbackHost(hostname)) {
		throw new Error(
			"Local auth is loopback-only. Bind RELAY_HOST=127.0.0.1 or configure GitHub auth with RELAY_AUTH=github",
		);
	}
	return "local";
}

export function serverConfigFromEnv(env: Record<string, string | undefined> = { ...process.env }): ServerConfig {
	const port = positiveInt(env.RELAY_PORT, DEFAULT_PORT, "RELAY_PORT", 65_535);
	const hostname = env.RELAY_HOST ?? DEFAULT_HOSTNAME;
	const flavor = parseFlavor(env);

	const dataDir = expandHomePath(env.RELAY_DATA_DIR ?? relayDir());
	const database = parseDatabaseBackend(env, flavor, dataDir);

	// GitHub App credentials. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are
	// accepted as fallbacks for setups configured before the App switch.
	const githubClientId = env.GITHUB_APP_CLIENT_ID ?? env.GITHUB_CLIENT_ID ?? "";
	const githubClientSecret = env.GITHUB_APP_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET ?? "";
	const hasGithubCredentials = githubClientId !== "" && githubClientSecret !== "";

	const authMode = parseAuthMode(env, flavor, hasGithubCredentials, hostname);
	if (authMode === "github" && !hasGithubCredentials) {
		throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required when GitHub auth is enabled");
	}

	const rawRoots = parseList(env.RELAY_WORKSPACE_ROOTS);
	// A workspace must sit within one of these canonical roots. `*` allows any
	// directory (empty list). Local mode allows any directory by default: the
	// agent runs as the user on their own machine, and the workspace is a scope
	// rather than a security boundary. GitHub/shared mode defaults to the
	// server user's home so a remote server cannot browse arbitrary paths.
	const defaultRoots = authMode === "local" ? [] : homeRoots();
	const workspaceRoots = rawRoots.includes("*")
		? []
		: (rawRoots.length > 0 ? rawRoots : defaultRoots).map((root) => resolve(root));
	const allowedGithub = parseList(env.AUTH_ALLOWED_GITHUB).map((entry) => entry.toLowerCase());

	// Exposing the server beyond loopback with GitHub auth requires explicit
	// allowlists, so an unrestricted agent can never be reachable by accident.
	if (authMode === "github" && !isLoopbackHost(hostname)) {
		if (allowedGithub.length === 0) {
			throw new Error("AUTH_ALLOWED_GITHUB is required when binding a non-loopback host");
		}
		if (rawRoots.length === 0) {
			throw new Error("RELAY_WORKSPACE_ROOTS is required when binding a non-loopback host");
		}
		if (rawRoots.includes("*")) {
			throw new Error("RELAY_WORKSPACE_ROOTS=* is not allowed when binding a non-loopback host");
		}
	}

	// Per-user settings: local files by default so API keys never reach the
	// database; the database backend requires an explicit master key.
	const settingsStore = env.RELAY_SETTINGS_STORE ?? "file";
	if (settingsStore !== "file" && settingsStore !== "database") {
		throw new Error(`RELAY_SETTINGS_STORE must be "file" or "database" (got "${settingsStore}")`);
	}
	const secretKey = env.RELAY_SECRET_KEY ?? null;
	const secretKeyFile = env.RELAY_SECRET_KEY_FILE ?? null;
	if (settingsStore === "database" && !secretKey && !secretKeyFile) {
		throw new Error("RELAY_SECRET_KEY (or RELAY_SECRET_KEY_FILE) is required when RELAY_SETTINGS_STORE=database");
	}

	// Canonicalize the default workspace and require it to satisfy the same
	// rules as a client-supplied path, so the server never advertises a
	// workspace it would refuse to create.
	const candidateCwd = env.RELAY_WORKSPACE ?? process.cwd();
	const defaultWorkspace = validateWorkspacePathSync(candidateCwd, workspaceRoots);
	if (!defaultWorkspace.ok) {
		throw new Error(
			`Default workspace "${candidateCwd}" is not usable: ${defaultWorkspace.message}. ` +
				`Set RELAY_WORKSPACE, or allow more roots via RELAY_WORKSPACE_ROOTS ` +
				`(use RELAY_WORKSPACE_ROOTS=* to allow any directory).`,
		);
	}

	const defaultSessionLimit = database.kind === "local" ? 0 : DEFAULT_MAX_SESSIONS_PER_WORKSPACE;

	return {
		relayEnv: env.RELAY_ENV === "production" ? "production" : "development",
		flavor,
		port,
		hostname,
		baseURL: env.LLM_BASE_URL ?? DEFAULT_BASE_URL,
		model: env.LLM_MODEL ?? DEFAULT_MODEL,
		temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
		maxTokens: Number(env.LLM_MAX_TOKENS ?? 350_000),
		preserveRecentTurns: Number(env.LLM_PRESERVE_RECENT_TURNS ?? 6),
		maxCompletionTokens: Number(env.LLM_MAX_COMPLETION_TOKENS ?? 16_384),
		database,
		authMode,
		githubClientId,
		githubClientSecret,
		publicUrl: (env.RELAY_PUBLIC_URL ?? `http://${hostname}:${port}`).replace(/\/+$/, ""),
		sessionTtlDays: positiveInt(env.AUTH_SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS, "AUTH_SESSION_TTL_DAYS", 365),
		defaultCwd: defaultWorkspace.path,
		workspaceRoots,
		maxSessionsPerWorkspace: nonNegativeInt(
			env.RELAY_MAX_SESSIONS_PER_WORKSPACE,
			defaultSessionLimit,
			"RELAY_MAX_SESSIONS_PER_WORKSPACE",
			10_000,
		),
		allowedGithub,
		settingsStore,
		dataDir,
		secretKey,
		secretKeyFile,
		staticDir: env.RELAY_STATIC_DIR ?? null,
	};
}

/** The default workspace roots: the server user's home, or none when unknown. */
function homeRoots(): string[] {
	const home = homeDir();
	return home ? [home] : [];
}
