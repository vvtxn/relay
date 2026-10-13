import type { Effect } from "effect";
import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";
import { storeEffect, type StoreError } from "../effect.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
`;

/** A resolved session: which user it belongs to and when it expires. */
export interface AuthSession {
	userId: string;
	expiresAt: string;
}

/**
 * Opaque session tokens. The raw token is only ever returned to the client;
 * the database stores a SHA-256 hash so a leaked database cannot be replayed.
 */
export interface AuthSessionStore {
	create(userId: string, ttlMs: number): Effect.Effect<{ token: string; expiresAt: string }, StoreError>;
	/** Resolve a token; when `extendMs` is given the expiry slides forward. */
	resolve(token: string, extendMs?: number): Effect.Effect<AuthSession | null, StoreError>;
	revoke(token: string): Effect.Effect<void, StoreError>;
	revokeAllForUser(userId: string): Effect.Effect<void, StoreError>;
}

export interface DatabaseAuthSessionStoreOptions {
	url: string;
	authToken: string;
	client?: DatabaseClient;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return toHex(new Uint8Array(digest));
}

function rowString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`Invalid session row: ${key} is not a string`);
	return value;
}

export class DatabaseAuthSessionStore implements AuthSessionStore {
	private readonly client: DatabaseClient;
	private readonly schemaReady: Promise<void>;

	constructor(options: DatabaseAuthSessionStoreOptions) {
		this.client = options.client ?? createDatabaseClient({ url: options.url, authToken: options.authToken });
		this.schemaReady = this.initialize();
	}

	/** Resolves once the store's schema has been initialized. */
	get ready(): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.schemaReady);
	}

	static fromEnv(
		options: Omit<DatabaseAuthSessionStoreOptions, "url" | "authToken" | "client"> = {},
	): DatabaseAuthSessionStore {
		return new DatabaseAuthSessionStore({ ...databaseCredentialsFromEnv(), ...options });
	}

	create(userId: string, ttlMs: number): Effect.Effect<{ token: string; expiresAt: string }, StoreError> {
		return storeEffect(() => this.createPromise(userId, ttlMs));
	}

	private async createPromise(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
		await this.schemaReady;
		const token = generateToken();
		const tokenHash = await hashToken(token);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
		await this.client.execute({
			sql: `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
				VALUES (?, ?, ?, ?, ?)`,
			args: [tokenHash, userId, now.toISOString(), expiresAt, now.toISOString()],
		});
		// Opportunistically prune expired sessions so the table stays bounded.
		await this.client.execute({
			sql: "DELETE FROM auth_sessions WHERE expires_at <= ?",
			args: [now.toISOString()],
		});
		return { token, expiresAt };
	}

	resolve(token: string, extendMs?: number): Effect.Effect<AuthSession | null, StoreError> {
		return storeEffect(() => this.resolvePromise(token, extendMs));
	}

	private async resolvePromise(token: string, extendMs?: number): Promise<AuthSession | null> {
		await this.schemaReady;
		const tokenHash = await hashToken(token);
		const result = (await this.client.execute({
			sql: "SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?",
			args: [tokenHash],
		})) as unknown as { rows: Record<string, unknown>[] };
		const row = result.rows[0];
		if (!row) return null;

		const expiresAt = rowString(row, "expires_at");
		if (Date.parse(expiresAt) <= Date.now()) {
			await this.revokePromise(token);
			return null;
		}

		const now = new Date();
		const nextExpiry = extendMs ? new Date(now.getTime() + extendMs).toISOString() : expiresAt;
		await this.client.execute({
			sql: "UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
			args: [now.toISOString(), nextExpiry, tokenHash],
		});
		return { userId: rowString(row, "user_id"), expiresAt: nextExpiry };
	}

	revoke(token: string): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.revokePromise(token));
	}

	private async revokePromise(token: string): Promise<void> {
		await this.schemaReady;
		const tokenHash = await hashToken(token);
		await this.client.execute({
			sql: "DELETE FROM auth_sessions WHERE token_hash = ?",
			args: [tokenHash],
		});
	}

	revokeAllForUser(userId: string): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.revokeAllForUserPromise(userId));
	}

	private async revokeAllForUserPromise(userId: string): Promise<void> {
		await this.schemaReady;
		await this.client.execute({
			sql: "DELETE FROM auth_sessions WHERE user_id = ?",
			args: [userId],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";")
			.map((part) => part.trim())
			.filter(Boolean))
			await this.client.execute(sql);
	}
}
