import { assert, assertEquals } from "@std/assert";
import { DatabaseSessionStore, type DatabaseSessionStoreOptions } from "@/core/sessions/db.ts";

type Statement = { sql: string; args?: unknown[] };

class FakeClient {
	executed: (string | Statement)[] = [];
	batches: { statements: Statement[]; mode?: string | undefined }[] = [];

	execute(statement: string | Statement): Promise<{ rows: Record<string, unknown>[] }> {
		this.executed.push(statement);
		return Promise.resolve({ rows: [] });
	}

	batch(statements: Statement[], mode?: string): Promise<void> {
		this.batches.push({ statements, mode });
		return Promise.resolve();
	}
}

function storeWithFake(fake: FakeClient): DatabaseSessionStore {
	const options: DatabaseSessionStoreOptions = {
		url: "turso://example",
		authToken: "test-token",
		client: fake as unknown as NonNullable<DatabaseSessionStoreOptions["client"]>,
	};
	return new DatabaseSessionStore(options);
}

Deno.test("DatabaseSessionStore creates schema lazily and appends an ordered entry", async () => {
	const fake = new FakeClient();
	const store = storeWithFake(fake);
	const session = store.create({ ownerId: "user-1", cwd: "/tmp/project" });

	const id = await session.append({ type: "message", role: "user", content: "hello" });

	assert(id.length > 0);
	assertEquals(fake.executed.length, 4);
	assertEquals(fake.batches.length, 1);
	assertEquals(fake.batches[0]!.mode, "write");
	assertEquals(fake.batches[0]!.statements.length, 2);
	assert(fake.batches[0]!.statements[0]!.sql.includes("INSERT INTO sessions"));
	assert(fake.batches[0]!.statements[1]!.sql.includes("INSERT INTO session_entries"));
	assertEquals(session.getEntries()[0]!.id, id);
	assertEquals(session.getEntries()[0]!.timestamp.length > 0, true);
});

Deno.test("DatabaseSessionStore gates missing credentials in fromEnv", () => {
	const url = Deno.env.get("TURSO_DB_URL");
	const token = Deno.env.get("TURSO_DB_TOKEN");
	Deno.env.delete("TURSO_DB_URL");
	Deno.env.delete("TURSO_DB_TOKEN");
	try {
		let message = "";
		try {
			DatabaseSessionStore.fromEnv();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert(message.includes("TURSO_DB_URL and TURSO_DB_TOKEN"));
	} finally {
		if (url !== undefined) Deno.env.set("TURSO_DB_URL", url);
		if (token !== undefined) Deno.env.set("TURSO_DB_TOKEN", token);
	}
});
