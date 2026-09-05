import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";
import type { Entry, NewEntry, SessionHandle, SessionScope, SessionStore, SessionSummary } from "./types.ts";
import { CURRENT_VERSION } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL,
	first_user_message TEXT,
	tokens INTEGER,
	cost REAL
);
CREATE INDEX IF NOT EXISTS sessions_owner_cwd_updated_idx
	ON sessions (owner_id, cwd, updated_at DESC);
CREATE TABLE IF NOT EXISTS session_entries (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	data TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS session_entries_session_seq_idx
	ON session_entries (session_id, seq);
`;

type QueryArgs = (string | number | null)[];
type Statement = { sql: string; args?: QueryArgs };
type Result = { rows: Record<string, unknown>[] };

export interface DatabaseSessionStoreOptions {
	url: string;
	authToken: string;
	client?: DatabaseClient;
}

function newId(): string {
	return crypto.randomUUID();
}

function stringValue(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`Invalid session row: ${key} is not a string`);
	return value;
}

function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
	const value = row[key];
	return typeof value === "number" ? value : undefined;
}

function rowToEntry(row: Record<string, unknown>): Entry {
	return JSON.parse(stringValue(row, "data")) as Entry;
}

export class DatabaseSessionStore implements SessionStore {
	private readonly client: DatabaseClient;
	private readonly schemaReady: Promise<void>;

	constructor(options: DatabaseSessionStoreOptions) {
		this.client = options.client ?? createDatabaseClient({ url: options.url, authToken: options.authToken });
		this.schemaReady = this.initialize();
	}

	static fromEnv(
		options: Omit<DatabaseSessionStoreOptions, "url" | "authToken" | "client"> = {},
	): DatabaseSessionStore {
		return new DatabaseSessionStore({ ...databaseCredentialsFromEnv(), ...options });
	}

	create(scope: SessionScope): SessionHandle {
		const now = new Date().toISOString();
		return new DatabaseSessionHandle(
			this,
			scope,
			{
				type: "session",
				version: CURRENT_VERSION,
				id: newId(),
				timestamp: now,
				cwd: scope.cwd,
			},
			[],
			false,
		);
	}

	async continueRecent(scope: SessionScope): Promise<SessionHandle | null> {
		const result = await this.execute({
			sql: `SELECT id FROM sessions
				WHERE owner_id = ? AND cwd = ?
				ORDER BY updated_at DESC LIMIT 1`,
			args: [scope.ownerId, scope.cwd],
		});
		const row = result.rows[0];
		return row ? await this.open(stringValue(row, "id"), scope.ownerId) : null;
	}

	async open(reference: string, ownerId: string): Promise<SessionHandle> {
		const sessionResult = await this.execute({
			sql: "SELECT * FROM sessions WHERE id = ? AND owner_id = ?",
			args: [reference, ownerId],
		});
		const row = sessionResult.rows[0];
		if (!row) throw new Error(`Session not found: ${reference}`);

		const entriesResult = await this.execute({
			sql: "SELECT data FROM session_entries WHERE session_id = ? ORDER BY seq ASC, entry_id ASC",
			args: [reference],
		});
		const header = {
			type: "session" as const,
			version: optionalNumber(row, "version") ?? CURRENT_VERSION,
			id: stringValue(row, "id"),
			timestamp: stringValue(row, "created_at"),
			cwd: stringValue(row, "cwd"),
			tokens: optionalNumber(row, "tokens"),
			cost: optionalNumber(row, "cost"),
		};
		return new DatabaseSessionHandle(
			this,
			{ ownerId, cwd: header.cwd },
			header,
			entriesResult.rows.map(rowToEntry),
			true,
		);
	}

	async listSummaries(scope: SessionScope): Promise<SessionSummary[]> {
		const result = await this.execute({
			sql: `SELECT id, created_at, first_user_message
				FROM sessions
				WHERE owner_id = ? AND cwd = ?
				ORDER BY updated_at DESC`,
			args: [scope.ownerId, scope.cwd],
		});
		return result.rows.map((row) => ({
			id: stringValue(row, "id"),
			reference: stringValue(row, "id"),
			timestamp: stringValue(row, "created_at"),
			firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : null,
		}));
	}

	async append(
		scope: SessionScope,
		header: DatabaseSessionHeader,
		entries: Entry[],
		entry: NewEntry,
		isNew: boolean,
	): Promise<{ id: string; timestamp: string }> {
		await this.schemaReady;
		const id = newId();
		const timestamp = new Date().toISOString();
		const full = { ...entry, id, timestamp } as Entry;
		const statements: Statement[] = [];
		if (isNew) {
			statements.push({
				sql: `INSERT INTO sessions
					(id, owner_id, cwd, created_at, updated_at, version, first_user_message, tokens, cost)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					header.id,
					scope.ownerId,
					scope.cwd,
					header.timestamp,
					full.timestamp,
					header.version,
					full.type === "message" && full.role === "user" ? full.content : null,
					header.tokens ?? null,
					header.cost ?? null,
				],
			});
		} else {
			statements.push({
				sql: "UPDATE sessions SET updated_at = ?, tokens = ?, cost = ? WHERE id = ? AND owner_id = ?",
				args: [full.timestamp, header.tokens ?? null, header.cost ?? null, header.id, scope.ownerId],
			});
			if (full.type === "message" && full.role === "user") {
				statements.push({
					sql: "UPDATE sessions SET first_user_message = COALESCE(first_user_message, ?) WHERE id = ?",
					args: [full.content, header.id],
				});
			}
		}
		statements.push({
			sql: `INSERT INTO session_entries (session_id, seq, entry_id, type, timestamp, data)
			VALUES (?, ?, ?, ?, ?, ?)`,
			args: [header.id, entries.length + 1, id, full.type, full.timestamp, JSON.stringify(full)],
		});
		await this.client.batch(statements, "write");
		return { id, timestamp };
	}

	async updateHeader(scope: SessionScope, header: DatabaseSessionHeader): Promise<void> {
		await this.schemaReady;
		await this.execute({
			sql: "UPDATE sessions SET tokens = ?, cost = ? WHERE id = ? AND owner_id = ?",
			args: [header.tokens ?? null, header.cost ?? null, header.id, scope.ownerId],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
			await this.client.execute(sql);
		}
	}

	private async execute(statement: Statement): Promise<Result> {
		await this.schemaReady;
		return await this.client.execute(statement) as unknown as Result;
	}
}

