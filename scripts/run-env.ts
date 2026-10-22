import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Environment loader for source commands.
 *
 * Relay uses one `.env` (gitignored) plus `.env.example`. Files are resolved
 * from the main worktree, the current worktree root, and the working directory;
 * the process environment always wins. Usage:
 *
 *   node scripts/run-env.ts <entrypoint> [args...]
 */

function readEnvFile(path: string): Record<string, string | undefined> | null {
	try {
		return parseEnv(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function gitOutput(cwd: string, args: string[]): string | null {
	try {
		const result = spawnSync("git", ["-C", cwd, ...args], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.error || result.status !== 0) return null;
		return result.stdout.toString();
	} catch {
		return null;
	}
}

/**
 * Directories to read `.env` from, least to most specific: the main worktree,
 * the current worktree root, then the working directory. Gitignored env files
 * are not copied into linked worktrees, so falling back to the main checkout
 * keeps `pnpm relay` working there.
 */
function envRoots(cwd: string): string[] {
	const current = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	const mainLine = gitOutput(cwd, ["worktree", "list", "--porcelain"])
		?.split("\n")
		.find((line) => line.startsWith("worktree "));
	const main = mainLine?.slice("worktree ".length).trim();
	const roots = [main, current, cwd].filter((root): root is string => !!root);
	return [...new Set(roots)];
}

function loadEnv(processEnv: Record<string, string | undefined>): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const root of envRoots(process.cwd())) {
		const values = readEnvFile(join(root, ".env"));
		if (!values) continue;
		for (const [key, value] of Object.entries(values)) {
			// Empty values count as unset, matching server config parsing.
			if (value) merged[key] = value;
		}
	}
	for (const [key, value] of Object.entries(processEnv)) {
		if (value) merged[key] = value;
	}
	return merged;
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: node scripts/run-env.ts <entrypoint> [args...]");
		process.exit(2);
	}

	const result = spawnSync(process.execPath, args, { env: loadEnv(process.env), stdio: "inherit" });
	process.exit(result.status ?? 1);
}

if (import.meta.main) {
	main();
}
