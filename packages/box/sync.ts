import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoxError } from "./errors.ts";
import type { BoxSyncFile, BoxSyncResult } from "./types.ts";

const BASELINE_REF = "refs/relay/baseline";
const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_AUTHOR = "Relay Box";
const GIT_EMAIL = "relay-box@localhost";

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_AUTHOR_NAME: GIT_AUTHOR,
		GIT_AUTHOR_EMAIL: GIT_EMAIL,
		GIT_COMMITTER_NAME: GIT_AUTHOR,
		GIT_COMMITTER_EMAIL: GIT_EMAIL,
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	};
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv()): Promise<GitResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-C", cwd, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new BoxError({ message: `git ${args[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms` }));
		}, GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			// Git output used here is metadata and diffs written via --output.
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, stdout, stderr });
		});
	});
}

async function requireGit(cwd: string, args: string[], label: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
	const result = await runGit(cwd, args, env);
	if (result.code !== 0) {
		throw new BoxError({
			message: `${label}: ${result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`}`,
		});
	}
	return result;
}

function hasGitDir(root: string): boolean {
	return existsSync(join(root, ".git"));
}

/** True when the box workspace has a sync baseline (marker written with the ref). */
export function hasWorkspaceBaseline(workspace: string): boolean {
	return existsSync(join(workspace, ".git", "relay-baseline"));
}

/**
 * Record the workspace's current tracked and non-ignored files as a hidden
 * baseline commit. Sync diffs against this ref, so the project's pre-existing
 * uncommitted changes are not replayed onto the checkout.
 */
export async function createWorkspaceBaseline(workspace: string): Promise<boolean> {
	if (!hasGitDir(workspace)) return false;
	const temp = mkdtempSync(join(tmpdir(), "relay-box-baseline-"));
	const env = gitEnv({ GIT_INDEX_FILE: join(temp, "index") });
	try {
		const head = await runGit(workspace, ["rev-parse", "--verify", "HEAD"], env);
		await requireGit(
			workspace,
			head.code === 0 ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
			"Could not seed the box sync baseline",
			env,
		);
		await requireGit(workspace, ["add", "-A", "."], "Could not snapshot the box workspace", env);
		const tree = (
			await requireGit(workspace, ["write-tree"], "Could not write the box baseline tree", env)
		).stdout.trim();
		const headCommit = head.code === 0 ? head.stdout.trim() : "";
		const commit = (
			await requireGit(
				workspace,
				["commit-tree", tree, ...(headCommit ? ["-p", headCommit] : []), "-m", "Relay box sync baseline"],
				"Could not create the box sync baseline",
				env,
			)
		).stdout.trim();
		await requireGit(workspace, ["update-ref", BASELINE_REF, commit], "Could not store the box sync baseline", env);
		writeFileSync(join(workspace, ".git", "relay-baseline"), `${commit}\n`, { mode: 0o600 });
		return true;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function parseNameStatus(output: string): BoxSyncFile[] {
	const files: BoxSyncFile[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [status, first, second] = line.split("\t");
		if (!status || !first) continue;
		files.push({ status, path: second ? `${first} -> ${second}` : first });
	}
	return files;
}

function summaryFor(files: BoxSyncFile[], projectCwd: string): string {
	if (files.length === 0) return "No box changes to sync.";
	const lines = files.map((file) => `${file.status}\t${file.path}`).join("\n");
	return `Synced ${files.length} change${files.length === 1 ? "" : "s"} to ${projectCwd}:\n${lines}`;
}

const projectSyncLocks = new Map<string, Promise<void>>();

/**
 * Serialize syncs into one checkout. Two sessions may finish at the same time;
 * their patches must not interleave in the shared working tree.
 */
export async function withProjectSyncLock<T>(projectCwd: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(projectCwd);
	const previous = projectSyncLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	const chained = previous.then(() => next);
	projectSyncLocks.set(key, chained);
	await previous.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		if (projectSyncLocks.get(key) === chained) projectSyncLocks.delete(key);
	}
}

/**
 * Apply the changes made in a box workspace to the original project checkout.
 *
 * The hidden baseline ref is created when the box is cloned, so only changes
 * made after the box started are applied; the checkout's pre-existing dirty
 * state is not replayed. The patch is applied to the working tree (not the
 * index) and the baseline advances after a successful apply. A dirty or
 * diverged checkout fails the apply instead of being overwritten.
 */
export async function syncWorkspace(workspace: string, projectCwd: string): Promise<BoxSyncResult> {
	return await withProjectSyncLock(projectCwd, () => syncWorkspaceUnlocked(workspace, projectCwd));
}

interface WorkspacePatch {
	projectCwd: string;
	files: BoxSyncFile[];
	patchPath: string;
	tree: string;
}

function validateWorkspaceSync(workspace: string, projectCwd: string): void {
	if (!hasGitDir(workspace)) {
		throw new BoxError({ message: "This box has no Git repository, so its changes cannot be synced." });
	}
	if (!hasGitDir(projectCwd)) {
		throw new BoxError({ message: `The project checkout is not a Git repository: ${projectCwd}` });
	}
	if (resolve(workspace) === resolve(projectCwd)) {
		throw new BoxError({ message: "The box workspace and project checkout are the same directory." });
	}
	if (!hasWorkspaceBaseline(workspace)) {
		throw new BoxError({
			message: "No sync baseline for this box; create a new box to enable sync.",
		});
	}
}

/** Build the incremental patch (baseline -> workspace) once for both sync modes. */
async function withWorkspacePatch<T>(
	workspace: string,
	projectCwd: string,
	fn: (patch: WorkspacePatch) => Promise<T>,
): Promise<T> {
	validateWorkspaceSync(workspace, projectCwd);
	const temp = mkdtempSync(join(tmpdir(), "relay-box-sync-"));
	const env = gitEnv({ GIT_INDEX_FILE: join(temp, "index") });
	const patch = join(temp, "changes.patch");
	try {
		await requireGit(workspace, ["read-tree", BASELINE_REF], "Could not load the box sync baseline", env);
		await requireGit(workspace, ["add", "-A", "."], "Could not snapshot the box changes", env);
		const names = await requireGit(
			workspace,
			["diff", "--cached", "--name-status", "--find-renames", "--no-ext-diff", BASELINE_REF],
			"Could not list the box changes",
			env,
		);
		const files = parseNameStatus(names.stdout);
		if (files.length === 0) {
			return await fn({ projectCwd, files, patchPath: "", tree: "" });
		}
		const tree = (
			await requireGit(workspace, ["write-tree"], "Could not write the workspace tree", env)
		).stdout.trim();
		await requireGit(
			workspace,
			["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", `--output=${patch}`, BASELINE_REF],
			"Could not build the box change patch",
			env,
		);
		return await fn({ projectCwd, files, patchPath: patch, tree });
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

async function syncWorkspaceUnlocked(workspace: string, projectCwd: string): Promise<BoxSyncResult> {
	return await withWorkspacePatch(workspace, projectCwd, async ({ files, patchPath }) => {
		if (files.length === 0) {
			return { projectCwd, files, summary: summaryFor(files, projectCwd) };
		}
		const check = await runGit(projectCwd, ["apply", "--binary", "--check", patchPath]);
		if (check.code !== 0) {
			throw new BoxError({
				message:
					`Could not apply the box changes to ${projectCwd}; the checkout may have changed since the box was cloned.\n` +
					`${check.stderr.trim() || check.stdout.trim()}`,
			});
		}
		await requireGit(
			projectCwd,
			["apply", "--binary", "--whitespace=nowarn", patchPath],
			"Could not apply the box changes",
		);
		await createWorkspaceBaseline(workspace);
		return { projectCwd, files, summary: summaryFor(files, projectCwd) };
	});
}

function threadBranchRef(branch: string): string {
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
		throw new BoxError({ message: `Invalid thread branch name: ${branch}` });
	}
	return `refs/heads/${branch}`;
}

function branchSummary(files: BoxSyncFile[], branch: string, commit: string): string {
	if (files.length === 0) return "No workspace changes to commit.";
	return (
		`Committed ${files.length} change${files.length === 1 ? "" : "s"} to ${branch} (${commit.slice(0, 8)}).\n` +
		files.map((file) => `${file.status}\t${file.path}`).join("\n")
	);
}

/**
 * Commit the workspace changes to a dedicated branch in the project repository.
 *
 * The project checkout is never modified. The patch is three-way applied onto
 * the branch tip (or the project's current HEAD for a new branch), so a dirty
 * project checkout and an advanced project branch can coexist with a thread.
 * The result can be reviewed with `git diff <base>...<branch>` or merged with
 * `git merge <branch>`.
 */
export async function syncWorkspaceToBranch(
	workspace: string,
	projectCwd: string,
	branch: string,
): Promise<BoxSyncResult> {
	const branchRef = threadBranchRef(branch);
	return await withProjectSyncLock(projectCwd, () =>
		withWorkspacePatch(workspace, projectCwd, async ({ files, patchPath, tree }) => {
			if (files.length === 0) {
				return { projectCwd, files, summary: branchSummary(files, branch, ""), branch };
			}

			const base = (
				await requireGit(workspace, ["rev-parse", BASELINE_REF], "Could not resolve the workspace baseline")
			).stdout.trim();
			const syncCommit = (
				await requireGit(
					workspace,
					["commit-tree", tree, "-p", base, "-m", `Relay thread ${branch} snapshot`],
					"Could not snapshot the workspace for branch sync",
				)
			).stdout.trim();
			await requireGit(
				workspace,
				["update-ref", "refs/relay/sync", syncCommit],
				"Could not store the workspace sync snapshot",
			);

			const tempRef = `refs/relay/tmp/${process.pid}-${Date.now()}`;
			const fetched = await runGit(projectCwd, ["fetch", "--no-tags", workspace, `refs/relay/sync:${tempRef}`]);
			if (fetched.code !== 0) {
				throw new BoxError({
					message: `Could not fetch the workspace snapshot into ${projectCwd}.\n${
						fetched.stderr.trim() || fetched.stdout.trim()
					}`,
				});
			}

			const projectTemp = mkdtempSync(join(tmpdir(), "relay-thread-branch-"));
			const projectEnv = gitEnv({ GIT_INDEX_FILE: join(projectTemp, "index") });
			try {
				const head = await runGit(projectCwd, ["rev-parse", "--verify", "HEAD"]);
				const target =
					(await runGit(projectCwd, ["rev-parse", "--verify", branchRef])).code === 0
						? (
								await requireGit(
									projectCwd,
									["rev-parse", "--verify", branchRef],
									"Could not read the thread branch",
								)
							).stdout.trim()
						: head.code === 0
							? head.stdout.trim()
							: base;
				await requireGit(projectCwd, ["read-tree", target], "Could not seed the thread branch", projectEnv);
				const applied = await runGit(
					projectCwd,
					["apply", "--cached", "--3way", "--binary", "--whitespace=nowarn", patchPath],
					projectEnv,
				);
				if (applied.code !== 0) {
					throw new BoxError({
						message:
							`The workspace changes conflict with ${target === base ? "the workspace base" : "the project branch"}.\n` +
							`The project checkout was not modified. Resolve the conflict manually or rebase the thread branch.\n` +
							`${applied.stderr.trim() || applied.stdout.trim()}`,
					});
				}
				const nextTree = (
					await requireGit(projectCwd, ["write-tree"], "Could not write the thread branch tree", projectEnv)
				).stdout.trim();
				const commit = (
					await requireGit(
						projectCwd,
						[
							"commit-tree",
							nextTree,
							"-p",
							target,
							"-m",
							`Relay thread ${branch}: ${files.length} change${files.length === 1 ? "" : "s"}`,
						],
						"Could not commit the thread branch",
						projectEnv,
					)
				).stdout.trim();
				await requireGit(projectCwd, ["update-ref", branchRef, commit], "Could not update the thread branch");
				await createWorkspaceBaseline(workspace);
				return {
					projectCwd,
					files,
					summary: branchSummary(files, branch, commit),
					branch,
					commit,
				};
			} finally {
				rmSync(projectTemp, { recursive: true, force: true });
				await runGit(projectCwd, ["update-ref", "-d", tempRef]);
			}
		}),
	);
}
