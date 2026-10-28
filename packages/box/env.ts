import type { BoxSettings } from "./types.ts";

/** Safe, host-independent environment for every command inside a box. */
export function boxBaseEnv(settings: BoxSettings): Record<string, string> {
	return {
		HOME: "/root",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TERM: "dumb",
		CI: "1",
		PNPM_STORE_DIR: "/relay-cache/pnpm-store",
		PNPM_HOME: "/relay-cache/pnpm",
		COREPACK_HOME: "/relay-cache/corepack",
		npm_config_cache: "/relay-cache/npm",
		YARN_CACHE_FOLDER: "/relay-cache/yarn",
		PIP_CACHE_DIR: "/relay-cache/pip",
		XDG_CACHE_HOME: "/relay-cache/xdg",
		GIT_AUTHOR_NAME: "Relay Agent",
		GIT_AUTHOR_EMAIL: "agent@relay.local",
		GIT_COMMITTER_NAME: "Relay Agent",
		GIT_COMMITTER_EMAIL: "agent@relay.local",
		// The askpass helper reads the placeholder token; Microsandbox substitutes
		// the real value only for the configured git host.
		GIT_ASKPASS: "/usr/local/bin/relay-git-askpass",
		GIT_TERMINAL_PROMPT: "0",
		...settings.env,
	};
}

/** Base environment plus one command's explicit overrides. */
export function boxExecEnv(settings: BoxSettings, extra: Record<string, string> = {}): Record<string, string> {
	return { ...boxBaseEnv(settings), ...extra };
}
