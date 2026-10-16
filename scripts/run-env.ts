import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Mode-aware environment loader.
 *
 * The task runner has no reliable "load these env files if they exist" story
 * with explicit precedence, so this wrapper merges the env files itself and
 * then spawns the entrypoint with the merged environment.
 *
 * Usage: `node scripts/run-env.ts <entrypoint> [args...]`
 * Mode:  `RELAY_ENV=development|production` (default: `development`)
 */

export const MODES = ["development", "production"] as const;
export type Mode = (typeof MODES)[number];

export function resolveMode(value: string | undefined): Mode {
	return value === "production" ? "production" : "development";
}

/** Env files from most specific to least specific. */
export function envFileCandidates(mode: Mode): string[] {
	return [`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"];
}

/**
 * Merge env files into one record with explicit precedence:
 * process env > `.env.<mode>.local` > `.env.<mode>` > `.env.local` > `.env`.
 *
 * `read` returns a file's parsed values, or `null` when it does not exist. It
 * may consult several directories (see {@link envRoots}); the most specific
 * location available for a given file wins.
 */
export function resolveEnv(
	mode: Mode,
	read: (path: string) => Record<string, string | undefined> | null,
	processEnv: Record<string, string | undefined>,
): Record<string, string> {
	const merged: Record<string, string> = {};
	// Least specific first so later (more specific) files overwrite.
	for (const path of envFileCandidates(mode).reverse()) {
		const values = read(path);
		if (!values) continue;
		for (const [key, value] of Object.entries(values)) {
			if (value !== undefined) merged[key] = value;
		}
	}
	// The real process environment always wins.
	for (const [key, value] of Object.entries(processEnv)) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

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
 * Directories to read env files from, least to most specific: the main
 * worktree, the current worktree root, then the working directory. Gitignored
 * env files are not copied into linked worktrees, so falling back to the main
 * checkout keeps tasks like `pnpm relay` working there.
 */
export function envRoots(cwd: string): string[] {
	const current = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	const mainLine = gitOutput(cwd, ["worktree", "list", "--porcelain"])
		?.split("\n")
		.find((line) => line.startsWith("worktree "));
	const main = mainLine?.slice("worktree ".length).trim();
	const roots = [main, current, cwd].filter((root): root is string => !!root);
	return [...new Set(roots)];
}

/** Read a relative env file from the most specific root that has it. */
function readEnvFromRoots(roots: string[], relative: string): Record<string, string | undefined> | null {
	let found: Record<string, string | undefined> | null = null;
	for (const root of roots) {
		const values = readEnvFile(join(root, relative));
		if (values) found = values;
	}
	return found;
}

/** Merge only the env files for a mode (no process environment). */
export function loadEnvFiles(mode: Mode): Record<string, string> {
	const roots = envRoots(process.cwd());
	return resolveEnv(mode, (path) => readEnvFromRoots(roots, path), {});
}

function main(): void {
	const mode = resolveMode(process.env.RELAY_ENV);
	const roots = envRoots(process.cwd());
	const merged = resolveEnv(mode, (path) => readEnvFromRoots(roots, path), process.env);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(merged)) env[key] = value;
	env.RELAY_ENV = mode;

	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: node scripts/run-env.ts <entrypoint> [args...]");
		process.exit(2);
	}

	const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
	process.exit(result.status ?? 1);
}

if (import.meta.main) {
	main();
}