type DatabaseSessionHeader = {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	tokens?: number;
	cost?: number;
};

class DatabaseSessionHandle implements SessionHandle {
	private headerDirty = false;
	private appendQueue = Promise.resolve();

	constructor(
		private readonly store: DatabaseSessionStore,
		private readonly scope: SessionScope,
		private readonly header: DatabaseSessionHeader,
		private readonly entries: Entry[],
		private persisted: boolean,
	) {}

	async append(entry: NewEntry): Promise<string> {
		let id = "";
		const operation = this.appendQueue.then(async () => {
			const result = await this.store.append(this.scope, this.header, this.entries, entry, !this.persisted);
			id = result.id;
			this.entries.push({ ...entry, id: result.id, timestamp: result.timestamp } as Entry);
			this.persisted = true;
			this.headerDirty = false;
		});
		this.appendQueue = operation.catch(() => {});
		await operation;
		return id;
	}

	getEntries(): Entry[] {
		return this.entries;
	}

	getHeader(): DatabaseSessionHeader {
		return this.header;
	}

	getTokens(): number {
		return this.header.tokens ?? 0;
	}

	setTokens(tokens: number): void {
		this.header.tokens = tokens;
		this.headerDirty = true;
	}

	getCost(): number {
		return this.header.cost ?? 0;
	}

	setCost(cost: number): void {
		this.header.cost = cost;
		this.headerDirty = true;
	}

	async flush(): Promise<void> {
		await this.appendQueue;
		if (!this.persisted || !this.headerDirty) return;
		await this.store.updateHeader(this.scope, this.header);
		this.headerDirty = false;
	}
}
