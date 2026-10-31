import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BoxError } from "./errors.ts";

export const BOX_DIR_MODE = 0o700;
export const BOX_FILE_MODE = 0o600;

/**
 * Generate an independent, filesystem-safe box id. Boxes are not derived from
 * sessions: a pooled worker outlives every run that leases it.
 */
export function createBoxId(): string {
	return randomBytes(18).toString("base64url");
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

export function trashDir(dataDir: string): string {
	return join(boxesRoot(dataDir), ".trash");
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
