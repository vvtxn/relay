import { join } from "node:path";
import { relayDir } from "../paths.ts";

function getUsername(): string | undefined {
	return process.env.USER ?? process.env.USERNAME;
}

export function sessionsBaseDir(): string {
	return join(relayDir(), "sessions");
}

export function sessionDir(cwd: string, ownerId?: string): string {
	const owner = ownerId ?? getUsername() ?? "default";
	if (ownerId === undefined) return join(sessionsBaseDir(), encodeURIComponent(owner));
	return join(sessionsBaseDir(), encodeURIComponent(owner), encodeURIComponent(cwd));
}

export function sessionFilePath(cwd: string, id: string, ownerId?: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	return join(sessionDir(cwd, ownerId), `${ts}_${id}.jsonl`);
}
