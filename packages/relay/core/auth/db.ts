import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";
import type { AuthenticatedUser, AuthIdentity, UserStore } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_identities (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	provider TEXT NOT NULL,
	provider_subject TEXT NOT NULL,
	email TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id);
`;

type QueryArgs = (string | null)[];
type Result = { rows: Record<string, unknown>[] };

function isConstraintViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : "";
	return code.startsWith("SQLITE_CONSTRAINT") || /constraint failed/i.test(error.message);
}

export interface DatabaseUserStoreOptions {
	url: string;
	authToken: string;
	client?: DatabaseClient;
}

function newId(): string {
	return crypto.randomUUID();
}

function rowString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`Invalid auth row: ${key} is not a string`);
	return value;
}

function optionalRowString(row: Record<string, unknown>, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function userFromRow(row: Record<string, unknown>): AuthenticatedUser {
	const user: AuthenticatedUser = { id: rowString(row, "user_id") };
	const email = optionalRowString(row, "email");
	if (email) user.name = email;
	return user;
}

/** Turso-backed mapping from provider identities to internal user IDs. */
export class DatabaseUserStore implements UserStore {
	private readonly client: DatabaseClient;
	private readonly schemaReady: Promise<void>;

	constructor(options: DatabaseUserStoreOptions) {
		this.client = options.client ?? createDatabaseClient({ url: options.url, authToken: options.authToken });
		this.schemaReady = this.initialize();
	}

	static fromEnv(options: Omit<DatabaseUserStoreOptions, "url" | "authToken" | "client"> = {}): DatabaseUserStore {
		return new DatabaseUserStore({ ...databaseCredentialsFromEnv(), ...options });
	}

	async resolve(identity: AuthIdentity): Promise<AuthenticatedUser> {
		await this.schemaReady;
		const existing = await this.execute({
			sql: "SELECT user_id, email FROM auth_identities WHERE provider = ? AND provider_subject = ?",
			args: [identity.provider, identity.subject],
		});
		if (existing.rows[0]) return userFromRow(existing.rows[0]);

		const userId = newId();
		const now = new Date().toISOString();
		try {
			const statements = [
				{ sql: "INSERT INTO users (id, created_at) VALUES (?, ?)", args: [userId, now] },
				{
					sql: `INSERT INTO auth_identities
						(user_id, provider, provider_subject, email, created_at) VALUES (?, ?, ?, ?, ?)`,
					args: [userId, identity.provider, identity.subject, identity.email ?? null, now],
				},
			];
			await this.client.batch(statements, "write");
			const user: AuthenticatedUser = { id: userId };
			if (identity.email) user.name = identity.email;
			return user;
		} catch (error) {
			// Another client may have claimed the identity between our read and insert.
			if (!isConstraintViolation(error)) throw error;
			const raced = await this.execute({
				sql: "SELECT user_id, email FROM auth_identities WHERE provider = ? AND provider_subject = ?",
				args: [identity.provider, identity.subject],
			});
			if (raced.rows[0]) return userFromRow(raced.rows[0]);
			throw error;
		}
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) await this.client.execute(sql);
	}

	private async execute(statement: { sql: string; args?: QueryArgs }): Promise<Result> {
		await this.schemaReady;
		return await this.client.execute(statement) as unknown as Result;
	}
}
