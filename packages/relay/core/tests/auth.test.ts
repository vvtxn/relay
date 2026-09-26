import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseUserStore, type DatabaseUserStoreOptions } from "@/core/auth/db.ts";
import { GitHubAuthProvider } from "@/core/auth/github.ts";
import { authenticate } from "@/core/auth/service.ts";
import type { AuthIdentity } from "@/core/auth/types.ts";

Deno.test("GitHubAuthProvider uses the stable GitHub profile ID", async () => {
	const provider = new GitHubAuthProvider();
	assertEquals(await provider.authenticate({ id: 12345, email: "dev@example.com" }), {
		provider: "github",
		subject: "12345",
		email: "dev@example.com",
	});
});

Deno.test("GitHubAuthProvider maps name and avatar, preferring the profile name", async () => {
	const provider = new GitHubAuthProvider();
	assertEquals(
		await provider.authenticate({ id: 1, login: "octocat", name: "The Octocat", avatar_url: "https://avatars/1" }),
		{
			provider: "github",
			subject: "1",
			name: "The Octocat",
			avatarUrl: "https://avatars/1",
		},
	);
});

Deno.test("GitHubAuthProvider falls back to the login for the display name", async () => {
	const provider = new GitHubAuthProvider();
	assertEquals(await provider.authenticate({ id: 1, login: "octocat", name: "   " }), {
		provider: "github",
		subject: "1",
		name: "octocat",
	});
});

Deno.test("GitHubAuthProvider rejects a missing profile ID", () => {
	assertThrows(() => new GitHubAuthProvider().authenticate({}), Error, "profile ID");
});

Deno.test("authenticate resolves an identity through the user store", async () => {
	let received: AuthIdentity | undefined;
	const provider = {
		authenticate: () => Promise.resolve({ provider: "github", subject: "12345", email: "dev@example.com" }),
	};
	const user = await authenticate(provider, undefined, {
		resolve(identity) {
			received = identity;
			return Promise.resolve({ id: "internal-user-id" });
		},
	});
	assertEquals(received, { provider: "github", subject: "12345", email: "dev@example.com" });
	assertEquals(user, { id: "internal-user-id", name: "dev@example.com", provider: "github" });
});

Deno.test("authenticate prefers the identity email as the display name", async () => {
	const user = await authenticate(new GitHubAuthProvider(), { id: 12345, email: "dev@example.com" }, {
		resolve: () => Promise.resolve({ id: "internal-user-id" }),
	});
	assertEquals(user.name, "dev@example.com");
});

Deno.test("authenticate prefers the identity name over its email", async () => {
	const user = await authenticate(
		new GitHubAuthProvider(),
		{ id: 12345, name: "Octo", email: "octo@example.com", avatar_url: "https://avatars/1" },
		{ resolve: () => Promise.resolve({ id: "internal-user-id" }) },
	);
	assertEquals(user.name, "Octo");
	assertEquals(user.avatarUrl, "https://avatars/1");
});

Deno.test("authenticate falls back to the subject when no email is available", async () => {
	const user = await authenticate(new GitHubAuthProvider(), { id: 12345 }, {
		resolve: () => Promise.resolve({ id: "internal-user-id" }),
	});
	assertEquals(user.name, "12345");
});

Deno.test("authenticate prefers the name stored on the user record", async () => {
	const user = await authenticate(new GitHubAuthProvider(), { id: 12345, email: "identity@example.com" }, {
		resolve: () => Promise.resolve({ id: "internal-user-id", name: "stored@example.com" }),
	});
	assertEquals(user.name, "stored@example.com");
});

Deno.test("authenticate treats an empty stored name as missing", async () => {
	const user = await authenticate(new GitHubAuthProvider(), { id: 12345 }, {
		resolve: () => Promise.resolve({ id: "internal-user-id", name: "" }),
	});
	assertEquals(user.name, "12345");
});

type Statement = { sql: string; args?: unknown[] };
type IdentityRecord = { userId: string; email: string | null };
type UserRecord = { id: string; displayName: string | null; avatarUrl: string | null; email: string | null };

/**
 * The Turso client returns rows as arrays with non-enumerable named
 * properties, so the fake mirrors that shape.
 */
function arrayRow(values: Record<string, unknown>): Record<string, unknown> {
	const row: unknown[] = [];
	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(row, key, { value, enumerable: false, configurable: true });
	}
	return row as unknown as Record<string, unknown>;
}

class FakeUserClient {
	private readonly identities = new Map<string, IdentityRecord>();
	private readonly users = new Map<string, UserRecord>();
	private nextBatchError: Error | undefined;
	private racedUser: IdentityRecord | undefined;

	setBatchError(error: Error): void {
		this.nextBatchError = error;
	}

	setRacedUser(id: string): void {
		this.racedUser = { userId: id, email: null };
	}

