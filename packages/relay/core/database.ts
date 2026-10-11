import { createClient } from "@tursodatabase/serverless/compat";

/** Minimal client surface shared by the session and user stores. */
export type DatabaseClient = Pick<ReturnType<typeof createClient>, "execute" | "batch">;

export interface DatabaseCredentials {
	url: string;
	authToken: string;
}

/** Creates a Turso client. Share the result between stores to reuse one connection. */
export function createDatabaseClient(credentials: DatabaseCredentials): DatabaseClient {
	return createClient(credentials);
}

/** Reads Turso credentials from the environment. */
export function databaseCredentialsFromEnv(): DatabaseCredentials {
	const url = process.env.TURSO_DB_URL;
	const authToken = process.env.TURSO_DB_TOKEN;
	if (!url || !authToken) throw new Error("TURSO_DB_URL and TURSO_DB_TOKEN are required");
	return { url, authToken };
}
