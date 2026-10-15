import { Effect, Semaphore, Stream } from "effect";
import type { LLMProvider } from "#/api/types.ts";
import { run, type AgentConfig } from "../agent.ts";
import type { TrimOptions } from "../context.ts";
import type { Tool, ToolRegistry, ToolResult } from "./types.ts";

const DEFAULT_MAX_TOOL_ROUNDS = 10;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_REPORT_CHARS = 10_000;

const DELEGATE_DESCRIPTION =
	"Delegate a self-contained investigation to a read-only subagent. The subagent runs its own agent loop, sees " +
	"none of this conversation, and returns one final report — pass a complete, specific prompt (what to find, where " +
	"to look, what the report should contain). Issue several delegate calls in one turn to run investigations in " +
	"parallel, and prefer delegating broad exploration that would flood your own context.";

const SUBAGENT_INSTRUCTIONS = `## Delegation

You are a subagent: the main coding assistant delegated one focused investigation to you. You have read-only access
to the workspace and cannot modify files. Work autonomously — nobody can answer questions mid-task. When the
investigation is done, reply with a concise report for the caller: the relevant file paths and line references, what
you concluded, and any open questions.`;

/** Options for {@link createDelegateTool}. */
export interface DelegateToolOptions {
	provider: LLMProvider;
	model: string;
	/** Base system prompt; the delegation instructions are appended. */
	systemPrompt: string;
	/** Tools available to subagents. Should be readonly; `delegate` is not re-added. */
	tools: ToolRegistry;
	maxToolRounds?: number;
	/** Maximum subagents executing at the same time (extra calls queue). */
	maxConcurrency?: number;
	temperature?: number;
	maxTokens?: number;
	contextLimit?: TrimOptions;
	/** Parent run's abort signal, so cancelling the run cancels its subagents. */
	signal?: AbortSignal;
}

/**
 * Creates the `delegate` tool: a subagent factory over the same agent loop.
 *
 * Each call runs a fresh, fully isolated `run()` (no conversation history)
 * with the read-only tool registry it was given, and returns the subagent's
 * final report as a normal `ToolResult`. Subagent cost is aggregated into
 * `meta.cost` so the server can add it to the session total. The tool is
 * marked `readonly`: it never mutates the workspace, so calls skip approval
 * and run alongside other read-only work; `maxConcurrency` bounds how many
 * subagent loops execute at once.
 */
export function createDelegateTool(options: DelegateToolOptions): Tool {
	const limit = Semaphore.makeUnsafe(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	const systemPrompt = `${options.systemPrompt}\n\n${SUBAGENT_INSTRUCTIONS}`;

	return {
		definition: {
			type: "function",
			function: {
				name: "delegate",
				description: DELEGATE_DESCRIPTION,
				parameters: {
					type: "object",
					properties: {
						prompt: {
							type: "string",
							description:
								"The complete task for the subagent, including what to find and what the report should contain.",
						},
						description: {
							type: "string",
							description: 'Short label for the UI, e.g. "Find auth entry points".',
						},
					},
					required: ["prompt"],
				},
			},
		},
		readonly: true,
		execute: (input) =>
			Effect.gen(function* () {
				const { prompt } = (input ?? {}) as { prompt?: unknown };
				if (typeof prompt !== "string" || prompt.trim().length === 0) {
					return { content: "Error [delegate]: a non-empty `prompt` is required.", isError: true };
				}
				return yield* Semaphore.withPermit(limit)(runSubagent(prompt, options, systemPrompt));
			}),
	};
}

function runSubagent(prompt: string, options: DelegateToolOptions, systemPrompt: string): Effect.Effect<ToolResult> {
	const state: { report: string; cost: number; failed: Error | null } = {
		report: "",
		cost: 0,
		failed: null,
	};

	const config: AgentConfig = {
		provider: options.provider,
		model: options.model,
		systemPrompt,
		tools: options.tools,
		maxToolRounds: options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
		...(options.contextLimit !== undefined ? { contextLimit: options.contextLimit } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	};

	return Effect.gen(function* () {
		const started = Date.now();
		yield* Stream.runForEach(run([{ role: "user", content: prompt }], config), (event) =>
			Effect.sync(() => {
				switch (event.type) {
					case "message_complete":
						state.cost += event.usage?.cost ?? 0;
						return;
					case "turn_complete":
						// The concluding turn (no tool results) carries the report.
						if (event.toolResults.length === 0) state.report = event.assistantMessage.content ?? "";
						return;
					case "error":
						state.failed = event.error;
						return;
					default:
						return;
				}
			}),
		);

		const meta: ToolResult["meta"] = {
			durationMs: Math.round(Date.now() - started),
			...(state.cost > 0 ? { cost: state.cost } : {}),
		};

		if (options.signal?.aborted) {
			return { content: "Delegation cancelled.", isError: true, meta };
		}
		if (state.failed) {
			return { content: `Delegation failed: ${state.failed.message}`, isError: true, meta };
		}
		if (!state.report.trim()) {
			return { content: "Delegation finished without a report.", isError: true, meta };
		}
		return { content: truncateReport(state.report), meta };
	});
}

function truncateReport(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n...(truncated)`;
}