	execute(statement: string | Statement): Promise<{ rows: Record<string, unknown>[] }> {
		if (typeof statement === "string") return Promise.resolve({ rows: [] });
		const { sql } = statement;
		const args = statement.args ?? [];

		if (sql.includes("FROM auth_identities")) {
			const record = this.identities.get(`${args[0]}:${args[1]}`) ?? this.racedUser;
			if (!record) return Promise.resolve({ rows: [] });
			return Promise.resolve({ rows: [this.identityRow(record)] });
		}
		if (sql.includes("FROM users u")) {
			const user = this.users.get(String(args[0]));
			return Promise.resolve({ rows: user ? [this.userRow(user)] : [] });
		}
		if (sql.startsWith("UPDATE users")) {
			const user = this.users.get(String(args[2]));
			if (user) {
				if (typeof args[0] === "string") user.displayName = args[0];
				if (typeof args[1] === "string") user.avatarUrl = args[1];
			}
			return Promise.resolve({ rows: [] });
		}
		return Promise.resolve({ rows: [] });
	}

	batch(statements: Statement[]): Promise<void> {
		if (this.nextBatchError) {
			const error = this.nextBatchError;
			this.nextBatchError = undefined;
			return Promise.reject(error);
		}
		const userArgs = statements[0]!.args ?? [];
		const identityArgs = statements[1]!.args ?? [];
		const userId = String(identityArgs[0]);
		const email = typeof identityArgs[3] === "string" ? identityArgs[3] : null;
		this.users.set(userId, {
			id: userId,
			displayName: typeof userArgs[2] === "string" ? userArgs[2] : null,
			avatarUrl: typeof userArgs[3] === "string" ? userArgs[3] : null,
			email,
		});
		this.identities.set(`${identityArgs[1]}:${identityArgs[2]}`, { userId, email });
		return Promise.resolve();
	}

	private identityRow(record: IdentityRecord): Record<string, unknown> {
		const row: Record<string, unknown> = { user_id: record.userId };
		if (record.email) row.email = record.email;
		const user = this.users.get(record.userId);
		if (user?.displayName) row.display_name = user.displayName;
		if (user?.avatarUrl) row.avatar_url = user.avatarUrl;
		return arrayRow(row);
	}

	private userRow(user: UserRecord): Record<string, unknown> {
		const row: Record<string, unknown> = { user_id: user.id };
		if (user.displayName) row.display_name = user.displayName;
		if (user.avatarUrl) row.avatar_url = user.avatarUrl;
		if (user.email) row.email = user.email;
		return arrayRow(row);
	}
}

function userStoreWithFake(client: FakeUserClient): DatabaseUserStore {
	const options: DatabaseUserStoreOptions = {
		url: "turso://example",
		authToken: "test-token",
		client: client as unknown as NonNullable<DatabaseUserStoreOptions["client"]>,
	};
	return new DatabaseUserStore(options);
}

Deno.test("DatabaseUserStore resolves existing identities and creates new users", async () => {
	const store = userStoreWithFake(new FakeUserClient());
	const identity = { provider: "local", subject: "dev-user" };

	const first = await store.resolve(identity);
	const second = await store.resolve(identity);

	assertEquals(second, first);
});

Deno.test("DatabaseUserStore returns the stored email as the display name", async () => {
	const store = userStoreWithFake(new FakeUserClient());
	const identity = { provider: "github", subject: "123", email: "dev@example.com" };

	const created = await store.resolve(identity);
	const resolved = await store.resolve({ ...identity, email: "changed@example.com" });

	assertEquals(created, { id: created.id, name: "dev@example.com" });
	assertEquals(resolved, { id: created.id, name: "dev@example.com" });
});

Deno.test("DatabaseUserStore recovers when another client wins the identity race", async () => {
	const client = new FakeUserClient();
	client.setBatchError(Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }));
	client.setRacedUser("winner");
	const store = userStoreWithFake(client);

	assertEquals(await store.resolve({ provider: "github", subject: "123" }), { id: "winner" });
});

Deno.test("DatabaseUserStore propagates non-constraint batch failures", async () => {
	const client = new FakeUserClient();
	client.setBatchError(new Error("database unavailable"));
	const store = userStoreWithFake(client);

	await assertRejects(
		() => store.resolve({ provider: "local", subject: "dev-user" }),
		Error,
		"database unavailable",
	);
});

Deno.test("DatabaseUserStore stores and returns the provider display name and avatar", async () => {
	const store = userStoreWithFake(new FakeUserClient());
	const identity = { provider: "github", subject: "123", name: "Octo", avatarUrl: "https://avatars/1" };

	const created = await store.resolve(identity);
	const resolved = await store.resolve(identity);

	assertEquals(created, { id: created.id, name: "Octo", avatarUrl: "https://avatars/1" });
	assertEquals(resolved, created);
});

Deno.test("DatabaseUserStore.getById restores a user for a session", async () => {
	const store = userStoreWithFake(new FakeUserClient());
	const created = await store.resolve({
		provider: "github",
		subject: "123",
		name: "Octo",
		email: "octo@example.com",
	});

	assertEquals(await store.getById(created.id), { id: created.id, name: "Octo" });
	assertEquals(await store.getById("missing"), null);
});
