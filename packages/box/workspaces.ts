import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { BoxError, toBoxError } from "./errors.ts";
import type { BoxSyncResult } from "./types.ts";
import { cleanupTempWorkspaces, prepareWorkspace } from "./workspace.ts";
import { syncWorkspace, syncWorkspaceToBranch, withProjectSyncLock } from "./sync.ts";

/** A durable workspace owned by one session (thread). */
export interface SessionWorkspace {
	sessionId: string;
	ownerId: string;
	projectCwd: string;
	/** Host path used by file tools and sync. */
	hostPath: string;
	/** Path inside a box VM (the project workspace root is mounted at /workspace). */
	execPath: string;
	/** Dedicated branch in the project repository for this thread. */
	branch: string;
}

export interface WorkspaceManager {
	ensure(input: {
		sessionId: string;
		ownerId: string;
		projectCwd: string;
		exclude: string[];
	}): Effect.Effect<SessionWorkspace, BoxError>;
	/** Resolve an existing session workspace without creating or cloning one. */
	find(input: { sessionId: string; ownerId: string; projectCwd: string }): SessionWorkspace | null;
	/** Commit changes to the session's thread branch without touching the checkout. */
	sync(workspace: SessionWorkspace): Effect.Effect<BoxSyncResult, BoxError>;
	/** Checkout path used when thread branches are disabled. */
	syncCheckout(workspace: Pick<SessionWorkspace, "hostPath" | "projectCwd">): Effect.Effect<BoxSyncResult, BoxError>;
	removeSessions(sessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError>;
	gc(activeSessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError>;
}

interface WorkspaceMarker {
	sessionId: string;
	ownerId: string;
	projectCwd: string;
	createdAt: string;
}

const MARKER_DIR = ".relay-workspaces";

function isPathInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Per-project root mounted at /workspace inside every box in the pool. */
export function projectWorkspaceRoot(root: string, ownerId: string, projectCwd: string): string {
	return join(root, digest(ownerId), digest(resolve(projectCwd)));
}

/** Directory name for one session, also its path inside the box. */
export function sessionWorkspaceName(sessionId: string): string {
	return digest(sessionId);
}

export function sessionExecPath(sessionId: string): string {
	return `/workspace/${sessionWorkspaceName(sessionId)}`;
}

/** Branch in the project repository where this thread's changes are committed. */
export function threadBranchName(sessionId: string): string {
	return `relay/thread/${sessionId}`;
}

class WorkspaceManagerImpl implements WorkspaceManager {
	private readonly root: string;
	private readonly index = new Map<string, SessionWorkspace>();
	private readonly locks = new Map<string, Promise<void>>();

	constructor(root: string) {
		this.root = resolve(root);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}

	ensure(input: {
		sessionId: string;
		ownerId: string;
		projectCwd: string;
		exclude: string[];
	}): Effect.Effect<SessionWorkspace, BoxError> {
		return Effect.tryPromise({
			try: () => this.ensureInternal(input),
			catch: (error) => toBoxError(error, "Could not prepare the session workspace"),
		});
	}

	find(input: { sessionId: string; ownerId: string; projectCwd: string }): SessionWorkspace | null {
		if (isPathInside(this.root, input.projectCwd) || isPathInside(input.projectCwd, this.root)) return null;
		const projectRoot = projectWorkspaceRoot(this.root, input.ownerId, input.projectCwd);
		const hostPath = join(projectRoot, sessionWorkspaceName(input.sessionId));
		if (!existsSync(hostPath)) return null;
		return {
			sessionId: input.sessionId,
			ownerId: input.ownerId,
			projectCwd: resolve(input.projectCwd),
			hostPath,
			execPath: sessionExecPath(input.sessionId),
			branch: threadBranchName(input.sessionId),
		};
	}

	sync(workspace: SessionWorkspace): Effect.Effect<BoxSyncResult, BoxError> {
		return Effect.tryPromise({
			try: () => syncWorkspaceToBranch(workspace.hostPath, workspace.projectCwd, workspace.branch),
			catch: (error) => toBoxError(error, "Could not commit the session workspace to its branch"),
		});
	}

	syncCheckout(workspace: Pick<SessionWorkspace, "hostPath" | "projectCwd">): Effect.Effect<BoxSyncResult, BoxError> {
		return Effect.tryPromise({
			try: () => syncWorkspace(workspace.hostPath, workspace.projectCwd),
			catch: (error) => toBoxError(error, "Could not sync the session workspace to the checkout"),
		});
	}

	removeSessions(sessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				let removed = 0;
				for (const sessionId of sessionIds) {
					if (await this.removeInternal(sessionId)) removed += 1;
				}
				return removed;
			},
			catch: (error) => toBoxError(error, "Could not remove session workspaces"),
		});
	}

	gc(activeSessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				let removed = 0;
				for (const marker of this.scanMarkers()) {
					if (activeSessionIds.has(marker.sessionId)) continue;
					if (await this.removeInternal(marker.sessionId, marker)) removed += 1;
				}
				return removed;
			},
			catch: (error) => toBoxError(error, "Could not collect orphaned session workspaces"),
		});
	}

	private async ensureInternal(input: {
		sessionId: string;
		ownerId: string;
		projectCwd: string;
		exclude: string[];
	}): Promise<SessionWorkspace> {
		if (isPathInside(this.root, input.projectCwd) || isPathInside(input.projectCwd, this.root)) {
			throw new BoxError({
				message:
					"The session workspace root and project directory must not contain one another " +
					`(${this.root} vs ${input.projectCwd}).`,
			});
		}
		const projectRoot = projectWorkspaceRoot(this.root, input.ownerId, input.projectCwd);
		const hostPath = join(projectRoot, sessionWorkspaceName(input.sessionId));
		const workspace: SessionWorkspace = {
			sessionId: input.sessionId,
			ownerId: input.ownerId,
			projectCwd: resolve(input.projectCwd),
			hostPath,
			execPath: sessionExecPath(input.sessionId),
			branch: threadBranchName(input.sessionId),
		};
		if (existsSync(hostPath)) {
			this.writeMarker(workspace);
			this.index.set(input.sessionId, workspace);
			return workspace;
		}

		// Workspace clones share a project root; serialize preparation so one
		// session cannot clean up another session's in-flight temp directory.
		await this.withLock(projectRoot, async () => {
			if (existsSync(hostPath)) return;
			mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
			cleanupTempWorkspaces(projectRoot);
			// A concurrent run may be syncing into the checkout; clone from a
			// stable working tree rather than racing its patch.
			await withProjectSyncLock(input.projectCwd, () =>
				prepareWorkspace(input.projectCwd, projectRoot, hostPath, input.exclude),
			);
			this.writeMarker(workspace);
			this.index.set(input.sessionId, workspace);
		});
		return workspace;
	}

	private async removeInternal(sessionId: string, known?: WorkspaceMarker): Promise<boolean> {
		const workspace = this.index.get(sessionId);
		let marker = known ?? null;
		if (!marker && workspace) marker = this.readMarker(workspace.ownerId, workspace.projectCwd, sessionId);
		if (!marker) marker = this.findMarker(sessionId);
		if (!marker && workspace) {
			marker = {
				sessionId,
				ownerId: workspace.ownerId,
				projectCwd: workspace.projectCwd,
				createdAt: "",
			};
		}
		if (!marker) {
			this.index.delete(sessionId);
			return false;
		}
		const projectRoot = projectWorkspaceRoot(this.root, marker.ownerId, marker.projectCwd);
		const hostPath = join(projectRoot, sessionWorkspaceName(sessionId));
		let removed = false;
		try {
			rmSync(hostPath, { recursive: true, force: true });
			removed = true;
		} catch {
			// Keep the marker so a later GC pass can retry.
		}
		if (!removed) return false;
		try {
			rmSync(this.markerPath(projectRoot, sessionId), { force: true });
		} catch {
			// Best effort.
		}
		this.index.delete(sessionId);
		this.removeEmptyDirs(projectRoot);
		return true;
	}

	private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const chain = previous.then(() => next);
		this.locks.set(sessionId, chain);
		return previous
			.catch(() => {})
			.then(fn)
			.finally(() => {
				release();
				if (this.locks.get(sessionId) === chain) this.locks.delete(sessionId);
			});
	}

	private markerDir(projectRoot: string): string {
		return join(projectRoot, MARKER_DIR);
	}

	private markerPath(projectRoot: string, sessionId: string): string {
		return join(this.markerDir(projectRoot), `${sessionWorkspaceName(sessionId)}.json`);
	}

	private writeMarker(workspace: SessionWorkspace): void {
		const projectRoot = projectWorkspaceRoot(this.root, workspace.ownerId, workspace.projectCwd);
		mkdirSync(this.markerDir(projectRoot), { recursive: true, mode: 0o700 });
		const marker: WorkspaceMarker = {
			sessionId: workspace.sessionId,
			ownerId: workspace.ownerId,
			projectCwd: workspace.projectCwd,
			createdAt: new Date().toISOString(),
		};
		writeFileSync(this.markerPath(projectRoot, workspace.sessionId), `${JSON.stringify(marker)}\n`, {
			mode: 0o600,
		});
	}

	private readMarker(ownerId: string, projectCwd: string, sessionId: string): WorkspaceMarker | null {
		const projectRoot = projectWorkspaceRoot(this.root, ownerId, projectCwd);
		try {
			const parsed = JSON.parse(
				readFileSync(this.markerPath(projectRoot, sessionId), "utf8"),
			) as Partial<WorkspaceMarker>;
			if (
				typeof parsed.sessionId !== "string" ||
				typeof parsed.ownerId !== "string" ||
				typeof parsed.projectCwd !== "string"
			) {
				return null;
			}
			return {
				sessionId: parsed.sessionId,
				ownerId: parsed.ownerId,
				projectCwd: parsed.projectCwd,
				createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
			};
		} catch {
			return null;
		}
	}

	private scanMarkers(): WorkspaceMarker[] {
		const markers: WorkspaceMarker[] = [];
		for (const ownerEntry of this.safeReadDirs(this.root)) {
			const ownerDir = join(this.root, ownerEntry);
			for (const projectEntry of this.safeReadDirs(ownerDir)) {
				const markerDir = join(ownerDir, projectEntry, MARKER_DIR);
				for (const markerFile of this.safeReadFiles(markerDir)) {
					if (!markerFile.endsWith(".json")) continue;
					try {
						const parsed = JSON.parse(
							readFileSync(join(markerDir, markerFile), "utf8"),
						) as Partial<WorkspaceMarker>;
						if (
							typeof parsed.sessionId === "string" &&
							typeof parsed.ownerId === "string" &&
							typeof parsed.projectCwd === "string"
						) {
							markers.push({
								sessionId: parsed.sessionId,
								ownerId: parsed.ownerId,
								projectCwd: parsed.projectCwd,
								createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
							});
						}
					} catch {
						// Ignore corrupt markers; a later manual cleanup can remove them.
					}
				}
			}
		}
		return markers;
	}

	private findMarker(sessionId: string): WorkspaceMarker | null {
		return this.scanMarkers().find((marker) => marker.sessionId === sessionId) ?? null;
	}

	private safeReadDirs(path: string): string[] {
		try {
			return readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	private safeReadFiles(path: string): string[] {
		try {
			return readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	private removeEmptyDirs(projectRoot: string): void {
		try {
			if (readdirSync(this.markerDir(projectRoot)).length === 0) rmdirSync(this.markerDir(projectRoot));
		} catch {
			// Missing or non-empty marker directory.
		}
		try {
			if (readdirSync(projectRoot).length === 0) rmdirSync(projectRoot);
		} catch {
			// Non-empty project root remains; that is fine.
		}
	}
}

export function createWorkspaceManager(root: string): WorkspaceManager {
	return new WorkspaceManagerImpl(root);
}
