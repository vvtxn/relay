import { assertEquals } from "@std/assert";
import { DatabaseAuthSessionStore, type DatabaseAuthSessionStoreOptions } from "@/core/auth/sessions.ts";

type Statement = { sql: string; args?: unknown[] };

class FakeSessionClient {
	readonly sessions = new Map<string, { userId: string; expiresAt: string; lastSeenAt: string | null }>();

	execute(statement: string | Statement): Promise<{ rows: Record<string, unknown>[] }> {
		if (typeof statement === "string") return Promise.resolve({ rows: [] });
		const { sql } = statement;
		const args = (statement.args ?? []) as (string | null)[];

		if (sql.startsWith("INSERT INTO auth_sessions")) {
			this.sessions.set(String(args[0]), {
				userId: String(args[1]),
				expiresAt: String(args[3]),
				lastSeenAt: (args[4] as string | null) ?? null,
			});
			return Promise.resolve({ rows: [] });
		}
		if (sql.startsWith("SELECT user_id, expires_at FROM auth_sessions")) {
			const session = this.sessions.get(String(args[0]));
			return Promise.resolve({
				rows: session ? [{ user_id: session.userId, expires_at: session.expiresAt }] : [],
			});
		}
		if (sql.startsWith("UPDATE auth_sessions")) {
			const session = this.sessions.get(String(args[2]));
			if (session) {
				session.lastSeenAt = String(args[0]);
				session.expiresAt = String(args[1]);
			}
			return Promise.resolve({ rows: [] });
		}
		if (sql.startsWith("DELETE FROM auth_sessions WHERE token_hash")) {
			this.sessions.delete(String(args[0]));
			return Promise.resolve({ rows: [] });
		}
		if (sql.startsWith("DELETE FROM auth_sessions WHERE expires_at")) {
			const cutoff = Date.parse(String(args[0]));
			for (const [key, value] of this.sessions) {
				if (Date.parse(value.expiresAt) <= cutoff) this.sessions.delete(key);
			}
			return Promise.resolve({ rows: [] });
		}
		if (sql.startsWith("DELETE FROM auth_sessions WHERE user_id")) {
			for (const [key, value] of this.sessions) {
				if (value.userId === args[0]) this.sessions.delete(key);
			}
			return Promise.resolve({ rows: [] });
		}
		return Promise.resolve({ rows: [] });
	}
}

function storeWith(client: FakeSessionClient): DatabaseAuthSessionStore {
	const options: DatabaseAuthSessionStoreOptions = {
		url: "turso://example",
		authToken: "test-token",
		client: client as unknown as NonNullable<DatabaseAuthSessionStoreOptions["client"]>,
	};
	return new DatabaseAuthSessionStore(options);
}

Deno.test("auth sessions - create returns a token and resolves to the user", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	const { token, expiresAt } = await store.create("user-1", 60_000);

	assertEquals(typeof token, "string");
	assertEquals(token.length > 20, true);
	// The raw token is never stored.
	assertEquals(client.sessions.has(token), false);

	const session = await store.resolve(token);
	assertEquals(session?.userId, "user-1");
	assertEquals(session?.expiresAt, expiresAt);
});

Deno.test("auth sessions - unknown tokens resolve to null", async () => {
	const store = storeWith(new FakeSessionClient());
	assertEquals(await store.resolve("nope"), null);
});

Deno.test("auth sessions - expired tokens resolve to null and are removed", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	const { token } = await store.create("user-1", -1_000);

	assertEquals(await store.resolve(token), null);
	assertEquals(client.sessions.size, 0);
});

Deno.test("auth sessions - resolve slides the expiry forward", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	const { token, expiresAt } = await store.create("user-1", 1_000);

	const session = await store.resolve(token, 60_000);
	assertEquals(session?.userId, "user-1");
	assertEquals(Date.parse(session!.expiresAt) > Date.parse(expiresAt), true);
});

Deno.test("auth sessions - revoke removes a single token", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	const { token } = await store.create("user-1", 60_000);

	await store.revoke(token);
	assertEquals(await store.resolve(token), null);
});

Deno.test("auth sessions - revokeAllForUser removes every session for the user", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	const a = await store.create("user-1", 60_000);
	const b = await store.create("user-1", 60_000);
	const other = await store.create("user-2", 60_000);

	await store.revokeAllForUser("user-1");
	assertEquals(await store.resolve(a.token), null);
	assertEquals(await store.resolve(b.token), null);
	assertEquals((await store.resolve(other.token))?.userId, "user-2");
});

Deno.test("auth sessions - create prunes expired sessions", async () => {
	const client = new FakeSessionClient();
	const store = storeWith(client);
	client.sessions.set("old-hash", {
		userId: "user-1",
		expiresAt: new Date(Date.now() - 1_000).toISOString(),
		lastSeenAt: null,
	});

	await store.create("user-2", 60_000);

	assertEquals(client.sessions.has("old-hash"), false);
	assertEquals(client.sessions.size, 1);
});
