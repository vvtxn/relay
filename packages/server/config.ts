/** Server configuration — read once from the environment at startup. */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homeDir, relayDir } from "@vvtxn/relay/core/paths.ts";
import { validateWorkspacePathSync } from "@vvtxn/relay/core/workspace.ts";
import { isBoxProfile, profileRank, profileResources } from "@vvtxn/box/profiles.ts";
import type { BoxManagerConfig, BoxProfile } from "@vvtxn/box/types.ts";

/** Product mode. Cloud is the primary deployment; local is the self-hosted desktop mode. */
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
	/** Product mode. */
	flavor: RelayFlavor;
	/** Port to listen on. */
	port: number;
	/** Hostname to bind. Localhost-only by default. */
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
	/** GitHub App client id (empty in local mode). */
	githubClientId: string;
	/** GitHub App client secret (empty in local mode). */
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
	/** Isolated box runtime configuration. Disabled by default. */
	box: BoxManagerConfig;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_CLOUD_SESSION_LIMIT = 10;

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

/** Parse a boolean env var, throwing on malformed values. */
function booleanEnv(value: string | undefined, fallback: boolean, name: string): boolean {
	if (value === undefined || value === "") return fallback;
	const normalized = value.toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`${name} must be a boolean (got "${value}")`);
}

function boxProfileEnv(value: string | undefined, fallback: BoxProfile, name: string): BoxProfile {
	if (value === undefined || value === "") return fallback;
	if (!isBoxProfile(value)) {
		throw new Error(`${name} must be "tiny", "small", or "medium" (got "${value}")`);
	}
	return value;
}

function boxConfigFromEnv(env: Record<string, string | undefined>): BoxManagerConfig {
	const dataDir = expandHomePath(env.RELAY_BOX_DATA_DIR ?? join(relayDir(), "boxes"));
	const cacheDir = expandHomePath(env.RELAY_BOX_CACHE_DIR ?? join(relayDir(), "box-cache"));
	const setup = env.RELAY_BOX_SETUP?.trim();
	const resume = env.RELAY_BOX_RESUME?.trim();
	// `small` is the default ceiling so every selectable profile fits the
	// default memory budget. Raise both to enable `medium`.
	const maxProfile = boxProfileEnv(env.RELAY_BOX_MAX_PROFILE, "small", "RELAY_BOX_MAX_PROFILE");
	const requestedProfile = boxProfileEnv(env.RELAY_BOX_PROFILE, "tiny", "RELAY_BOX_PROFILE");
	const gitToken =
		envValue(env, "RELAY_BOX_GITHUB_TOKEN") ?? envValue(env, "GITHUB_TOKEN") ?? envValue(env, "GH_TOKEN");
	const gitHost = envValue(env, "RELAY_BOX_GIT_HOST") ?? "github.com";
	const profile = profileRank(requestedProfile) > profileRank(maxProfile) ? maxProfile : requestedProfile;
	const resources = profileResources(profile);
	// Pause/stop/retention accept zero to disable that transition.
	const pauseMs = nonNegativeInt(
		env.RELAY_BOX_PAUSE_MS ?? env.RELAY_BOX_IDLE_MS,
		5 * 60_000,
		"RELAY_BOX_PAUSE_MS",
		24 * 60 * 60_000,
	);
	const stopMs = nonNegativeInt(env.RELAY_BOX_STOP_MS, 60 * 60_000, "RELAY_BOX_STOP_MS", 7 * 24 * 60 * 60_000);
	return {
		enabled: booleanEnv(env.RELAY_BOX, false, "RELAY_BOX"),
		dataDir,
		cacheDir,
		maxRunning: positiveInt(env.RELAY_BOX_MAX_RUNNING, 4, "RELAY_BOX_MAX_RUNNING", 64),
		maxCpus: positiveInt(env.RELAY_BOX_MAX_CPUS, 8, "RELAY_BOX_MAX_CPUS", 64),
		maxMemoryMiB: positiveInt(env.RELAY_BOX_MEMORY_BUDGET_MIB, 6144, "RELAY_BOX_MEMORY_BUDGET_MIB", 1_048_576),
		vmOverheadMiB: positiveInt(env.RELAY_BOX_VM_OVERHEAD_MIB, 128, "RELAY_BOX_VM_OVERHEAD_MIB", 65_536),
		pauseMs,
		stopMs,
		acquireTimeoutMs: positiveInt(
			env.RELAY_BOX_ACQUIRE_TIMEOUT_MS,
			10 * 60_000,
			"RELAY_BOX_ACQUIRE_TIMEOUT_MS",
			60 * 60_000,
		),
		setupTimeoutMs: positiveInt(
			env.RELAY_BOX_SETUP_TIMEOUT_MS,
			20 * 60_000,
			"RELAY_BOX_SETUP_TIMEOUT_MS",
			24 * 60 * 60_000,
		),
		retentionMs: nonNegativeInt(
			env.RELAY_BOX_RETENTION_MS,
			7 * 24 * 60 * 60_000,
			"RELAY_BOX_RETENTION_MS",
			365 * 24 * 60 * 60_000,
		),
		maxProfile,
		secrets: gitToken ? [{ envVar: "GITHUB_TOKEN", value: gitToken, allowedHosts: [gitHost] }] : [],
		defaults: {
			image: env.RELAY_BOX_IMAGE?.trim() || "auto",
			profile,
			maxProfile,
			cpus: positiveInt(env.RELAY_BOX_CPUS, resources.cpus, "RELAY_BOX_CPUS", 64),
			memoryMiB: positiveInt(env.RELAY_BOX_MEMORY_MIB, resources.memoryMiB, "RELAY_BOX_MEMORY_MIB", 65_536),
			rootDiskMiB: positiveInt(
				env.RELAY_BOX_ROOT_DISK_MIB,
				resources.rootDiskMiB,
				"RELAY_BOX_ROOT_DISK_MIB",
				1_048_576,
			),
			...(setup ? { setup } : {}),
			...(resume ? { resume } : {}),
			env: {},
			exclude: [],
		},
	};
}

