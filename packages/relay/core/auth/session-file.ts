/**
 * Local session handoff between the browser and the CLI.
 *
 * Browsers and the terminal don't share cookies, so a GitHub login in the web
 * client would leave the CLI unauthenticated. When the server is bound to
 * loopback it writes the browser's session token here (mode `0600`) at login,
 * and again whenever a signed-in browser loads the app while this file is
 * missing or stale. The CLI reads it and authenticates with
 * `Authorization: Bearer`, so both clients act as the same user.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relayDir } from "../paths.ts";

export interface StoredSession {
	/** Web origin the token was issued for (informational). */
	serverUrl: string;
	token: string;
	createdAt: string;
}

function sessionPath(): string {
	return join(relayDir(), "session.json");
}

export function writeStoredSession(session: StoredSession): void {
	const path = sessionPath();
	// Write-then-rename: the CLI polls this file and must never read a partial token.
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(relayDir(), { recursive: true });
		writeFileSync(tmp, JSON.stringify(session, null, "\t") + "\n", { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		// Best effort — the web session still works without the CLI handoff.
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Nothing more to clean up.
		}
	}
}

export function readStoredSession(): StoredSession | null {
	try {
		const parsed = JSON.parse(readFileSync(sessionPath(), "utf8")) as Partial<StoredSession>;
		if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return {
			serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
			token: parsed.token,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
		};
	} catch {
		return null;
	}
}

export function clearStoredSession(): void {
	try {
		rmSync(sessionPath(), { force: true });
	} catch {
		// Already gone.
	}
}
