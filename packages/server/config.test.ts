import { assertEquals, assertThrows } from "@std/assert";
import { serverConfigFromEnv } from "./config.ts";

const REQUIRED_ENV = {
	LLM_API_KEY: "test-key",
	TURSO_DB_URL: "turso://test",
	TURSO_DB_TOKEN: "test-token",
	DEV_AUTH_SUBJECT: "dev-user",
};

const GITHUB_ENV = {
	LLM_API_KEY: "test-key",
	TURSO_DB_URL: "turso://test",
	TURSO_DB_TOKEN: "test-token",
	AUTH_PROVIDER: "github",
	GITHUB_APP_CLIENT_ID: "cid",
	GITHUB_APP_CLIENT_SECRET: "csecret",
	RELAY_PUBLIC_URL: "https://relay.example.com/",
};

Deno.test("serverConfigFromEnv - reads required values and applies defaults", () => {
	const config = serverConfigFromEnv({ ...REQUIRED_ENV });
	assertEquals(config.apiKey, "test-key");
	assertEquals(config.tursoUrl, "turso://test");
	assertEquals(config.tursoToken, "test-token");
	assertEquals(config.devAuthSubject, "dev-user");
	assertEquals(config.port, 7433);
	assertEquals(config.hostname, "127.0.0.1");
	assertEquals(config.baseURL, "https://openrouter.ai/api/v1");
	assertEquals(config.model, "moonshotai/kimi-k2.6");
});

Deno.test("serverConfigFromEnv - respects overrides", () => {
	const config = serverConfigFromEnv({
		...REQUIRED_ENV,
		RELAY_PORT: "9000",
		RELAY_HOST: "0.0.0.0",
		LLM_MODEL: "test/model",
		LLM_MAX_TOKENS: "100000",
	});
	assertEquals(config.port, 9000);
	assertEquals(config.hostname, "0.0.0.0");
	assertEquals(config.model, "test/model");
	assertEquals(config.maxTokens, 100_000);
});

Deno.test("serverConfigFromEnv - throws when required env is missing", () => {
	let threw = false;
	try {
		serverConfigFromEnv({ LLM_API_KEY: "test-key", DEV_AUTH_SUBJECT: "dev-user" }, () => null);
	} catch (error) {
		threw = true;
		assertEquals((error as Error).message, "TURSO_DB_URL is required");
	}
	assertEquals(threw, true);
});

Deno.test("serverConfigFromEnv - falls back to the CLI auth file for the API key", () => {
	const config = serverConfigFromEnv(
		{ ...REQUIRED_ENV, LLM_API_KEY: undefined },
		() => "file-key",
	);
	assertEquals(config.apiKey, "file-key");
});

Deno.test("serverConfigFromEnv - prefers the env key over the auth file", () => {
	const config = serverConfigFromEnv({ ...REQUIRED_ENV }, () => "file-key");
	assertEquals(config.apiKey, "test-key");
});

Deno.test("serverConfigFromEnv - throws when no key source is available", () => {
	let message = "";
	try {
		serverConfigFromEnv({ ...REQUIRED_ENV, LLM_API_KEY: undefined }, () => null);
	} catch (error) {
		message = (error as Error).message;
	}
	assertEquals(message, "LLM_API_KEY is required (or run the CLI once to create ~/.relay/auth.json)");
});

Deno.test("serverConfigFromEnv - local mode defaults", () => {
	const config = serverConfigFromEnv({ ...REQUIRED_ENV });
	assertEquals(config.authProvider, "local");
	assertEquals(config.devAuthSubject, "dev-user");
	assertEquals(config.allowLocalAuth, true);
	assertEquals(config.publicUrl, "http://127.0.0.1:7433");
	assertEquals(config.sessionTtlDays, 30);
});

