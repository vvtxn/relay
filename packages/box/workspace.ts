import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BoxError } from "./errors.ts";
import { sanitizeWorkspace } from "./sanitize.ts";

const COPY_TIMEOUT_MS = 5 * 60_000;
const MIN_FREE_BYTES = 512 * 1024 * 1024;

function run(command: string, args: string[], timeoutMs = COPY_TIMEOUT_MS): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new BoxError({ message: `${command} timed out after ${timeoutMs}ms` }));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise();
			else reject(new BoxError({ message: `${command} exited with code ${code}: ${stderr.trim()}` }));
		});
	});
}

function capture(command: string, args: string[], timeoutMs = COPY_TIMEOUT_MS): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new BoxError({ message: `${command} timed out after ${timeoutMs}ms` }));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else reject(new BoxError({ message: `${command} exited with code ${code}: ${stderr.trim()}` }));
		});
	});
}

/**
 * SSH remotes cannot use the box's token-based askpass helper. Rewrite pushes
 * over SSH to HTTPS inside the clone (the original checkout is untouched), so
 * the mirrored `GITHUB_TOKEN` authenticates git as well as the GitHub CLI.
 */
export async function configureGitRemotes(workspace: string): Promise<void> {
	let remotes: string[];
	try {
		remotes = (await capture("git", ["-C", workspace, "remote"]))
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return;
	}
	for (const remote of remotes) {
		try {
			const url = (await capture("git", ["-C", workspace, "remote", "get-url", remote])).trim();
			const rule = httpsRewriteFor(url);
			if (!rule) continue;
			const key = `url.https://${rule.host}/.insteadOf`;
			const existing = await capture("git", ["-C", workspace, "config", "--local", "--get-all", key]).catch(
				() => "",
			);
			if (existing.split("\n").includes(rule.prefix)) continue;
			await run("git", ["-C", workspace, "config", "--local", "--add", key, rule.prefix]);
		} catch {
			// Push authentication is best-effort; the workspace is still usable.
		}
	}
}

function httpsRewriteFor(remote: string): { host: string; prefix: string } | null {
	const scp = /^[^@/\s]+@([^:/\s]+):/.exec(remote);
	if (scp?.[1]) {
		const separator = remote.indexOf(":");
		return { host: scp[1], prefix: remote.slice(0, separator + 1) };
	}
	try {
		const parsed = new URL(remote);
		if (parsed.protocol !== "ssh:" && parsed.protocol !== "git:") return null;
		const user = parsed.username ? `${parsed.username}@` : "";
		return { host: parsed.host, prefix: `${parsed.protocol}//${user}${parsed.host}/` };
	} catch {
		return null;
	}
}

function checkFreeSpace(destinationParent: string): void {
	try {
		const stats = statfsSync(destinationParent);
		const free = Number(stats.bavail) * Number(stats.bsize);
		if (free < MIN_FREE_BYTES) {
			throw new BoxError({
				message: `Not enough free space for a box workspace at ${destinationParent} (${Math.round(free / 1024 / 1024)} MiB free)`,
			});
		}
	} catch (error) {
		if (error instanceof BoxError) throw error;
		// statfs is not available everywhere; the copy reports the real failure.
	}
}

function isLinkedWorktree(projectCwd: string): boolean {
	try {
		return lstatSync(join(projectCwd, ".git")).isFile();
	} catch {
		return false;
	}
}

async function gitToplevel(projectCwd: string): Promise<string> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-C", projectCwd, "rev-parse", "--show-toplevel"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0 && stdout.trim()) resolvePromise(stdout.trim());
			else reject(new BoxError({ message: `Could not resolve the main Git worktree: ${stderr.trim()}` }));
		});
	});
}

async function copyNormalRepository(projectCwd: string, destination: string): Promise<void> {
	if (process.platform === "linux") {
		await run("cp", ["-a", "--reflink=auto", `${projectCwd}/.`, `${destination}/`]);
		return;
	}
	if (process.platform === "darwin") {
		try {
			await run("cp", ["-a", "-c", `${projectCwd}/.`, `${destination}/`]);
			return;
		} catch {
			// APFS clone flags are not available on every macOS filesystem.
		}
	}
	await cp(projectCwd, destination, {
		recursive: true,
		filter: (source) => {
			const rel = relative(projectCwd, source);
			return rel !== ".relay" && !rel.startsWith(`.relay${sep}`);
		},
	});
}

async function copyLinkedWorktree(projectCwd: string, destination: string): Promise<void> {
	const toplevel = await gitToplevel(projectCwd);
	await run("git", ["clone", "--no-hardlinks", toplevel, destination]);
	const cloneGit = join(destination, ".git");
	if (!existsSync(cloneGit)) {
		throw new BoxError({ message: "Git clone did not produce a standalone .git directory" });
	}
	// Overlay the worktree's dirty, untracked, and ignored files onto the clone.
	// Skip the worktree's .git file: it points at the main checkout.
	await cp(projectCwd, destination, {
		recursive: true,
		force: true,
		filter: (source) => {
			const rel = relative(projectCwd, source);
			return rel !== ".git" && rel !== ".relay" && !rel.startsWith(`.relay${sep}`);
		},
	});
}

/**
 * Materialize a self-contained workspace clone. Keeps .git, dirty state,
 * untracked files, and dependencies; removes host credentials afterwards.
 */
export async function prepareWorkspace(
	projectCwd: string,
	boxDir: string,
	boxWorkspace: string,
	excludes: string[] = [],
): Promise<string[]> {
	const source = resolve(projectCwd);
	if (!existsSync(source)) throw new BoxError({ message: `Project directory does not exist: ${source}` });
	if (!lstatSync(source).isDirectory()) throw new BoxError({ message: `Project path is not a directory: ${source}` });

	mkdirSync(boxDir, { recursive: true, mode: 0o700 });
	checkFreeSpace(boxDir);

	const temp = mkdtempSync(join(boxDir, "workspace.tmp-"));
	try {
		if (isLinkedWorktree(source)) await copyLinkedWorktree(source, temp);
		else await copyNormalRepository(source, temp);

		rmSync(join(temp, ".relay"), { recursive: true, force: true });
		const removed = await sanitizeWorkspace(temp, excludes);
		await configureGitRemotes(temp);

		if (existsSync(boxWorkspace)) {
			throw new BoxError({ message: `Box workspace already exists: ${boxWorkspace}` });
		}
		renameSync(temp, boxWorkspace);
		return removed;
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}

/** Remove an incomplete workspace clone left by a crash. */
export function cleanupTempWorkspaces(boxDir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(boxDir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith("workspace.tmp-")) continue;
		rmSync(join(boxDir, entry), { recursive: true, force: true });
	}
}
