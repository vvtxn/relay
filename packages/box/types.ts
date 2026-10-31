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
	env?: Record<string, string>;
	exclude?: string[];
}

/** Request to find or create a box for a run and lease it. */
export interface BoxSpec {
	ownerId: string;
	projectCwd: string;
	/** Omitted for a standalone box; the current run path always supplies one. */
	sessionId?: string;
	/** Session workspace host path; file tools and sync operate here. */
	workspace?: string;
	/** Session workspace path inside the box (for example `/workspace/<key>`). */
	execPath?: string;
	/** Active run identity, for diagnostics/status. */
	runId?: string;
	settings: BoxSettings;
	signal?: AbortSignal;
	/** Called when the request is queued and whenever its 1-based position changes. */
	onQueued?: (position: number) => void;
}

export interface BoxStatus {
	boxId: string;
	ownerId: string;
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
		queued: number;
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
	/** Branch updated by a thread-branch sync (checkout syncs omit it). */
	branch?: string;
	/** Commit created on the thread branch. */
	commit?: string;
}

export interface BoxLease {
	readonly boxId: string;
	readonly status: BoxStatus;
	/** Session workspace host path used by file tools and sync. */
	readonly workspace: string;
	/** Default working directory inside the box for exec. */
	readonly execPath: string;
	exec(command: string, options?: ExecOptions): Effect.Effect<ExecResult, BoxError>;
	release(): Effect.Effect<void>;
}

export interface GcResult {
	/** Trashed boxes whose retention elapsed. */
	trashed: number;
	/** Trash entries removed after their TTL. */
	removed: number;
}

export interface BoxManager {
	readonly enabled: boolean;
	/** Create a box without starting it. Used for standalone boxes and tests. */
	create(spec: BoxSpec): Effect.Effect<BoxStatus, BoxError>;
	/** Find an idle pooled box or create one, then lease it. */
	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError>;
	status(boxId: string): Effect.Effect<BoxStatus | null, BoxError>;
	list(ownerId?: string): Effect.Effect<BoxStatus[], BoxError>;
	resize(boxId: string, profile: BoxProfile): Effect.Effect<BoxStatus, BoxError>;
	pause(boxId: string): Effect.Effect<void, BoxError>;
	resume(boxId: string): Effect.Effect<void, BoxError>;
	stop(boxId: string): Effect.Effect<void, BoxError>;
	destroy(boxId: string): Effect.Effect<void, BoxError>;
	/** Resolve the configured image, including the `auto` placeholder. */
	resolveImage(): Effect.Effect<string, BoxError>;
	/** Retain stopped boxes by TTL, then expire trash. */
	gc(): Effect.Effect<GcResult, BoxError>;
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
	/** Root containing per-project session workspaces mounted into boxes. */
	workspaceRoot: string;
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
	/** How long a stopped box is kept before it is trashed. */
	retentionMs: number;
	/** Highest profile an agent may select. */
	maxProfile: BoxProfile;
	/** Host secrets injected into the runtime, never persisted in manifests. */
	secrets: readonly BoxSecret[];
	defaults: BoxSettings;
}
