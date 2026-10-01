/**
 * Local session handoff between the browser and the CLI.
 *
 * Browsers and the terminal don't share cookies, so a GitHub login in the web
 * client would leave the CLI unauthenticated. When the server is bound to
 * loopback it writes the issued session token here (mode `0600`); the CLI reads
 * it and authenticates with `Authorization: Bearer`, so both clients act as the
 * same user.
 */

import { join } from "@std/path/join";
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
	try {
		Deno.mkdirSync(relayDir(), { recursive: true });
		Deno.writeTextFileSync(sessionPath(), JSON.stringify(session, null, "\t") + "\n", { mode: 0o600 });
	} catch {
		// Best effort — the web session still works without the CLI handoff.
	}
}

export function readStoredSession(): StoredSession | null {
	try {
		const parsed = JSON.parse(Deno.readTextFileSync(sessionPath())) as Partial<StoredSession>;
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
		Deno.removeSync(sessionPath());
	} catch {
		// Already gone.
	}
}
