// Guards the server composition layer: sequential store acquisition, the
// users-before-auth_sessions DDL order, and the API-key backend selection
// (file by default, with the database keeping keys encrypted).

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { AuthSessions, Config, Database, SessionStore, storesLayer, UserSettings, UserStore } from "../services.ts";
import type { ServerConfig } from "../config.ts";
import { makeConfig } from "./helpers.ts";

interface RecordedStatement {
	sql: string;
	args?: unknown[];
}

/** A database client stand-in that records every statement and serves canned rows. */
function recordingDatabaseLayer(rowsFor?: (sql: string) => Record<string, unknown>[]) {
	const statements: RecordedStatement[] = [];
	const client = {
		execute: async (statement: unknown) => {
			const recorded: RecordedStatement =
				typeof statement === "string" ? { sql: statement } : (statement as RecordedStatement);
			statements.push(recorded);
			return { rows: rowsFor?.(recorded.sql) ?? [] };
		},
		batch: async () => [],
	} as unknown as DatabaseClient;
	return { statements, layer: Layer.succeed(Database, client) };
}

/** Materializes `storesLayer` against a recording database and returns the store bundle. */
async function acquireStores(config: ServerConfig, database: Layer.Layer<Database>) {
	const program = Effect.gen(function* () {
		const userStore = yield* UserStore;
		const userSettings = yield* UserSettings;
		const authSessions = yield* AuthSessions;
		const sessionStore = yield* SessionStore;
		return { userStore, userSettings, authSessions, sessionStore };
	});
	return await Effect.runPromise(
		program.pipe(
			Effect.provide(
				storesLayer.pipe(Layer.provideMerge(database.pipe(Layer.provideMerge(Layer.succeed(Config, config))))),
			),
		),
	);
}

async function tempDataDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "relay-settings-"));
}

describe("storesLayer", () => {
	it("acquires every store sequentially and runs users DDL before auth_sessions", async () => {
		const { statements, layer: database } = recordingDatabaseLayer();
		const config = makeConfig(process.cwd(), { dataDir: await tempDataDir() });

		const stores = await acquireStores(config, database);

		expect(stores.userStore).toBeDefined();
		expect(stores.userSettings).toBeDefined();
		expect(stores.authSessions).toBeDefined();
		expect(stores.sessionStore).toBeDefined();

		const usersDdl = statements.findIndex((statement) =>
			statement.sql.includes("CREATE TABLE IF NOT EXISTS users"),
		);
		const authSessionsDdl = statements.findIndex((statement) =>
			statement.sql.includes("CREATE TABLE IF NOT EXISTS auth_sessions"),
		);
		expect(usersDdl).toBeGreaterThanOrEqual(0);
		expect(authSessionsDdl).toBeGreaterThan(usersDdl);
	});

	it("file backend migrates a legacy database key and clears it", async () => {
		const dataDir = await tempDataDir();
		const { statements, layer: database } = recordingDatabaseLayer((sql) => {
			if (sql.includes("SELECT user_id FROM user_settings")) return [{ user_id: "user-1" }];
			if (sql.includes("SELECT llm_api_key FROM user_settings")) return [{ llm_api_key: "sk-legacy-1234" }];
			return [];
		});
		const config = makeConfig(process.cwd(), { settingsStore: "file", dataDir });

		const { userSettings } = await acquireStores(config, database);

		expect(await Effect.runPromise(userSettings.getApiKey("user-1"))).toBe("sk-legacy-1234");
		expect(await Effect.runPromise(userSettings.getApiKeyStatus("user-1"))).toEqual({ set: true, hint: "1234" });

		// The secret left the database: a purge write with a null value was issued.
		const purge = statements.find(
			(statement) => statement.sql.includes("INSERT INTO user_settings") && statement.args?.[1] === null,
		);
		expect(purge).toBeDefined();

		const raw = await readFile(join(dataDir, "settings", "user-1.json"), "utf8");
		expect(raw).not.toContain("sk-legacy-1234");
		expect(raw).toContain("v1.");
	});

	it("database backend keeps keys encrypted under the configured master key", async () => {
		const { statements, layer: database } = recordingDatabaseLayer((sql) => {
			if (sql.includes("SELECT llm_api_key")) {
				const insert = statements.find((statement) => statement.sql.includes("INSERT INTO user_settings"));
				return [{ llm_api_key: insert?.args?.[1], llm_api_key_hint: insert?.args?.[2] }];
			}
			return [];
		});
		const config = makeConfig(process.cwd(), {
			settingsStore: "database",
			secretKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
		});

		const { userSettings } = await acquireStores(config, database);

		await Effect.runPromise(userSettings.setApiKey("user-1", "sk-live-abcd"));
		const insert = statements.find((statement) => statement.sql.includes("INSERT INTO user_settings"));
		expect(insert?.args?.[1]).not.toBe("sk-live-abcd");
		expect(String(insert?.args?.[1])).toMatch(/^v1\./);

		expect(await Effect.runPromise(userSettings.getApiKey("user-1"))).toBe("sk-live-abcd");
		expect(await Effect.runPromise(userSettings.getApiKeyStatus("user-1"))).toEqual({ set: true, hint: "abcd" });

		// No file-store migration runs in database mode.
		expect(statements.some((statement) => statement.sql.includes("SELECT user_id FROM user_settings"))).toBe(false);
	});
});
