import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BoxError } from "./errors.ts";
import type { BoxSettings } from "./types.ts";

export const BOX_DIR_MODE = 0o700;
export const BOX_FILE_MODE = 0o600;

/** Stable, filesystem-safe identity for a session. */
export function boxIdFor(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("base64url").slice(0, 26);
}

/** Short hash that namespaces sandbox names to one Relay data directory. */
export function dataDirHash(dataDir: string): string {
	return createHash("sha256").update(dataDir).digest("base64url").slice(0, 8);
}

export function sandboxNameFor(dataDir: string, boxId: string): string {
	return `relay-${dataDirHash(dataDir)}-${boxId}`;
}

export function boxesRoot(dataDir: string): string {
	// `dataDir` is already the box root (config: ~/.relay/boxes). Keeping this
	// helper central makes the path layout explicit without nesting twice.
	return dataDir;
}

export function boxDir(dataDir: string, boxId: string): string {
	return join(boxesRoot(dataDir), boxId);
}

export function workspacePath(dataDir: string, boxId: string): string {
	return join(boxDir(dataDir, boxId), "workspace");
}

export function manifestPath(dataDir: string, boxId: string): string {
	return join(boxDir(dataDir, boxId), "box.json");
}

export function logsDir(dataDir: string, boxId: string): string {
	return join(boxDir(dataDir, boxId), "logs");
}

export function trashDir(dataDir: string): string {
	return join(boxesRoot(dataDir), ".trash");
}

/** Create the directories a box owns, with private permissions. */
export function ensureBoxDirs(dataDir: string, boxId: string): void {
	mkdirSync(logsDir(dataDir, boxId), { recursive: true, mode: BOX_DIR_MODE });
	mkdirSync(trashDir(dataDir), { recursive: true, mode: BOX_DIR_MODE });
}

/**
 * One server per data directory. A stale lock (dead pid) is reclaimed; a live
 * lock is a startup error so two managers cannot fight over the same sandboxes.
 */
export function acquireDataDirLock(dataDir: string): () => void {
	mkdirSync(boxesRoot(dataDir), { recursive: true, mode: BOX_DIR_MODE });
	const path = join(boxesRoot(dataDir), ".lock");

	const tryLock = (): number | null => {
		try {
			return openSync(path, "wx", BOX_FILE_MODE);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return null;
		}
	};

	let fd = tryLock();
	if (fd === null) {
		let stale = false;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
			const pid = typeof parsed.pid === "number" ? parsed.pid : null;
			if (pid === null) stale = true;
			else {
				try {
					process.kill(pid, 0);
				} catch (error) {
					stale = (error as NodeJS.ErrnoException).code === "ESRCH";
				}
			}
		} catch {
			stale = true;
		}
		if (!stale) throw new BoxError({ message: `Another Relay server owns the box data directory ${dataDir}` });
		rmSync(path, { force: true });
		fd = tryLock();
		if (fd === null) throw new BoxError({ message: `Could not lock the box data directory ${dataDir}` });
	}

	writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
	closeSync(fd);

	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort; a stale pid is reclaimed on the next start.
		}
	};
}

/** Public path helpers shared with the server for diagnostics. */
export function describeBox(dataDir: string, boxId: string, settings: BoxSettings): string {
	return `${boxDir(dataDir, boxId)} (${settings.image})`;
}
