import type { Effect } from "effect";
import type { BoxError } from "./errors.ts";

/** Named resource bundles the agent and users can select. */
export type BoxProfile = "tiny" | "small" | "medium";

export type BoxState = "provisioning" | "starting" | "ready" | "busy" | "paused" | "stopped" | "error";

/** Resolved configuration for one box. */
export interface BoxSettings {
	image: string;
	profile: BoxProfile;
	/** Upper bound an agent may resize to within the server budget. */
	maxProfile: BoxProfile;
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
	setup?: string;
	resume?: string;
	env: Record<string, string>;
	exclude: string[];
}

/** The subset a project may configure in `.relay/box.json`. */
export interface ProjectBoxConfig {
	version?: number;
	image?: string;
	profile?: BoxProfile;
	maxProfile?: BoxProfile;
	cpus?: number;
	memoryMiB?: number;
	rootDiskMiB?: number;
	setup?: string;
	resume?: string;
	env?: Record<string, string>;
	exclude?: string[];
}

/** A session attached to a box. Attachments are metadata, never identity. */
export interface BoxAttachment {
	sessionId: string;
	attachedAt: string;
}

/** Request to find or create a box for a session and lease it. */
export interface BoxSpec {
	ownerId: string;
	projectCwd: string;
	/** Omitted for a standalone box; the current run path always supplies one. */
	sessionId?: string;
	settings: BoxSettings;
	signal?: AbortSignal;
}

export interface BoxStatus {
	boxId: string;
	ownerId: string;
	originSessionId?: string;
	attachments: BoxAttachment[];
	projectCwd: string;
	/** Host path of the workspace mounted at /workspace. Local-only in v0. */
	workspace: string;
	state: BoxState;
	settings: BoxSettings;
	createdAt: string;
	lastUsedAt: string;
	pausedAt?: string;
	error?: string;
	/** Current scheduler usage, included for status tooling. */
	capacity?: {
		maxRunning: number;
		running: number;
		maxCpus: number;
		usedCpus: number;
		maxMemoryMiB: number;
		usedMemoryMiB: number;
	};
}

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
}

/** One path applied from a box workspace to the project checkout. */
export interface BoxSyncFile {
	/** Git name-status code (`M`, `A`, `D`, `R100`, ...). */
	status: string;
	path: string;
}

/** Result of applying a box workspace's changes to the project checkout. */
export interface BoxSyncResult {
	projectCwd: string;
	files: BoxSyncFile[];
	summary: string;
}

export interface BoxLease {
	readonly boxId: string;
	readonly status: BoxStatus;
	readonly workspace: string;
	/** True when this box has a sync baseline and can apply changes to the checkout. */
	readonly syncAvailable: boolean;
	sync(): Effect.Effect<BoxSyncResult, BoxError>;
	exec(command: string, options?: ExecOptions): Effect.Effect<ExecResult, BoxError>;
	release(): Effect.Effect<void>;
}

export interface GcResult {
	/** Trashed boxes whose retention elapsed. */
	trashed: number;
	/** Trash entries removed after their TTL. */
	removed: number;
	/** Attachments dropped because their session no longer exists. */
	detached: number;
}

