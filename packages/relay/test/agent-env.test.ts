// Agent command environments: credential-shaped variables are stripped before
// a tool subprocess spawns, so `env` cannot hand the model server secrets.

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { scrubbedAgentEnv } from "../core/env.ts";
import { createBashTool } from "../core/tools/bash.ts";

describe("scrubbedAgentEnv", () => {
	it("drops credential-shaped variables and keeps ordinary ones", () => {
		const env = scrubbedAgentEnv({
			PATH: "/usr/bin",
			HOME: "/home/me",
			NODE_ENV: "development",
			TURSO_DB_URL: "turso://example",
			TURSO_DB_TOKEN: "db-token",
			GITHUB_APP_CLIENT_ID: "client-id",
			GITHUB_APP_CLIENT_SECRET: "gh-secret",
			RELAY_SECRET_KEY: "master",
			RELAY_SECRET_KEY_FILE: "/run/secrets/master",
			SOME_API_KEY: "sk-123",
			MY_PASSWORD: "hunter2",
			SERVICE_TOKEN: "token",
		});

		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me", NODE_ENV: "development" });
	});

	it("skips unset variables", () => {
		expect(scrubbedAgentEnv({ KEEP: "1", DROP: undefined })).toEqual({ KEEP: "1" });
	});
});

describe("bash tool environment", () => {
	it("does not pass process secrets to commands", async () => {
		const name = "RELAY_TEST_SERVICE_TOKEN";
		const previous = process.env[name];
		process.env[name] = "leaked-if-visible";
		try {
			const bash = createBashTool();
			const result = await Effect.runPromise(bash.execute({ command: `printenv ${name} || echo unset` }));
			expect(result.content.trim()).toBe("unset");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});

	it("uses an explicitly provided environment", async () => {
		const path = process.env.PATH ?? "";
		const bash = createBashTool(undefined, { env: { PATH: path, INJECTED: "yes" } });
		const result = await Effect.runPromise(bash.execute({ command: "printenv INJECTED" }));
		expect(result.content.trim()).toBe("yes");
	});
});