Deno.test("serverConfigFromEnv - local mode requires a subject", () => {
	assertThrows(
		() => serverConfigFromEnv({ ...REQUIRED_ENV, DEV_AUTH_SUBJECT: undefined }),
		Error,
		"DEV_AUTH_SUBJECT",
	);
});

Deno.test("serverConfigFromEnv - github mode reads oauth config and trims the public url", () => {
	const config = serverConfigFromEnv(GITHUB_ENV);
	assertEquals(config.authProvider, "github");
	assertEquals(config.githubClientId, "cid");
	assertEquals(config.githubClientSecret, "csecret");
	assertEquals(config.publicUrl, "https://relay.example.com");
	assertEquals(config.allowLocalAuth, false);
	assertEquals(config.devAuthSubject, null);
});

Deno.test("serverConfigFromEnv - github mode requires client credentials", () => {
	assertThrows(
		() => serverConfigFromEnv({ ...GITHUB_ENV, GITHUB_APP_CLIENT_SECRET: undefined }),
		Error,
		"GITHUB_APP_CLIENT_SECRET",
	);
	assertThrows(
		() => serverConfigFromEnv({ ...GITHUB_ENV, GITHUB_APP_CLIENT_ID: undefined }),
		Error,
		"GITHUB_APP_CLIENT_ID",
	);
});

Deno.test("serverConfigFromEnv - github mode accepts legacy GITHUB_CLIENT_* names", () => {
	const { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, ...rest } = GITHUB_ENV;
	const config = serverConfigFromEnv({
		...rest,
		GITHUB_CLIENT_ID: GITHUB_APP_CLIENT_ID,
		GITHUB_CLIENT_SECRET: GITHUB_APP_CLIENT_SECRET,
	});
	assertEquals(config.githubClientId, "cid");
	assertEquals(config.githubClientSecret, "csecret");
});

Deno.test("serverConfigFromEnv - AUTH_ALLOW_LOCAL overrides the github default", () => {
	const config = serverConfigFromEnv({ ...GITHUB_ENV, AUTH_ALLOW_LOCAL: "true" });
	assertEquals(config.allowLocalAuth, true);
});

Deno.test("serverConfigFromEnv - rejects an unknown AUTH_PROVIDER", () => {
	assertThrows(() => serverConfigFromEnv({ ...REQUIRED_ENV, AUTH_PROVIDER: "gitlab" }), Error, "AUTH_PROVIDER");
});

Deno.test("serverConfigFromEnv - parses allowlists", () => {
	const config = serverConfigFromEnv({
		...GITHUB_ENV,
		RELAY_WORKSPACE_ROOTS: "/srv/projects, /srv/other",
		AUTH_ALLOWED_GITHUB: "Octocat, 12345",
	});
	assertEquals(config.workspaceRoots, ["/srv/projects", "/srv/other"]);
	assertEquals(config.allowedGithub, ["octocat", "12345"]);
});

Deno.test("serverConfigFromEnv - allowlists default to empty (allow any)", () => {
	const config = serverConfigFromEnv({ ...GITHUB_ENV });
	assertEquals(config.workspaceRoots, []);
	assertEquals(config.allowedGithub, []);
});

Deno.test("serverConfigFromEnv - rejects malformed numeric env", () => {
	assertThrows(() => serverConfigFromEnv({ ...REQUIRED_ENV, RELAY_PORT: "abc" }), Error, "RELAY_PORT");
	assertThrows(() => serverConfigFromEnv({ ...REQUIRED_ENV, RELAY_PORT: "0" }), Error, "RELAY_PORT");
	assertThrows(
		() => serverConfigFromEnv({ ...REQUIRED_ENV, AUTH_SESSION_TTL_DAYS: "-5" }),
		Error,
		"AUTH_SESSION_TTL_DAYS",
	);
	assertThrows(
		() => serverConfigFromEnv({ ...REQUIRED_ENV, AUTH_SESSION_TTL_DAYS: "9999" }),
		Error,
		"AUTH_SESSION_TTL_DAYS",
	);
});