export interface BoxManager {
	readonly enabled: boolean;
	/** Create a box without starting it. Used for standalone boxes and tests. */
	create(spec: BoxSpec): Effect.Effect<BoxStatus, BoxError>;
	/** Find an attached box or create one, then lease it. */
	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError>;
	findBySession(sessionId: string): Effect.Effect<BoxStatus | null, BoxError>;
	status(boxId: string): Effect.Effect<BoxStatus | null, BoxError>;
	list(ownerId?: string): Effect.Effect<BoxStatus[], BoxError>;
	attach(boxId: string, sessionId: string): Effect.Effect<BoxStatus, BoxError>;
	detach(boxId: string, sessionId: string): Effect.Effect<void, BoxError>;
	/** Drop attachments for sessions that no longer exist. */
	detachSessions(sessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError>;
	resize(boxId: string, profile: BoxProfile): Effect.Effect<BoxStatus, BoxError>;
	pause(boxId: string): Effect.Effect<void, BoxError>;
	resume(boxId: string): Effect.Effect<void, BoxError>;
	stop(boxId: string): Effect.Effect<void, BoxError>;
	destroy(boxId: string): Effect.Effect<void, BoxError>;
	/** Apply the box workspace's changes to the project checkout. */
	sync(boxId: string): Effect.Effect<BoxSyncResult, BoxError>;
	/** Detach missing sessions, retain unattached boxes by TTL, then expire trash. */
	gc(activeSessionIds: ReadonlySet<string>): Effect.Effect<GcResult, BoxError>;
	reconcile(): Effect.Effect<void, BoxError>;
	shutdown(): Effect.Effect<void, BoxError>;
}

export type RuntimeStatus =
	| "absent"
	| "created"
	| "starting"
	| "running"
	| "draining"
	| "paused"
	| "stopped"
	| "crashed";

export interface RuntimeBoxInfo {
	name: string;
	status: RuntimeStatus;
}

/** A host-held secret exposed to the guest as a placeholder for allowed hosts. */
export interface BoxSecret {
	envVar: string;
	value: string;
	allowedHosts: string[];
}

export interface RuntimeCreateInput {
	name: string;
	settings: BoxSettings;
	workspace: string;
	labels: Record<string, string>;
	/** Host secrets substituted only for their allowed egress destinations. */
	secrets: readonly BoxSecret[];
	/** Boot-time hotplug ceilings. The effective resources may be lower. */
	maxCpus: number;
	maxMemoryMiB: number;
}

export interface RuntimeResizeInput {
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
}

export interface RuntimeResizeResult {
	applied: boolean;
	status: string;
	resizeStatus: Array<{
		resource: string;
		requested: string;
		actual: string;
		state: string;
	}>;
}

export interface RuntimeExecOptions {
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Runtime seam: the manager owns workspaces and manifests; this owns VMs. */
export interface BoxRuntime {
	readonly kind: string;
	create(input: RuntimeCreateInput): Promise<void>;
	start(name: string): Promise<void>;
	pause(name: string): Promise<void>;
	resume(name: string): Promise<void>;
	modify(name: string, input: RuntimeResizeInput): Promise<RuntimeResizeResult>;
	stop(name: string): Promise<void>;
	destroy(name: string): Promise<void>;
	status(name: string): Promise<RuntimeStatus>;
	exec(name: string, command: string, options: RuntimeExecOptions): Promise<ExecResult>;
	list(labels: Record<string, string>): Promise<RuntimeBoxInfo[]>;
	/** Cached OCI image references; used to auto-select the prepared box image. */
	listImages(): Promise<string[]>;
}

/** Settings used by the server configuration layer before project overrides. */
export interface BoxManagerConfig {
	enabled: boolean;
	dataDir: string;
	cacheDir: string;
	maxRunning: number;
	/** Total vCPU budget across resident boxes. */
	maxCpus: number;
	/** Total guest memory budget across resident boxes. */
	maxMemoryMiB: number;
	/** Extra host memory reserved for each resident VM. */
	vmOverheadMiB: number;
	/** Idle duration before a ready box is paused. Zero disables pausing. */
	pauseMs: number;
	/** Idle duration before a paused/ready box is stopped. Zero disables stopping. */
	stopMs: number;
	acquireTimeoutMs: number;
	setupTimeoutMs: number;
	/** How long an unattached box is kept before it is trashed. */
	retentionMs: number;
	/** Highest profile an agent may select. */
	maxProfile: BoxProfile;
	/** Host secrets injected into the runtime, never persisted in manifests. */
	secrets: readonly BoxSecret[];
	defaults: BoxSettings;
}
