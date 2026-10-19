import type { Effect } from "effect";
import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";
import { storeEffect, type StoreError } from "../effect.ts";
import type {
	Entry,
	NewEntry,
	SessionHandle,
	SessionScope,
	SessionStore,
	SessionSummary,
	WorkspaceSummary,
} from "./types.ts";
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
CREATE TABLE IF NOT EXISTS workspaces (
	owner_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, cwd)
);
CREATE TABLE IF NOT EXISTS hidden_workspaces (
	owner_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	hidden_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, cwd)
);
`;

type QueryArgs = (string | number | null)[];
type Statement = { sql: string; args?: QueryArgs };
type Result = { rows: Record<string, unknown>[] };

export interface DatabaseSessionStoreOptions {
	url: string;
	authToken: string;
	client?: DatabaseClient;
	/** Maximum persisted sessions kept per owner and workspace (default 10). */
	maxSessionsPerWorkspace?: number;
}

const DEFAULT_MAX_SESSIONS_PER_WORKSPACE = 10;

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
	private readonly maxSessionsPerWorkspace: number;

	constructor(options: DatabaseSessionStoreOptions) {
		this.client = options.client ?? createDatabaseClient({ url: options.url, authToken: options.authToken });
		const maxSessions = options.maxSessionsPerWorkspace ?? DEFAULT_MAX_SESSIONS_PER_WORKSPACE;
		if (!Number.isInteger(maxSessions) || maxSessions < 1) {
			throw new Error("maxSessionsPerWorkspace must be a positive integer");
		}
		this.maxSessionsPerWorkspace = maxSessions;
		this.schemaReady = this.initialize();
	}

	/** Resolves once the store's schema has been initialized. */
	get ready(): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.schemaReady);
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

	continueRecent(scope: SessionScope): Effect.Effect<SessionHandle | null, StoreError> {
		return storeEffect(() => this.continueRecentPromise(scope));
	}

	private async continueRecentPromise(scope: SessionScope): Promise<SessionHandle | null> {
		const result = await this.execute({
			sql: `SELECT id FROM sessions
				WHERE owner_id = ? AND cwd = ?
				ORDER BY updated_at DESC LIMIT 1`,
			args: [scope.ownerId, scope.cwd],
		});
		const row = result.rows[0];
		return row ? await this.openPromise(stringValue(row, "id"), scope.ownerId) : null;
	}

	open(reference: string, ownerId: string): Effect.Effect<SessionHandle, StoreError> {
		return storeEffect(() => this.openPromise(reference, ownerId));
	}

	private async openPromise(reference: string, ownerId: string): Promise<SessionHandle> {
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
		const tokens = optionalNumber(row, "tokens");
		const cost = optionalNumber(row, "cost");
		const header = {
			type: "session" as const,
			version: optionalNumber(row, "version") ?? CURRENT_VERSION,
			id: stringValue(row, "id"),
			timestamp: stringValue(row, "created_at"),
			cwd: stringValue(row, "cwd"),
			...(tokens !== undefined ? { tokens } : {}),
			...(cost !== undefined ? { cost } : {}),
		};
		return new DatabaseSessionHandle(
			this,
			{ ownerId, cwd: header.cwd },
			header,
			entriesResult.rows.map(rowToEntry),
			true,
		);
	}

	listSummaries(scope: SessionScope): Effect.Effect<SessionSummary[], StoreError> {
		return storeEffect(() => this.listSummariesPromise(scope));
	}

	private async listSummariesPromise(scope: SessionScope): Promise<SessionSummary[]> {
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

	/** Distinct workspaces (registered + session cwds) for a user, most recently active first. */
	listWorkspaces(ownerId: string): Effect.Effect<WorkspaceSummary[], StoreError> {
		return storeEffect(() => this.listWorkspacesPromise(ownerId));
	}

	private async listWorkspacesPromise(ownerId: string): Promise<WorkspaceSummary[]> {
		const result = await this.execute({
			// Order by the selected alias: Turso's engine rejects ORDER BY MAX(...)
			// here ("misuse of aggregate function MAX()").
			sql: `SELECT cwd, COALESCE(SUM(session_count), 0) AS session_count, MAX(last_activity) AS last_activity
				FROM (
					SELECT cwd, 0 AS session_count, created_at AS last_activity
					FROM workspaces
					WHERE owner_id = ?
					UNION ALL
					SELECT cwd, COUNT(*) AS session_count, MAX(updated_at) AS last_activity
					FROM sessions
					WHERE owner_id = ?
					GROUP BY cwd
				)
				WHERE cwd NOT IN (SELECT cwd FROM hidden_workspaces WHERE owner_id = ?)
				GROUP BY cwd
				ORDER BY last_activity DESC`,
			args: [ownerId, ownerId, ownerId],
		});
		return result.rows.map((row) => ({
			cwd: stringValue(row, "cwd"),
			sessionCount: Number(row.session_count ?? 0),
			lastActivity: typeof row.last_activity === "string" ? row.last_activity : "",
		}));
	}

	/**
	 * True when the workspace has been hidden (removed) for this owner. Hidden
	 * workspaces stay out of the picker until re-registered or a new session is
	 * created in them, even though their sessions remain reachable.
	 */
	isWorkspaceHidden(scope: SessionScope): Effect.Effect<boolean, StoreError> {
		return storeEffect(() => this.isWorkspaceHiddenPromise(scope));
	}

	/**
	 * Every persisted session id, used to garbage-collect session-scoped box
	 * workspaces at startup. Session rows for a workspace are bounded by the
	 * per-workspace limit; a box with no surviving session is orphaned.
	 */
	allSessionIds(): Effect.Effect<ReadonlySet<string>, StoreError> {
		return storeEffect(async () => {
			const result = await this.execute({ sql: "SELECT id FROM sessions", args: [] });
			return new Set(result.rows.map((row) => stringValue(row, "id")));
		});
	}

	/**
	 * Trims every owner/workspace that exceeds the session limit. Intended for
	 * startup, before runs can be active; returns the number of sessions removed.
	 */
	pruneAll(): Effect.Effect<number, StoreError> {
		return storeEffect(() => this.pruneAllPromise());
	}

	private async pruneAllPromise(): Promise<number> {
		const result = await this.execute({
			// Count in a derived table so the engine never has to order by or
			// filter an aggregate expression (Turso rejects some of those forms).
			sql: `SELECT owner_id, cwd FROM (
				SELECT owner_id, cwd, COUNT(*) AS session_count
				FROM sessions
				GROUP BY owner_id, cwd
			) WHERE session_count > ?`,
			args: [this.maxSessionsPerWorkspace],
		});
		let removed = 0;
		for (const row of result.rows) {
			removed += await this.pruneScopePromise({
				ownerId: stringValue(row, "owner_id"),
				cwd: stringValue(row, "cwd"),
			});
		}
		return removed;
	}

	private async pruneScopePromise(scope: SessionScope): Promise<number> {
		await this.schemaReady;
		const statements = this.pruneStatements(scope);
		if (statements.length === 0) return 0;
		const results = await this.client.batch(statements, "write");
		return results[1]?.rowsAffected ?? 0;
	}

	/**
	 * Deletes all but the newest sessions for a workspace. When `keepId` is set
	 * that session is never deleted and counts against the configured limit.
	 */
	private pruneStatements(scope: SessionScope, keepId?: string): Statement[] {
		const offset = this.maxSessionsPerWorkspace - (keepId === undefined ? 0 : 1);
		const exclude = keepId === undefined ? "" : " AND id <> ?";
		const args: QueryArgs =
			keepId === undefined ? [scope.ownerId, scope.cwd, offset] : [scope.ownerId, scope.cwd, keepId, offset];
		const doomed = `SELECT id FROM sessions
			WHERE owner_id = ? AND cwd = ?${exclude}
			ORDER BY updated_at DESC, created_at DESC, id DESC
			LIMIT -1 OFFSET ?`;
		return [
			{ sql: `DELETE FROM session_entries WHERE session_id IN (${doomed})`, args },
			{ sql: `DELETE FROM sessions WHERE id IN (${doomed})`, args },
		];
	}

	private async isWorkspaceHiddenPromise(scope: SessionScope): Promise<boolean> {
		const result = await this.execute({
			sql: "SELECT 1 FROM hidden_workspaces WHERE owner_id = ? AND cwd = ? LIMIT 1",
			args: [scope.ownerId, scope.cwd],
		});
		return result.rows.length > 0;
	}

	/**
	 * Records a workspace so it appears in the picker before its first session.
	 * Idempotent — re-registering an existing workspace is a no-op. Also clears
	 * any hidden marker, so adding a workspace back restores it.
	 */
	registerWorkspace(scope: SessionScope): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.registerWorkspacePromise(scope));
	}

	private async registerWorkspacePromise(scope: SessionScope): Promise<void> {
		await this.schemaReady;
		await this.client.batch(
			[
				{
					sql: "INSERT OR IGNORE INTO workspaces (owner_id, cwd, created_at) VALUES (?, ?, ?)",
					args: [scope.ownerId, scope.cwd, new Date().toISOString()],
				},
				{
					sql: "DELETE FROM hidden_workspaces WHERE owner_id = ? AND cwd = ?",
					args: [scope.ownerId, scope.cwd],
				},
			],
			"write",
		);
	}

	/**
	 * Hides a workspace registration. Sessions for that cwd are left intact and
	 * stay reachable by URL; the workspace reappears once it is re-registered or
	 * a new session is created in it.
	 */
	unregisterWorkspace(scope: SessionScope): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.unregisterWorkspacePromise(scope));
	}

	private async unregisterWorkspacePromise(scope: SessionScope): Promise<void> {
		await this.schemaReady;
		await this.client.batch(
			[
				{
					sql: "DELETE FROM workspaces WHERE owner_id = ? AND cwd = ?",
					args: [scope.ownerId, scope.cwd],
				},
				{
					sql: "INSERT OR REPLACE INTO hidden_workspaces (owner_id, cwd, hidden_at) VALUES (?, ?, ?)",
					args: [scope.ownerId, scope.cwd, new Date().toISOString()],
				},
			],
			"write",
		);
	}

	/** @internal Persistence primitive used by the session handle. */
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
		// A user message is the point where a lazily-created session becomes a
		// cloud row. Prune in the same atomic batch so a workspace never
		// observably exceeds the configured limit.
		if (full.type === "message" && full.role === "user") {
			statements.push(...this.pruneStatements(scope, header.id));
		}
		await this.client.batch(statements, "write");
		return { id, timestamp };
	}

	/** @internal Persistence primitive used by the session handle. */
	async updateHeader(scope: SessionScope, header: DatabaseSessionHeader): Promise<void> {
		await this.schemaReady;
		await this.execute({
			sql: "UPDATE sessions SET tokens = ?, cost = ? WHERE id = ? AND owner_id = ?",
			args: [header.tokens ?? null, header.cost ?? null, header.id, scope.ownerId],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";")
			.map((part) => part.trim())
			.filter(Boolean)) {
			await this.client.execute(sql);
		}
	}

	private async execute(statement: Statement): Promise<Result> {
		await this.schemaReady;
		return (await this.client.execute(statement)) as unknown as Result;
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
	private readonly store: DatabaseSessionStore;
	private readonly scope: SessionScope;
	private readonly header: DatabaseSessionHeader;
	private readonly entries: Entry[];
	private persisted: boolean;

	constructor(
		store: DatabaseSessionStore,
		scope: SessionScope,
		header: DatabaseSessionHeader,
		entries: Entry[],
		persisted: boolean,
	) {
		this.store = store;
		this.scope = scope;
		this.header = header;
		this.entries = entries;
		this.persisted = persisted;
	}

	append(entry: NewEntry): Effect.Effect<string, StoreError> {
		return storeEffect(() => this.appendQueued(entry));
	}

	private async appendQueued(entry: NewEntry): Promise<string> {
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

	flush(): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.flushQueued());
	}

	private async flushQueued(): Promise<void> {
		await this.appendQueue;
		if (!this.persisted || !this.headerDirty) return;
		await this.store.updateHeader(this.scope, this.header);
		this.headerDirty = false;
	}
}
