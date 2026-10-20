// The database store enforces the per-workspace session cap atomically when a
// user message is persisted, and trims pre-existing overflow at startup.

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { DatabaseSessionStore } from "@vvtxn/relay/core/sessions/index.ts";

interface RecordedStatement {
	sql: string;
	args?: unknown[];
}

interface RecordedBatch {
	statements: RecordedStatement[];
	mode?: unknown;
}

function fakeDatabase(rowsFor?: (sql: string) => Record<string, unknown>[]) {
	const batches: RecordedBatch[] = [];
	const client = {
		execute: async (statement: unknown) => {
			const sql = typeof statement === "string" ? statement : (statement as RecordedStatement).sql;
			return { rows: rowsFor?.(sql) ?? [] };
		},
		batch: async (statements: RecordedStatement[], mode?: unknown) => {
			batches.push({ statements, mode });
			return statements.map((statement) => ({
				columns: [],
				columnTypes: [],
				rows: [],
				rowsAffected: statement.sql.startsWith("DELETE FROM sessions") ? 1 : 0,
				lastInsertRowid: undefined,
			}));
		},
	} as unknown as DatabaseClient;
	return { batches, client };
}

function makeStore(client: DatabaseClient, maxSessionsPerWorkspace = 10): DatabaseSessionStore {
	return new DatabaseSessionStore({ client, maxSessionsPerWorkspace });
}

describe("DatabaseSessionStore session limit", () => {
	it("keeps the current session and the newest others when a user message is persisted", async () => {
		const { batches, client } = fakeDatabase();
		const store = makeStore(client);
		const handle = store.create({ ownerId: "user-1", cwd: "/repo" });

		await Effect.runPromise(handle.append({ type: "message", role: "user", content: "hello" }));

		expect(batches).toHaveLength(1);
		const statements = batches[0]?.statements ?? [];
		const entriesDelete = statements.find((statement) => statement.sql.includes("DELETE FROM session_entries"));
		const sessionsDelete = statements.find((statement) => statement.sql.includes("DELETE FROM sessions"));
		expect(entriesDelete).toBeDefined();
		expect(sessionsDelete).toBeDefined();
		expect(sessionsDelete?.sql).toContain("id <> ?");
		expect(sessionsDelete?.args).toEqual(["user-1", "/repo", handle.getHeader().id, 9]);
		// The row is written before the prune so it is part of the kept set.
		const insertIndex = statements.findIndex((statement) => statement.sql.includes("INSERT INTO sessions"));
		const deleteIndex = statements.findIndex((statement) => statement.sql.includes("DELETE FROM sessions"));
		expect(deleteIndex).toBeGreaterThan(insertIndex);
		expect(batches[0]?.mode).toBe("write");
	});

	it("does not prune on assistant or tool-result appends", async () => {
		const { batches, client } = fakeDatabase();
		const store = makeStore(client);
		const handle = store.create({ ownerId: "user-1", cwd: "/repo" });

		await Effect.runPromise(handle.append({ type: "message", role: "user", content: "hello" }));
		await Effect.runPromise(handle.append({ type: "message", role: "assistant", content: "hi" }));
		await Effect.runPromise(
			handle.append({ type: "tool_result", toolCallId: "call-1", toolName: "read_file", content: "data" }),
		);

		expect(batches).toHaveLength(3);
		for (const batch of batches.slice(1)) {
			expect(batch.statements.some((statement) => statement.sql.startsWith("DELETE"))).toBe(false);
		}
	});

	it("trims every over-limit workspace during startup", async () => {
		const { batches, client } = fakeDatabase((sql) =>
			sql.includes("GROUP BY owner_id, cwd")
				? [
						{ owner_id: "user-1", cwd: "/repo" },
						{ owner_id: "user-2", cwd: "/other" },
					]
				: [],
		);
		const store = makeStore(client, 3);

		const removed = await Effect.runPromise(store.pruneAll());

		expect(removed).toBe(2);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.statements[1]?.args).toEqual(["user-1", "/repo", 3]);
		expect(batches[1]?.statements[1]?.args).toEqual(["user-2", "/other", 3]);
	});

	it("does not prune when the limit is unlimited", async () => {
		const { batches, client } = fakeDatabase();
		const store = makeStore(client, 0);
		const handle = store.create({ ownerId: "user-1", cwd: "/repo" });

		await Effect.runPromise(handle.append({ type: "message", role: "user", content: "hello" }));

		expect(batches).toHaveLength(1);
		expect(batches[0]?.statements.some((statement) => statement.sql.startsWith("DELETE"))).toBe(false);
	});

	it("skips startup pruning when the limit is unlimited", async () => {
		const { batches, client } = fakeDatabase();
		const store = makeStore(client, 0);

		expect(await Effect.runPromise(store.pruneAll())).toBe(0);
		expect(batches).toHaveLength(0);
	});

	it("keeps only the current session when the limit is 1", async () => {
		const { batches, client } = fakeDatabase();
		const store = makeStore(client, 1);
		const handle = store.create({ ownerId: "user-1", cwd: "/repo" });

		await Effect.runPromise(handle.append({ type: "message", role: "user", content: "hello" }));

		const sessionsDelete = batches[0]?.statements.find((statement) =>
			statement.sql.includes("DELETE FROM sessions"),
		);
		expect(sessionsDelete?.args).toEqual(["user-1", "/repo", handle.getHeader().id, 0]);
	});
});
