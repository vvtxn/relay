import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";
import type { AuthenticatedUser, AuthIdentity, UserDirectory, UserStore } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	display_name TEXT,
	avatar_url TEXT
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

/** Additive migrations for databases created before profile columns existed. */
const MIGRATIONS = [
	"ALTER TABLE users ADD COLUMN display_name TEXT",
	"ALTER TABLE users ADD COLUMN avatar_url TEXT",
];

type QueryArgs = (string | null)[];
type Result = { rows: Record<string, unknown>[] };

function isConstraintViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : "";
	return code.startsWith("SQLITE_CONSTRAINT") || /constraint failed/i.test(error.message);
}

function isDuplicateColumn(error: unknown): boolean {
	return error instanceof Error && /duplicate column name/i.test(error.message);
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
	const name = optionalRowString(row, "display_name") ?? optionalRowString(row, "email");
	const avatarUrl = optionalRowString(row, "avatar_url");
	if (name) user.name = name;
	if (avatarUrl) user.avatarUrl = avatarUrl;
	return user;
}

/** Turso-backed mapping from provider identities to internal user IDs. */
export class DatabaseUserStore implements UserStore, UserDirectory {
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
			sql: `SELECT ai.user_id, ai.email, u.display_name, u.avatar_url
				FROM auth_identities ai
				LEFT JOIN users u ON u.id = ai.user_id
				WHERE ai.provider = ? AND ai.provider_subject = ?`,
			args: [identity.provider, identity.subject],
		});
		const row = existing.rows[0];
		if (row) {
			// Read columns directly: the Turso client returns rows as arrays with
			// non-enumerable named properties, so spreading would drop them.
			const userId = rowString(row, "user_id");
			await this.refreshProfile(userId, identity);
			return userFromRow({
				user_id: userId,
				email: row.email,
				display_name: identity.name ?? row.display_name,
				avatar_url: identity.avatarUrl ?? row.avatar_url,
			});
		}

		const userId = newId();
		const now = new Date().toISOString();
		try {
			const statements = [
				{
					sql: "INSERT INTO users (id, created_at, display_name, avatar_url) VALUES (?, ?, ?, ?)",
					args: [userId, now, identity.name ?? null, identity.avatarUrl ?? null],
				},
				{
					sql: `INSERT INTO auth_identities
						(user_id, provider, provider_subject, email, created_at) VALUES (?, ?, ?, ?, ?)`,
					args: [userId, identity.provider, identity.subject, identity.email ?? null, now],
				},
			];
			await this.client.batch(statements, "write");
			return userFromRow({
				user_id: userId,
				email: identity.email,
				display_name: identity.name,
				avatar_url: identity.avatarUrl,
			});
		} catch (error) {
			// Another client may have claimed the identity between our read and insert.
			if (!isConstraintViolation(error)) throw error;
			const raced = await this.execute({
				sql: `SELECT ai.user_id, ai.email, u.display_name, u.avatar_url
					FROM auth_identities ai
					LEFT JOIN users u ON u.id = ai.user_id
					WHERE ai.provider = ? AND ai.provider_subject = ?`,
				args: [identity.provider, identity.subject],
			});
			if (raced.rows[0]) return userFromRow(raced.rows[0]);
			throw error;
		}
	}

	async getById(id: string): Promise<AuthenticatedUser | null> {
		await this.schemaReady;
		const result = await this.execute({
			sql: `SELECT u.id AS user_id, u.display_name, u.avatar_url, ai.email, ai.provider
				FROM users u
				LEFT JOIN auth_identities ai ON ai.user_id = u.id
				WHERE u.id = ?
				LIMIT 1`,
			args: [id],
		});
		const row = result.rows[0];
		if (!row) return null;
		const user = userFromRow(row);
		const provider = optionalRowString(row, "provider");
		if (provider) user.provider = provider;
		return user;
	}

	/** Keep the stored profile fresh when the provider reports a new name or avatar. */
	private async refreshProfile(userId: string, identity: AuthIdentity): Promise<void> {
		if (!identity.name && !identity.avatarUrl) return;
		await this.client.execute({
			sql: "UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?",
			args: [identity.name ?? null, identity.avatarUrl ?? null, userId],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) await this.client.execute(sql);
		for (const sql of MIGRATIONS) {
			try {
				await this.client.execute(sql);
			} catch (error) {
				if (!isDuplicateColumn(error)) throw error;
			}
		}
	}

	private async execute(statement: { sql: string; args?: QueryArgs }): Promise<Result> {
		await this.schemaReady;
		return await this.client.execute(statement) as unknown as Result;
	}
}
