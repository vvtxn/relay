import { collectCommand, spawnCommand } from "../command.ts";
import { scrubbedAgentEnv } from "../env.ts";
import { defineTool, type Tool } from "./types.ts";

const MAX_OUTPUT = 10_000;
const DEFAULT_TIMEOUT = 30_000;

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

				const timeoutMs = timeout ?? DEFAULT_TIMEOUT;
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

				let output = "";
				if (stdout) output += stdout;
				if (stderr) output += (output ? "\n" : "") + `stderr:\n${stderr}`;
				if (!output) output = "(no output)";

				const truncated = output.length > MAX_OUTPUT;
				if (truncated) {
					output = output.slice(0, MAX_OUTPUT) + "\n...(truncated)";
				}

				return {
					content: result.success ? output : `exit code ${result.code}\n${output}`,
					isError: !result.success,
					meta: { truncated, durationMs },
				};
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
