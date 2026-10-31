import { Effect } from "effect";
import { isPreparedBoxImage } from "@vvtxn/box/images.ts";
import { isBoxProfile, profileForSettings } from "@vvtxn/box/profiles.ts";
import type { BoxManager, BoxStatus } from "@vvtxn/box/types.ts";
import { bashToolDefinition, BASH_DEFAULT_TIMEOUT, formatShellResult } from "@vvtxn/relay/core/tools/bash.ts";
import type { Tool, ToolResult } from "@vvtxn/relay/core/tools/types.ts";
import type { SandboxProvider } from "./sandbox.ts";

/**
 * The normal bash tool, routed into a box lease. It keeps the same schema and
 * output shape as `createBashTool`, but the VM is the execution boundary.
 */
export function createBoxBashTool(provider: SandboxProvider): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: bashToolDefinition.name,
				description: bashToolDefinition.description,
				parameters: bashToolDefinition.parameters,
			},
		},
		usageHint: bashToolDefinition.usageHint,
		execute: (input): Effect.Effect<ToolResult> =>
			Effect.gen(function* () {
				const { command, timeout } = (input ?? {}) as { command?: unknown; timeout?: unknown };
				if (typeof command !== "string" || command.trim().length === 0) {
					return { content: "A non-empty command is required.", isError: true };
				}
				const timeoutMs =
					typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
						? timeout
						: BASH_DEFAULT_TIMEOUT;

				const result = yield* provider
					.withLease((lease) => lease.exec(command, { timeoutMs }))
					.pipe(
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

				return formatShellResult(result);
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
	];
	if (isPreparedBoxImage(status.settings.image)) {
		lines.push("Browser tooling: Playwright + Chromium embedded");
	}
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
export function createBoxTool(manager: BoxManager, provider: SandboxProvider): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: "box",
				description:
					"Inspect or resize the managed box used by bash and browser tools, or commit the session workspace changes to its thread branch (or the project checkout when thread branches are disabled). Start tiny; use small or medium when the task needs Playwright/browser tests, large builds, or several services. The prepared box already contains Playwright and Chromium; verify UI changes before reporting done. Resizing is live and does not recreate the workspace.",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["status", "resize", "sync"],
							description:
								"Inspect the current box, change its resource profile, or commit the workspace changes to the thread branch.",
						},
						size: {
							type: "string",
							enum: ["tiny", "small", "medium"],
							description: "Target profile for the resize action.",
						},
					},
					required: ["action"],
					additionalProperties: false,
				},
			},
		},
		usageHint:
			"Start with tiny. Before Playwright/browser tests, big builds, or several services, resize to small or medium. The prepared box has Playwright + Chromium; do not install browsers. Resize back down when heavy work is done; other boxes share the host budget. After verifying a completed change, use action sync to commit it to the thread branch; completed runs commit automatically as a fallback.",
		execute: (input): Effect.Effect<ToolResult> =>
			Effect.gen(function* () {
				const { action, size } = (input ?? {}) as { action?: unknown; size?: unknown };
				if (action === "sync") {
					if (!provider.syncAvailable) {
						return {
							content:
								"This workspace has no sync baseline (the project is not a Git repository). Changes stay in the workspace.",
							isError: true,
						};
					}
					const synced = yield* provider.sync().pipe(
						Effect.map((result) => ({ ok: true as const, result })),
						Effect.catchTag("BoxError", (error) => Effect.succeed({ ok: false as const, error })),
					);
					if (!synced.ok) {
						return {
							content: `Could not sync the workspace changes: ${synced.error.message}`,
							isError: true,
						};
					}
					return { content: synced.result.summary };
				}
				if (action === "status" || action === undefined) {
					const result = yield* provider.status().pipe(
						Effect.map((status) => ({ ok: true as const, status })),
						Effect.catchTag("BoxError", (error) => Effect.succeed({ ok: false as const, error })),
					);
					if (!result.ok) {
						return { content: `Could not read the box: ${result.error.message}`, isError: true };
					}
					if (!result.status) {
						return {
							content:
								"No box is leased for this run yet. The first bash or browser call provisions one; use resize to provision it now.",
						};
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
				const result = yield* provider
					.withLease((lease) => manager.resize(lease.boxId, size))
					.pipe(
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
