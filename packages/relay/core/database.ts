/**
 * Shared database client for local and remote storage.
 *
 * Both modes use the same libSQL driver: a local `file:` URL opens an embedded
 * SQLite database, while a `libsql://` / `https://` URL talks to Turso. Keeping
 * one client means the stores, schema, and queries are identical in both
 * modes; only the URL (and optional auth token) differ.
 */

import { createClient, type Client } from "@libsql/client";

/** Shared client surface used by the session, user, and settings stores. */
export type DatabaseClient = Client;

export interface DatabaseCredentials {
	/** `file:` URL for local mode, or a libSQL/Turso URL for remote mode. */
	url: string;
	/** Required for remote Turso databases; omitted for local files. */
	authToken?: string;
}

/** Creates a database client. Share the result between stores to reuse one connection. */
export function createDatabaseClient(credentials: DatabaseCredentials): DatabaseClient {
	return createClient({
		url: credentials.url,
		...(credentials.authToken ? { authToken: credentials.authToken } : {}),
	});
}
