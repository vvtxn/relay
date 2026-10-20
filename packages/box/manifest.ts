import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxError } from "./errors.ts";
import {
	boxDir,
	boxesRoot,
	BOX_DIR_MODE,
	BOX_FILE_MODE,
	logsDir,
	manifestPath,
	trashDir,
	workspacePath,
} from "./paths.ts";
import type { BoxSettings, BoxState } from "./types.ts";

export const MANIFEST_VERSION = 1;

export type SetupState = "pending" | "ok" | "failed";

export interface BoxManifest {
	version: number;
	boxId: string;
	sessionId: string;
	ownerId: string;
	projectCwd: string;
	workspacePath: string;
	sandboxName: string;
	runtime: { kind: string; version: string };
	settings: BoxSettings;
	state: BoxState;
	setupState: SetupState;
	createdAt: string;
	lastUsedAt: string;
	error?: string;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new BoxError({ message: `Invalid box manifest: ${field} must be a non-empty string` });
	}
	return value;
}

function parseManifest(raw: unknown): BoxManifest {
	const value = raw as Partial<BoxManifest>;
	if (value.version !== MANIFEST_VERSION) {
		throw new BoxError({ message: `Unsupported box manifest version: ${String(value.version)}` });
	}
	const settings = value.settings as Partial<BoxSettings> | undefined;
	if (!settings || typeof settings.image !== "string") {
		throw new BoxError({ message: "Invalid box manifest: settings.image is required" });
	}
	return {
		version: MANIFEST_VERSION,
		boxId: requireString(value.boxId, "boxId"),
		sessionId: requireString(value.sessionId, "sessionId"),
		ownerId: requireString(value.ownerId, "ownerId"),
		projectCwd: requireString(value.projectCwd, "projectCwd"),
		workspacePath: requireString(value.workspacePath, "workspacePath"),
		sandboxName: requireString(value.sandboxName, "sandboxName"),
		runtime: value.runtime ?? { kind: "microsandbox", version: "unknown" },
		settings: {
			image: settings.image,
			cpus: typeof settings.cpus === "number" ? settings.cpus : 2,
			memoryMiB: typeof settings.memoryMiB === "number" ? settings.memoryMiB : 2048,
			rootDiskMiB: typeof settings.rootDiskMiB === "number" ? settings.rootDiskMiB : 8192,
			...(typeof settings.setup === "string" ? { setup: settings.setup } : {}),
			...(typeof settings.resume === "string" ? { resume: settings.resume } : {}),
			env: settings.env ?? {},
			exclude: settings.exclude ?? [],
		},
		state: value.state ?? "stopped",
		setupState: value.setupState ?? "pending",
		createdAt: requireString(value.createdAt, "createdAt"),
		lastUsedAt: requireString(value.lastUsedAt, "lastUsedAt"),
		...(typeof value.error === "string" ? { error: value.error } : {}),
	};
}

/** File-backed box registry. One manifest per box; no shared mutable index. */
export class FileBoxStore {
	readonly dataDir: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		mkdirSync(boxesRoot(dataDir), { recursive: true, mode: BOX_DIR_MODE });
	}

	dir(boxId: string): string {
		return boxDir(this.dataDir, boxId);
	}

	workspace(boxId: string): string {
		return workspacePath(this.dataDir, boxId);
	}

	logs(boxId: string): string {
		return logsDir(this.dataDir, boxId);
	}

	load(boxId: string): BoxManifest | null {
		const path = manifestPath(this.dataDir, boxId);
		try {
			return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			if (error instanceof BoxError) throw error;
			throw new BoxError({ message: `Could not read box manifest ${path}`, cause: error });
		}
	}

	list(): BoxManifest[] {
		const root = boxesRoot(this.dataDir);
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			return [];
		}
		const manifests: BoxManifest[] = [];
		for (const entry of entries) {
			if (entry === ".trash" || entry === ".lock" || entry.startsWith("workspace.tmp-")) continue;
			try {
				const manifest = this.load(entry);
				if (manifest) manifests.push(manifest);
			} catch {
				// A corrupt manifest is reported when that box is addressed directly;
				// listing stays available for the rest.
			}
		}
		return manifests;
	}

	write(manifest: BoxManifest): void {
		mkdirSync(this.dir(manifest.boxId), { recursive: true, mode: BOX_DIR_MODE });
		mkdirSync(this.logs(manifest.boxId), { recursive: true, mode: BOX_DIR_MODE });
		const path = manifestPath(this.dataDir, manifest.boxId);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: BOX_FILE_MODE });
		renameSync(tmp, path);
	}

	trash(manifest: BoxManifest): string {
		const root = trashDir(this.dataDir);
		mkdirSync(root, { recursive: true, mode: BOX_DIR_MODE });
		const destination = join(root, `${manifest.boxId}-${Date.now()}`);
		try {
			renameSync(this.dir(manifest.boxId), destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
			throw error;
		}
		return destination;
	}

	removeTrash(olderThanMs: number): number {
		const root = trashDir(this.dataDir);
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			return 0;
		}
		const cutoff = Date.now() - olderThanMs;
		let removed = 0;
		for (const entry of entries) {
			const path = join(root, entry);
			const stamp = Number(entry.slice(entry.lastIndexOf("-") + 1));
			if (!Number.isFinite(stamp) || stamp > cutoff) continue;
			try {
				rmSync(path, { recursive: true, force: true });
				removed += 1;
			} catch {
				// Leave it for the next sweep.
			}
		}
		return removed;
	}
}
