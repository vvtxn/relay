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
		const commit = (
			await requireGit(
				workspace,
				["commit-tree", tree, "-m", "Relay box sync baseline"],
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
			return { projectCwd, files, summary: summaryFor(files, projectCwd) };
		}

		await requireGit(
			workspace,
			["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", `--output=${patch}`, BASELINE_REF],
			"Could not build the box change patch",
			env,
		);
		const check = await runGit(projectCwd, ["apply", "--binary", "--check", patch]);
		if (check.code !== 0) {
			throw new BoxError({
				message:
					`Could not apply the box changes to ${projectCwd}; the checkout may have changed since the box was cloned.\n` +
					`${check.stderr.trim() || check.stdout.trim()}`,
			});
		}
		await requireGit(
			projectCwd,
			["apply", "--binary", "--whitespace=nowarn", patch],
			"Could not apply the box changes",
		);
		await createWorkspaceBaseline(workspace);
		return { projectCwd, files, summary: summaryFor(files, projectCwd) };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}
