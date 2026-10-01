/**
 * Mode-aware environment loader.
 *
 * Deno's `--env-file` has no "if exists" variant and its multi-file precedence
 * is documented inconsistently (the CLI help and the docs disagree), so this
 * wrapper merges the env files explicitly and then spawns the entrypoint.
 *
 * Usage: `deno run -A scripts/run-env.ts <deno-run-args...>`
 * Mode:  `RELAY_ENV=development|production` (default: `development`)
 */

import { loadSync } from "@std/dotenv";

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
 * `read` returns a file's parsed values, or `null` when it does not exist.
 */
export function resolveEnv(
	mode: Mode,
	read: (path: string) => Record<string, string> | null,
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

function readEnvFile(path: string): Record<string, string> | null {
	try {
		Deno.statSync(path);
	} catch {
		return null;
	}
	return loadSync({ envPath: path, export: false }) as Record<string, string>;
}

/** Merge only the env files for a mode (no process environment). */
export function loadEnvFiles(mode: Mode): Record<string, string> {
	return resolveEnv(mode, readEnvFile, {});
}

async function main(): Promise<void> {
	const mode = resolveMode(Deno.env.get("RELAY_ENV"));
	const merged = resolveEnv(mode, readEnvFile, Deno.env.toObject());
	for (const [key, value] of Object.entries(merged)) Deno.env.set(key, value);
	Deno.env.set("RELAY_ENV", mode);

	const args = Deno.args;
	if (args.length === 0) {
		console.error("Usage: deno run -A scripts/run-env.ts <deno-run-args...>");
		Deno.exit(2);
	}

	const command = new Deno.Command(Deno.execPath(), {
		args: ["run", ...args],
		env: Deno.env.toObject(),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const status = await command.spawn().status;
	Deno.exit(status.code);
}

if (import.meta.main) {
	await main();
}
