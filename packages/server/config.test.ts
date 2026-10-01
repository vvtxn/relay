import { assertEquals, assertThrows } from "@std/assert";
import { serverConfigFromEnv } from "./config.ts";

const REQUIRED_ENV = {
	LLM_API_KEY: "test-key",
	TURSO_DB_URL: "turso://test",
	TURSO_DB_TOKEN: "test-token",
	GITHUB_APP_CLIENT_ID: "cid",
	GITHUB_APP_CLIENT_SECRET: "csecret",
};

const GITHUB_ENV = {
	...REQUIRED_ENV,
	RELAY_PUBLIC_URL: "https://relay.example.com/",
};

Deno.test("serverConfigFromEnv - reads required values and applies defaults", () => {
	const config = serverConfigFromEnv({ ...REQUIRED_ENV });
	assertEquals(config.apiKey, "test-key");
	assertEquals(config.tursoUrl, "turso://test");
	assertEquals(config.tursoToken, "test-token");
	assertEquals(config.githubClientId, "cid");
	assertEquals(config.githubClientSecret, "csecret");
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
		AUTH_ALLOWED_GITHUB: "octocat",
		RELAY_WORKSPACE_ROOTS: "/srv/projects",
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
		serverConfigFromEnv(
			{ LLM_API_KEY: "test-key", GITHUB_APP_CLIENT_ID: "cid", GITHUB_APP_CLIENT_SECRET: "csecret" },
			() => null,
		);
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

Deno.test("serverConfigFromEnv - defaults", () => {
	const config = serverConfigFromEnv({ ...REQUIRED_ENV });
	assertEquals(config.publicUrl, "http://127.0.0.1:7433");
	assertEquals(config.sessionTtlDays, 30);
});

Deno.test("serverConfigFromEnv - requires GitHub App credentials", () => {
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

Deno.test("serverConfigFromEnv - reads oauth config and trims the public url", () => {
	const config = serverConfigFromEnv(GITHUB_ENV);
	assertEquals(config.githubClientId, "cid");
	assertEquals(config.githubClientSecret, "csecret");
	assertEquals(config.publicUrl, "https://relay.example.com");
});

Deno.test("serverConfigFromEnv - accepts legacy GITHUB_CLIENT_* names", () => {
	const { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, ...rest } = GITHUB_ENV;
	const config = serverConfigFromEnv({
		...rest,
		GITHUB_CLIENT_ID: GITHUB_APP_CLIENT_ID,
		GITHUB_CLIENT_SECRET: GITHUB_APP_CLIENT_SECRET,
	});
	assertEquals(config.githubClientId, "cid");
	assertEquals(config.githubClientSecret, "csecret");
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

Deno.test("serverConfigFromEnv - allowlists default to empty (allow any) on loopback", () => {
	const config = serverConfigFromEnv({ ...GITHUB_ENV });
	assertEquals(config.workspaceRoots, []);
	assertEquals(config.allowedGithub, []);
});

Deno.test("serverConfigFromEnv - non-loopback mode requires both allowlists", () => {
	assertThrows(
		() => serverConfigFromEnv({ ...GITHUB_ENV, RELAY_HOST: "0.0.0.0" }),
		Error,
		"AUTH_ALLOWED_GITHUB",
	);
	assertThrows(
		() => serverConfigFromEnv({ ...GITHUB_ENV, RELAY_HOST: "0.0.0.0", AUTH_ALLOWED_GITHUB: "octocat" }),
		Error,
		"RELAY_WORKSPACE_ROOTS",
	);
	const config = serverConfigFromEnv({
		...GITHUB_ENV,
		RELAY_HOST: "0.0.0.0",
		AUTH_ALLOWED_GITHUB: "octocat",
		RELAY_WORKSPACE_ROOTS: "/srv/projects",
	});
	assertEquals(config.hostname, "0.0.0.0");
	assertEquals(config.allowedGithub, ["octocat"]);
	assertEquals(config.workspaceRoots, ["/srv/projects"]);
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