/** True for hostnames that only accept local connections. */
export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase().replace(/\.$/, "");
	if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
	// Only accept a full 127.0.0.0/8 IPv4 literal. A prefix check would treat
	// attacker-controlled names like `127.evil` as loopback.
	const parts = normalized.split(".");
	if (parts.length !== 4 || parts[0] !== "127") return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Bracket an IPv6 literal for use in an origin. */
function originHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Validate the public origin used for OAuth callbacks and secure cookies. */
function resolvePublicUrl(env: Record<string, string | undefined>, hostname: string, port: number): string {
	const value = envValue(env, "RELAY_PUBLIC_URL") ?? `http://${originHost(hostname)}:${port}`;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("RELAY_PUBLIC_URL must be a valid absolute URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("RELAY_PUBLIC_URL must use http or https");
	}
	if (parsed.search || parsed.hash) {
		throw new Error("RELAY_PUBLIC_URL must not include a query string or fragment");
	}
	return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
}

function parseFlavor(env: Record<string, string | undefined>): RelayFlavor {
	const value = envValue(env, "RELAY_FLAVOR");
	if (!value) return "cloud";
	if (value !== "local" && value !== "cloud") {
		throw new Error(`RELAY_FLAVOR must be "local" or "cloud" (got "${value}")`);
	}
	return value;
}

function resolveDatabase(
	flavor: RelayFlavor,
	env: Record<string, string | undefined>,
	dataDir: string,
): DatabaseBackend {
	if (flavor === "local") {
		const rawPath = envValue(env, "RELAY_DB_PATH") ?? join(dataDir, "relay.db");
		const path = rawPath === ":memory:" ? rawPath : expandHomePath(rawPath);
		return {
			kind: "local",
			path,
			url: path === ":memory:" ? "file::memory:" : pathToFileURL(path).href,
		};
	}

	const url = envValue(env, "TURSO_DB_URL");
	const authToken = envValue(env, "TURSO_DB_TOKEN");
	if (!url) throw new Error("TURSO_DB_URL is required in cloud mode");
	if (!authToken) throw new Error("TURSO_DB_TOKEN is required in cloud mode");
	if (!/^(?:libsql|turso|https):\/\//i.test(url)) {
		throw new Error("TURSO_DB_URL must be a libsql://, turso://, or https:// URL in cloud mode");
	}
	return { kind: "turso", url, authToken };
}

