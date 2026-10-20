// Local database client: the same stores must work against an embedded libSQL
// file with no server and no auth token.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createDatabaseClient, normalizeDatabaseUrl, type DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { DatabaseUserStore } from "@vvtxn/relay/core/auth/db.ts";
import { DatabaseSessionStore } from "@vvtxn/relay/core/sessions/index.ts";

async function tempDatabase(): Promise<{ client: DatabaseClient; path: string; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "relay-local-db-"));
	const path = join(dir, "relay.db");
	const client = createDatabaseClient({ url: pathToFileURL(path).href });
	return { client, path, dir };
}

describe("database URL normalization", () => {
	it("maps Turso/libSQL aliases to HTTPS without touching local files", () => {
		expect(normalizeDatabaseUrl("turso://example.turso.io")).toBe("https://example.turso.io");
		expect(normalizeDatabaseUrl("libsql://example.turso.io")).toBe("https://example.turso.io");
		expect(normalizeDatabaseUrl("https://example.turso.io")).toBe("https://example.turso.io");
		expect(normalizeDatabaseUrl("file:///tmp/relay.db")).toBe("file:///tmp/relay.db");
	});
});

describe("local database client", () => {
	it("runs the session store against an embedded file", async () => {
		const { client, dir } = await tempDatabase();
		try {
			const store = new DatabaseSessionStore({ client, maxSessionsPerWorkspace: 0 });
			await Effect.runPromise(store.ready);

			const handle = store.create({ ownerId: "local", cwd: "/repo" });
			await Effect.runPromise(handle.append({ type: "message", role: "user", content: "hello" }));
			await Effect.runPromise(handle.append({ type: "message", role: "assistant", content: "hi" }));

			const summaries = await Effect.runPromise(store.listSummaries({ ownerId: "local", cwd: "/repo" }));
			expect(summaries).toHaveLength(1);
			expect(summaries[0]?.firstUserMessage).toBe("hello");

			const opened = await Effect.runPromise(store.open(handle.getHeader().id, "local"));
			expect(opened.getEntries()).toHaveLength(2);
		} finally {
			client.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps every session when the limit is unlimited and persists after reopen", async () => {
		const first = await tempDatabase();
		try {
			const store = new DatabaseSessionStore({ client: first.client, maxSessionsPerWorkspace: 0 });
			await Effect.runPromise(store.ready);
			for (let index = 0; index < 25; index++) {
				const handle = store.create({ ownerId: "local", cwd: "/repo" });
				await Effect.runPromise(handle.append({ type: "message", role: "user", content: `thread ${index}` }));
			}
			expect(await Effect.runPromise(store.listSummaries({ ownerId: "local", cwd: "/repo" }))).toHaveLength(25);
		} finally {
			first.client.close();
		}

		const reopened = createDatabaseClient({ url: pathToFileURL(first.path).href });
		try {
			const store = new DatabaseSessionStore({ client: reopened, maxSessionsPerWorkspace: 0 });
			await Effect.runPromise(store.ready);
			expect(await Effect.runPromise(store.listSummaries({ ownerId: "local", cwd: "/repo" }))).toHaveLength(25);
		} finally {
			reopened.close();
			await rm(first.dir, { recursive: true, force: true });
		}
	});

	it("creates the local user through the normal user store", async () => {
		const { client, dir } = await tempDatabase();
		try {
			const users = new DatabaseUserStore({ client });
			await Effect.runPromise(users.ready);
			const user = await Effect.runPromise(
				users.resolve({ provider: "local", subject: "local", name: "Tester" }),
			);
			expect(user.name).toBe("Tester");
			expect(await Effect.runPromise(users.getById(user.id))).toMatchObject({ id: user.id, name: "Tester" });
		} finally {
			client.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rolls back an atomic batch", async () => {
		const { client, dir } = await tempDatabase();
		try {
			await client.execute("CREATE TABLE t (value TEXT PRIMARY KEY)");
			await expect(
				client.batch(
					[
						{ sql: "INSERT INTO t VALUES (?)", args: ["kept?"] },
						{ sql: "INSERT INTO t VALUES (?)", args: ["kept?"] },
					],
					"write",
				),
			).rejects.toThrow(/constraint failed/i);
			const rows = await client.execute("SELECT value FROM t");
			expect(rows.rows).toHaveLength(0);
		} finally {
			client.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
