import { collectCommand, spawnCommand } from "../command.ts";
import { scrubbedAgentEnv } from "../env.ts";
import { defineTool, type Tool, type ToolResult } from "./types.ts";

export const BASH_MAX_OUTPUT = 10_000;
export const BASH_DEFAULT_TIMEOUT = 30_000;

/** Shared model-facing definition so alternate executors (boxes) cannot drift. */
export const bashToolDefinition = {
	name: "bash",
	description:
		"Execute a shell command. Use only for running project scripts (e.g. pnpm run, vp run), build/test commands, git operations, and installing packages. Do NOT use bash for file reading, searching, or directory listing — use the dedicated tools (read_file, grep) instead. Commands run in the current working directory.",
	usageHint:
		"Run project scripts (`pnpm run`, `vp run`), build/test commands, git operations, and package installs. Do " +
		"NOT use bash for file reading, searching, or listing — use the dedicated tools. Avoid interactive commands " +
		"(REPLs, editors, password prompts) and background processes with `&`.",
	parameters: {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "The shell command to execute.",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds. Defaults to 30000.",
			},
		},
		required: ["command"],
	},
};

/** Normalize a shell result for the model, shared by host and box executors. */
export function formatShellResult(result: {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated?: boolean;
}): ToolResult {
	let output = "";
	if (result.stdout) output += result.stdout;
	if (result.stderr) output += (output ? "\n" : "") + `stderr:\n${result.stderr}`;
	if (!output) output = "(no output)";
	const outputTruncated = output.length > BASH_MAX_OUTPUT;
	if (outputTruncated) output = output.slice(0, BASH_MAX_OUTPUT) + "\n...(truncated)";
	return {
		content: result.code === 0 ? output : `exit code ${result.code}\n${output}`,
		isError: result.code !== 0,
		meta: {
			truncated: result.truncated === true || outputTruncated,
			durationMs: result.durationMs,
		},
	};
}

export interface BashToolOptions {
	/**
	 * Environment for spawned commands. Defaults to {@link scrubbedAgentEnv},
	 * so commands never inherit the server's credentials (database token,
	 * OAuth secrets, settings master key).
	 */
	env?: Record<string, string>;
}

/**
 * Creates the bash tool. When `cwd` is provided, commands run in that
 * directory (e.g. a session's workspace root); otherwise they inherit the
 * process working directory.
 */
export function createBashTool(cwd?: string, options: BashToolOptions = {}): Tool {
	const env = options.env ?? scrubbedAgentEnv();
	return defineTool({
		...bashToolDefinition,
		async execute(input) {
			const { command, timeout } = input as { command: string; timeout?: number };
			const start = performance.now();

			try {
				const child = spawnCommand("bash", {
					args: ["-c", command],
					...(cwd ? { cwd } : {}),
					env,
					stdout: "piped",
					stderr: "piped",
				});

				const timeoutMs = timeout ?? BASH_DEFAULT_TIMEOUT;
				const timer = setTimeout(() => {
					try {
						child.kill();
					} catch {
						// Process may have already exited
					}
				}, timeoutMs);

				const result = await collectCommand(child);
				clearTimeout(timer);

				const durationMs = Math.round(performance.now() - start);
				const stdout = new TextDecoder().decode(result.stdout);
				const stderr = new TextDecoder().decode(result.stderr);
				return formatShellResult({
					code: result.code,
					stdout,
					stderr,
					durationMs,
				});
			} catch (err) {
				return {
					content: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
					meta: { durationMs: Math.round(performance.now() - start) },
				};
			}
		},
	});
}

export const bashTool = createBashTool();
