import { Effect } from "effect";
import { isBoxProfile, profileForSettings } from "@vvtxn/box/profiles.ts";
import type { BoxLease, BoxManager, BoxStatus } from "@vvtxn/box/types.ts";
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

function describeStatus(status: BoxStatus): string {
	const profile = profileForSettings(status.settings);
	const capacity = status.capacity;
	const lines = [
		`Box ${status.boxId}`,
		`State: ${status.state}`,
		`Profile: ${profile} (${status.settings.cpus} vCPU, ${status.settings.memoryMiB} MiB RAM, ${status.settings.rootDiskMiB} MiB disk)`,
		`Attachments: ${status.attachments.length === 0 ? "(none)" : status.attachments.map((a) => a.sessionId).join(", ")}`,
	];
	if (capacity) {
		lines.push(
			`Capacity: ${capacity.running}/${capacity.maxRunning} boxes, ` +
				`${capacity.usedCpus}/${capacity.maxCpus} vCPU, ` +
				`${capacity.usedMemoryMiB}/${capacity.maxMemoryMiB} MiB RAM`,
		);
	}
	if (status.pausedAt) lines.push(`Paused: ${status.pausedAt}`);
	if (status.error) lines.push(`Error: ${status.error}`);
	return lines.join("\n");
}

/**
 * Model-facing box control. The manager is the authority: this tool can ask
 * for a larger profile, but capacity/ceiling checks decide whether it applies.
 */
export function createBoxTool(manager: BoxManager, lease: BoxLease): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: "box",
				description:
					"Inspect or resize the isolated box that runs bash. Start tiny; use small or medium when the task needs Playwright/browser tests, large builds, or several services. Resizing is live and does not recreate the workspace.",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["status", "resize"],
							description: "Inspect the current box or change its resource profile.",
						},
						size: {
							type: "string",
							enum: ["tiny", "small", "medium"],
							description: "Target profile for the resize action.",
						},
						reason: {
							type: "string",
							description: "Short reason for the resize; shown in diagnostics.",
						},
					},
					required: ["action"],
					additionalProperties: false,
				},
			},
		},
		usageHint:
			"Start with tiny. Before Playwright/browser tests, big builds, or several services, resize to small or medium. Resize back down when heavy work is done; other boxes share the host budget.",
		execute: (input): Effect.Effect<ToolResult> =>
			Effect.gen(function* () {
				const { action, size } = (input ?? {}) as { action?: unknown; size?: unknown };
				if (action === "status" || action === undefined) {
					const result = yield* manager.status(lease.boxId).pipe(
						Effect.map((status) => ({ ok: true as const, status })),
						Effect.catchTag("BoxError", (error) => Effect.succeed({ ok: false as const, error })),
					);
					if (!result.ok) {
						return { content: `Could not read the box: ${result.error.message}`, isError: true };
					}
					if (!result.status) {
						return { content: `Could not find box ${lease.boxId}.`, isError: true };
					}
					return { content: describeStatus(result.status) };
				}
				if (action !== "resize") {
					const label = typeof action === "string" ? action : typeof action;
					return { content: `Unknown box action "${label}".`, isError: true };
				}
				if (!isBoxProfile(size)) {
					return { content: 'The resize action needs size "tiny", "small", or "medium".', isError: true };
				}
				const result = yield* manager.resize(lease.boxId, size).pipe(
					Effect.map((status) => ({ ok: true as const, status })),
					Effect.catchTag("BoxError", (error) => Effect.succeed({ ok: false as const, error })),
				);
				if (!result.ok) {
					return { content: `Could not resize the box: ${result.error.message}`, isError: true };
				}
				return { content: `Resized.\n\n${describeStatus(result.status)}` };
			}),
	};
}
