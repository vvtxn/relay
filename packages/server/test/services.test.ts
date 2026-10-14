// Guards the server composition layer: sequential store acquisition and the
// users-before-auth_sessions DDL order.

import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer } from "effect";
import type { DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { AuthSessions, Config, Database, SessionStore, storesLayer, UserSettings, UserStore } from "../services.ts";
import { makeConfig } from "./helpers.ts";

/** A Turso client stand-in that records every statement executed against it. */
function recordingDatabaseLayer() {
	const statements: string[] = [];
	const client = {
		execute: async (statement: unknown) => {
			const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
			statements.push(sql);
			return { rows: [] };
		},
		batch: async () => [],
	} as unknown as DatabaseClient;
	return { statements, layer: Layer.succeed(Database, client) };
}

describe("storesLayer", () => {
	it("acquires every store sequentially and runs users DDL before auth_sessions", async () => {
		const { statements, layer: database } = recordingDatabaseLayer();
		const config = makeConfig(process.cwd());

		const program = Effect.gen(function* () {
			const userStore = yield* UserStore;
			const userSettings = yield* UserSettings;
			const authSessions = yield* AuthSessions;
			const sessionStore = yield* SessionStore;
			return { userStore, userSettings, authSessions, sessionStore };
		});

		const stores = await Effect.runPromise(
			program.pipe(
				Effect.provide(
					storesLayer.pipe(
						Layer.provideMerge(database.pipe(Layer.provideMerge(Layer.succeed(Config, config)))),
					),
				),
			),
		);

		expect(stores.userStore).toBeDefined();
		expect(stores.userSettings).toBeDefined();
		expect(stores.authSessions).toBeDefined();
		expect(stores.sessionStore).toBeDefined();

		const usersDdl = statements.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS users"));
		const authSessionsDdl = statements.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS auth_sessions"));
		expect(usersDdl).toBeGreaterThanOrEqual(0);
		expect(authSessionsDdl).toBeGreaterThan(usersDdl);
	});
});
