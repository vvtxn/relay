/**
 * Shared database client for local and remote storage.
 *
 * Both modes use the same libSQL driver: a local `file:` URL opens an embedded
 * SQLite database, while a `libsql://` / `https://` URL talks to Turso. Keeping
 * one client means the stores, schema, and queries are identical in both
 * modes; only the URL (and optional auth token) differ.
 */

import { createRequire } from "node:module";
import type { Client } from "@libsql/client";

/** Shared client surface used by the session, user, and settings stores. */
export type DatabaseClient = Client;

/**
 * Resolve the libSQL client relative to the server source in development, or
 * to the extracted runtime in a single executable. The native package cannot
 * be loaded from inside a SEA asset, so the executable extracts it first and
 * points `RELAY_DB_MODULE` at a real file in that runtime directory.
 */
const requireDatabase = createRequire(process.env.RELAY_DB_MODULE ?? import.meta.url);
const { createClient } = requireDatabase("@libsql/client") as typeof import("@libsql/client");

export interface DatabaseCredentials {
	/** `file:` URL for local mode, or a libSQL/Turso URL for remote mode. */
	url: string;
	/** Required for remote Turso databases; omitted for local files. */
	authToken?: string;
}

/**
 * The libSQL client accepts `https://` but not the `turso://` alias printed by
 * some Turso dashboards (and used by older Relay deployments). Normalize both
 * remote aliases to HTTPS; `file:` and explicit HTTP(S) URLs are untouched.
 */
export function normalizeDatabaseUrl(url: string): string {
	return url.replace(/^(?:turso|libsql):\/\//, "https://");
}

/** Creates a database client. Share the result between stores to reuse one connection. */
export function createDatabaseClient(credentials: DatabaseCredentials): DatabaseClient {
	return createClient({
		url: normalizeDatabaseUrl(credentials.url),
		...(credentials.authToken ? { authToken: credentials.authToken } : {}),
	});
}
