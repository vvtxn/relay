/**
 * Minimal child-process helpers shared across the relay packages.
 *
 * Mirrors the subset of `Deno.Command` the codebase used: capture output,
 * run synchronously, or spawn a raw child (for streaming, timeouts, and
 * detached background processes).
 */

import { type ChildProcess, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface CommandOptions {
	args?: readonly string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: "inherit" | "null";
	stdout?: "inherit" | "piped" | "null";
	stderr?: "inherit" | "piped" | "null";
}

export interface CommandResult {
	success: boolean;
	code: number;
	stdout: Uint8Array;
	stderr: Uint8Array;
}

type StdioValue = "inherit" | "pipe" | "ignore";

function stdio(value: "inherit" | "piped" | "null" | undefined): StdioValue {
	if (value === "inherit") return "inherit";
	if (value === "piped") return "pipe";
	return "ignore";
}

function spawnOptions(options: CommandOptions): SpawnOptions {
	const result: SpawnOptions = {
		stdio: [stdio(options.stdin), stdio(options.stdout), stdio(options.stderr)],
	};
	if (options.cwd !== undefined) result.cwd = options.cwd;
	if (options.env !== undefined) result.env = options.env;
	return result;
}

/** Spawns a child process with the given stdio configuration. */
export function spawnCommand(command: string, options: CommandOptions = {}): ChildProcess {
	return spawn(command, options.args ?? [], spawnOptions(options));
}

/** Waits for a spawned child and collects its piped output. */
export function collectCommand(child: ChildProcess): Promise<CommandResult> {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			resolve({
				success: code === 0,
				code: code ?? 1,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
	});
}

/** Runs a command to completion and collects its piped output. */
export async function runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
	return await collectCommand(spawnCommand(command, options));
}

export interface DetachedOptions {
	args: readonly string[];
	env?: Record<string, string>;
	/** Append stdout/stderr to this file instead of discarding them. */
	logFile?: string;
}

/**
 * Spawns a background process detached from the current session (its own
 * process group, so it survives the terminal closing). The caller is
 * responsible for calling `.unref()` when it should outlive the CLI.
 */
export function spawnDetached(command: string, options: DetachedOptions): ChildProcess {
	let logFd: number | undefined;
	let stdio: SpawnOptions["stdio"] = "ignore";
	if (options.logFile !== undefined) {
		logFd = openSync(options.logFile, "a");
		stdio = ["ignore", logFd, logFd];
	}
	try {
		const spawnOpts: SpawnOptions = { stdio, detached: true };
		if (options.env !== undefined) spawnOpts.env = options.env;
		return spawn(command, options.args, spawnOpts);
	} finally {
		if (logFd !== undefined) closeSync(logFd);
	}
}

/** Synchronous variant for startup paths that cannot await. */
export function runCommandSync(command: string, options: CommandOptions = {}): CommandResult {
	const result = spawnSync(command, options.args ?? [], spawnOptions(options));
	if (result.error) throw result.error;
	return {
		success: result.status === 0,
		code: result.status ?? 1,
		stdout: result.stdout ? new Uint8Array(result.stdout) : new Uint8Array(),
		stderr: result.stderr ? new Uint8Array(result.stderr) : new Uint8Array(),
	};
}
