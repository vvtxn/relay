import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxError } from "./errors.ts";
import { profileForSettings } from "./profiles.ts";
import { boxDir, boxesRoot, BOX_DIR_MODE, BOX_FILE_MODE, logsDir, manifestPath, trashDir } from "./paths.ts";
import type { BoxAttachment, BoxProfile, BoxSettings, BoxState } from "./types.ts";

export const MANIFEST_VERSION = 2;

export type SetupState = "pending" | "ok" | "failed";

export interface BoxManifest {
	version: number;
	boxId: string;
	originSessionId?: string;
	attachments: BoxAttachment[];
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
	pausedAt?: string;
	error?: string;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new BoxError({ message: `Invalid box manifest: ${field} must be a non-empty string` });
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseState(value: unknown): BoxState {
	switch (value) {
		case "provisioning":
		case "starting":
		case "ready":
		case "busy":
		case "paused":
		case "stopped":
		case "error":
			return value;
		// v1 used `running` for any resident box; the runtime is the source of
		// truth after startup, so normalize it to a non-terminal resident state.
		case "running":
			return "ready";
		default:
			return "stopped";
	}
}

function parseProfile(value: unknown, fallback: BoxProfile): BoxProfile {
	return value === "tiny" || value === "small" || value === "medium" ? value : fallback;
}

function parseAttachments(value: unknown): BoxAttachment[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new BoxError({ message: "Invalid box manifest: attachments must be an array" });
	const attachments: BoxAttachment[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as Partial<BoxAttachment>;
		if (typeof item.sessionId !== "string" || !item.sessionId) continue;
		attachments.push({
			sessionId: item.sessionId,
			attachedAt: typeof item.attachedAt === "string" ? item.attachedAt : new Date(0).toISOString(),
		});
	}
	return attachments;
}

function parseSettings(raw: unknown, profileFallback: BoxProfile): BoxSettings {
	const settings = (raw ?? {}) as Partial<BoxSettings>;
	if (typeof settings.image !== "string" || !settings.image) {
		throw new BoxError({ message: "Invalid box manifest: settings.image is required" });
	}
	const cpus = typeof settings.cpus === "number" ? settings.cpus : 1;
	const memoryMiB = typeof settings.memoryMiB === "number" ? settings.memoryMiB : 2048;
	const rootDiskMiB = typeof settings.rootDiskMiB === "number" ? settings.rootDiskMiB : 8192;
	const inferred = profileForSettings({ cpus, memoryMiB });
	const profile = parseProfile(settings.profile, inferred === "custom" ? profileFallback : inferred);
	const maxProfile = parseProfile(settings.maxProfile, "medium");
	return {
		image: settings.image,
		profile,
		maxProfile,
		cpus,
		memoryMiB,
		rootDiskMiB,
		...(typeof settings.setup === "string" ? { setup: settings.setup } : {}),
		...(typeof settings.resume === "string" ? { resume: settings.resume } : {}),
		env: settings.env ?? {},
		exclude: settings.exclude ?? [],
	};
}

function parseManifest(raw: unknown): BoxManifest {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new BoxError({ message: "Invalid box manifest: expected an object" });
	}
	const value = raw as Record<string, unknown>;
	const version = value.version;
	if (version !== 1 && version !== MANIFEST_VERSION) {
		throw new BoxError({ message: `Unsupported box manifest version: ${String(version)}` });
	}
	const boxId = requireString(value.boxId, "boxId");
	const ownerId = requireString(value.ownerId, "ownerId");
	const projectCwd = requireString(value.projectCwd, "projectCwd");
	const workspacePath = requireString(value.workspacePath, "workspacePath");
	const sandboxName = requireString(value.sandboxName, "sandboxName");
	const createdAt = requireString(value.createdAt, "createdAt");
	const lastUsedAt = requireString(value.lastUsedAt, "lastUsedAt");
	const settings = parseSettings(value.settings, "tiny");

	// v1 stored exactly one session id; migrate it to the attachment list.
	const legacySessionId = optionalString(value.sessionId);
	const attachments = parseAttachments(value.attachments);
	if (legacySessionId && !attachments.some((attachment) => attachment.sessionId === legacySessionId)) {
		attachments.push({ sessionId: legacySessionId, attachedAt: createdAt });
	}
	const originSessionId = optionalString(value.originSessionId) ?? legacySessionId ?? attachments[0]?.sessionId;

	return {
		version: MANIFEST_VERSION,
		boxId,
		...(originSessionId ? { originSessionId } : {}),
		attachments,
		ownerId,
		projectCwd,
		workspacePath,
		sandboxName,
		runtime:
			typeof value.runtime === "object" && value.runtime !== null
				? (value.runtime as BoxManifest["runtime"])
				: { kind: "microsandbox", version: "unknown" },
		settings,
		state: parseState(value.state),
		setupState:
			value.setupState === "ok" || value.setupState === "failed" || value.setupState === "pending"
				? value.setupState
				: "pending",
		createdAt,
		lastUsedAt,
		...(typeof value.pausedAt === "string" ? { pausedAt: value.pausedAt } : {}),
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
		const persisted: BoxManifest = { ...manifest, version: MANIFEST_VERSION };
		writeFileSync(tmp, `${JSON.stringify(persisted, null, "\t")}\n`, { mode: BOX_FILE_MODE });
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