export function serverConfigFromEnv(env: Record<string, string | undefined> = { ...process.env }): ServerConfig {
	const port = positiveInt(env.RELAY_PORT, DEFAULT_PORT, "RELAY_PORT", 65_535);
	const hostname = envValue(env, "RELAY_HOST") ?? DEFAULT_HOSTNAME;
	const flavor = parseFlavor(env);

	const dataDir = expandHomePath(envValue(env, "RELAY_DATA_DIR") ?? relayDir());
	const database = resolveDatabase(flavor, env, dataDir);
	const publicUrl = resolvePublicUrl(env, hostname, port);

	// GitHub App credentials are required in cloud mode. Local mode ignores
	// them even if they happen to be present in the same `.env`.
	const githubClientId = envValue(env, "GITHUB_APP_CLIENT_ID") ?? envValue(env, "GITHUB_CLIENT_ID") ?? "";
	const githubClientSecret = envValue(env, "GITHUB_APP_CLIENT_SECRET") ?? envValue(env, "GITHUB_CLIENT_SECRET") ?? "";
	const hasGithubCredentials = githubClientId !== "" && githubClientSecret !== "";
	if (flavor === "cloud" && !hasGithubCredentials) {
		throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required in cloud mode");
	}

	const authMode: AuthMode = flavor === "cloud" ? "github" : "local";
	if (authMode === "local" && !isLoopbackHost(hostname)) {
		throw new Error(
			"Local auth is loopback-only. Bind RELAY_HOST=127.0.0.1 or use RELAY_FLAVOR=cloud with GitHub auth",
		);
	}

	const rawRoots = parseList(env.RELAY_WORKSPACE_ROOTS);
	// Local mode allows any directory by default: the agent runs as the user on
	// their own machine. Cloud mode defaults to the server user's home so a
	// remote deployment cannot browse arbitrary paths without an explicit root.
	const defaultRoots = flavor === "local" ? [] : homeRoots();
	const workspaceRoots = rawRoots.includes("*")
		? []
		: (rawRoots.length > 0 ? rawRoots : defaultRoots).map((root) => resolve(root));
	const allowedGithub = parseList(env.AUTH_ALLOWED_GITHUB).map((entry) => entry.toLowerCase());

	// Exposing a cloud server beyond loopback requires an explicit HTTPS origin
	// (OAuth and the session cookie both need it) and explicit allowlists.
	if (authMode === "github" && !isLoopbackHost(hostname)) {
		if (!envValue(env, "RELAY_PUBLIC_URL")) {
			throw new Error("RELAY_PUBLIC_URL is required when binding a non-loopback host");
		}
		if (!publicUrl.startsWith("https://")) {
			throw new Error("RELAY_PUBLIC_URL must be https when binding a non-loopback host");
		}
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
	const settingsStore = envValue(env, "RELAY_SETTINGS_STORE") ?? "file";
	if (settingsStore !== "file" && settingsStore !== "database") {
		throw new Error(`RELAY_SETTINGS_STORE must be "file" or "database" (got "${settingsStore}")`);
	}
	const secretKey = envValue(env, "RELAY_SECRET_KEY") ?? null;
	const secretKeyFile = envValue(env, "RELAY_SECRET_KEY_FILE") ?? null;
	if (settingsStore === "database" && !secretKey && !secretKeyFile) {
		throw new Error("RELAY_SECRET_KEY (or RELAY_SECRET_KEY_FILE) is required when RELAY_SETTINGS_STORE=database");
	}

	// Canonicalize the default workspace and require it to satisfy the same
	// rules as a client-supplied path, so the server never advertises a
	// workspace it would refuse to create.
	const candidateCwd = envValue(env, "RELAY_WORKSPACE") ?? process.cwd();
	const defaultWorkspace = validateWorkspacePathSync(candidateCwd, workspaceRoots);
	if (!defaultWorkspace.ok) {
		throw new Error(
			`Default workspace "${candidateCwd}" is not usable: ${defaultWorkspace.message}. ` +
				`Set RELAY_WORKSPACE, or allow more roots via RELAY_WORKSPACE_ROOTS ` +
				`(use RELAY_WORKSPACE_ROOTS=* to allow any directory).`,
		);
	}

	return {
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
		publicUrl,
		sessionTtlDays: positiveInt(env.AUTH_SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS, "AUTH_SESSION_TTL_DAYS", 365),
		defaultCwd: defaultWorkspace.path,
		workspaceRoots,
		maxSessionsPerWorkspace: nonNegativeInt(
			env.RELAY_MAX_SESSIONS_PER_WORKSPACE,
			flavor === "local" ? 0 : DEFAULT_CLOUD_SESSION_LIMIT,
			"RELAY_MAX_SESSIONS_PER_WORKSPACE",
			10_000,
		),
		allowedGithub,
		settingsStore,
		dataDir,
		secretKey,
		secretKeyFile,
		staticDir: envValue(env, "RELAY_STATIC_DIR") ?? null,
		box: boxConfigFromEnv(env),
	};
}

/** The default workspace roots: the server user's home, or none when unknown. */
function homeRoots(): string[] {
	const home = homeDir();
	return home ? [home] : [];
}
