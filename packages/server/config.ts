/** Server configuration — read once from the environment at startup. */

export interface ServerConfig {
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
	/** Local development auth subject. */
	devAuthSubject: string;
	/** Default workspace cwd when a client doesn't specify one (server's cwd). */
	defaultCwd: string;
	/** Directory containing the built web app to serve statically, when present. */
	staticDir: string | null;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "moonshotai/kimi-k2.6";

function required(env: Record<string, string | undefined>, key: string): string {
	const value = env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
}

export function serverConfigFromEnv(env: Record<string, string | undefined> = Deno.env.toObject()): ServerConfig {
	return {
		port: Number(env.RELAY_PORT ?? DEFAULT_PORT),
		hostname: env.RELAY_HOST ?? DEFAULT_HOSTNAME,
		apiKey: required(env, "LLM_API_KEY"),
		baseURL: env.LLM_BASE_URL ?? DEFAULT_BASE_URL,
		model: env.LLM_MODEL ?? DEFAULT_MODEL,
		temperature: Number(env.LLM_TEMPERATURE ?? 0.1),
		maxTokens: Number(env.LLM_MAX_TOKENS ?? 350_000),
		preserveRecentTurns: Number(env.LLM_PRESERVE_RECENT_TURNS ?? 6),
		maxCompletionTokens: Number(env.LLM_MAX_COMPLETION_TOKENS ?? 16_384),
		tursoUrl: required(env, "TURSO_DB_URL"),
		tursoToken: required(env, "TURSO_DB_TOKEN"),
		devAuthSubject: required(env, "DEV_AUTH_SUBJECT"),
		defaultCwd: env.RELAY_WORKSPACE ?? Deno.cwd(),
		staticDir: env.RELAY_STATIC_DIR ?? null,
	};
}
