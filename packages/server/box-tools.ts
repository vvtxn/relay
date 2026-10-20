import { Effect } from "effect";
import type { BoxLease } from "@vvtxn/box/types.ts";
import { bashToolDefinition } from "@vvtxn/relay/core/tools/bash.ts";
import type { Tool, ToolResult } from "@vvtxn/relay/core/tools/types.ts";

const MAX_OUTPUT = 10_000;
const DEFAULT_TIMEOUT = 30_000;

/**
 * The normal bash tool, routed into a box lease. It keeps the same schema and
 * output shape as `createBashTool`, but the VM is the execution boundary.
 */
export function createBoxBashTool(lease: BoxLease): Tool {
	return {
		definition: {
			type: "function",
			function: {
				...bashToolDefinition,
				parameters: bashToolDefinition.parameters,
			},
		},
		confined: true,
		usageHint: bashToolDefinition.usageHint,
		execute: (input): Effect.Effect<ToolResult> =>
			Effect.gen(function* () {
				const { command, timeout } = (input ?? {}) as { command?: unknown; timeout?: unknown };
				if (typeof command !== "string" || command.trim().length === 0) {
					return { content: "A non-empty command is required.", isError: true };
				}
				const timeoutMs =
					typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT;

				const result = yield* lease.exec(command, { timeoutMs }).pipe(
					Effect.catchTag("BoxError", (error) =>
						Effect.succeed({
							code: 1,
							stdout: "",
							stderr: error.message,
							durationMs: 0,
							truncated: false,
						}),
					),
				);

				let output = "";
				if (result.stdout) output += result.stdout;
				if (result.stderr) output += (output ? "\n" : "") + `stderr:\n${result.stderr}`;
				if (!output) output = "(no output)";
				const truncated = result.truncated || output.length > MAX_OUTPUT;
				if (output.length > MAX_OUTPUT) {
					output = output.slice(0, MAX_OUTPUT) + "\n...(truncated)";
				}

				return {
					content: result.code === 0 ? output : `exit code ${result.code}\n${output}`,
					isError: result.code !== 0,
					meta: { truncated, durationMs: result.durationMs },
				};
			}),
	};
}
