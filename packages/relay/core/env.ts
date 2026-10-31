/**
 * Environment for agent-spawned commands.
 *
 * Tool subprocesses (bash) must not inherit the server's credentials: the
 * process environment holds the database token, GitHub OAuth secrets, and the
 * settings master key. Commands receive a copy with credential-shaped
 * variables removed — PATH, HOME, and the rest survive, so build tooling keeps
 * working while `env` no longer hands secrets to the model. The sandbox layer
 * under construction reuses this as its baseline environment.
 */

/** Exact names the generic pattern would not catch. */
const SECRET_NAMES = new Set(["TURSO_DB_URL", "TURSO_DB_TOKEN", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]);

/** Credential-shaped names (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, ...). */
const SECRET_NAME_PATTERN = /(^|_)(SECRET|SECRETS|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|CREDENTIALS|API_KEY)(_|$)/i;

/** Copies `source`, dropping every environment variable that holds a credential. */
export function scrubbedAgentEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (SECRET_NAMES.has(name) || SECRET_NAME_PATTERN.test(name)) continue;
		env[name] = value;
	}
	return env;
}
