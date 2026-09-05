import { assertEquals } from "@std/assert";
import { serverConfigFromEnv } from "./config.ts";

const REQUIRED_ENV = {
	LLM_API_KEY: "test-key",
	TURSO_DB_URL: "turso://test",
	TURSO_DB_TOKEN: "test-token",
	DEV_AUTH_SUBJECT: "dev-user",
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
		serverConfigFromEnv({});
	} catch (error) {
		threw = true;
		assertEquals((error as Error).message, "LLM_API_KEY is required");
	}
	assertEquals(threw, true);
});
