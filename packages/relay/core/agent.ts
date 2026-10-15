import { Deferred, Duration, Effect, Queue, Schedule, Stream } from "effect";
import type { DeltaToolCall, LLMProvider, Message, ToolCall, Usage } from "#/api/types.ts";
import { ProviderError } from "../api/errors.ts";
import { getDefinitions } from "./tools/types.ts";
import type { ToolRegistry, ToolResult } from "#/core/tools/types.ts";
import { causeMessage } from "./effect.ts";
import { trimContext, type TrimOptions } from "./context.ts";

// ---------------------------------------------------------------------------
// Agent events — emitted by run() for the UI to consume
// ---------------------------------------------------------------------------

export type AgentEvent =
	| { type: "text_delta"; content: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; args: string }
	| { type: "tool_call_end"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; result: ToolResult }
	| { type: "message_complete"; usage?: Usage; generationId?: string }
	| { type: "turn_complete"; assistantMessage: Message; toolResults: Message[] }
	| { type: "error"; error: Error };

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

export interface AgentConfig {
	provider: LLMProvider;
	tools: ToolRegistry;
	model: string;
	systemPrompt: string;
	maxToolRounds?: number;
	temperature?: number;
	contextLimit?: TrimOptions;
	signal?: AbortSignal;
	maxTokens?: number;
}

const DEFAULT_MAX_TOOL_ROUNDS = 30;
const REFLECTION_INTERVAL = 12;
const MAX_API_RETRIES = 3;
const RETRY_BASE_DELAY = Duration.seconds(1);
const STREAM_TIMEOUT_SECONDS = 60;

// ---------------------------------------------------------------------------
// Agent loop (stream of events)
// ---------------------------------------------------------------------------

/**
 * Runs the agent loop and emits {@link AgentEvent}s.
 *
 * The stream never fails: provider failures are retried (exponential backoff
 * on retryable errors), and once the retry budget is exhausted — or any other
 * error surfaces — an `error` event is emitted and the stream completes, so
 * consumers render errors in-band. Consumption is interruptible: interrupting
 * the stream stops the in-flight provider call and tool execution.
 */
export function run(messages: Message[], config: AgentConfig): Stream.Stream<AgentEvent> {
	return Stream.callback<AgentEvent>((queue) =>
		runLoop(messages, config, (event) => Effect.sync(() => void Queue.offerUnsafe(queue, event))).pipe(
			// `Stream.callback` ends only when the queue ends; signal that here,
			// including when the loop is interrupted.
			Effect.ensuring(Effect.sync(() => void Queue.endUnsafe(queue))),
		),
	);
}

function runLoop(
	messages: Message[],
	config: AgentConfig,
	emit: (event: AgentEvent) => Effect.Effect<void>,
): Effect.Effect<void> {
	const maxRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
	const toolDefs = getDefinitions(config.tools);

	return Effect.gen(function* () {
		let context: Message[] = [{ role: "system", content: config.systemPrompt }, ...messages];
		const recentCallSignatures: string[] = [];

		for (let round = 0; round < maxRounds; round++) {
			if (config.signal?.aborted) return;

			// Self-reflection: after many tool rounds, prompt the model to assess progress
			// Uses "user" role so trimContext can drop it if context grows too large
			if (round > 0 && round % REFLECTION_INTERVAL === 0) {
				context.push({
					role: "user",
					content: `[system note] You have completed ${round} tool rounds. Briefly assess: are you making progress toward the user's goal? If stuck or repeating yourself, try a different approach.`,
				});
			}

			const useTools = toolDefs.length > 0;
			const effectiveContext = config.contextLimit ? trimContext(context, config.contextLimit) : context;

			// One LLM call, retried while the provider reports the failure as
			// transient. Per-attempt accumulators reset naturally on retry.
			const attemptResult = yield* Effect.gen(function* () {
				const textParts: string[] = [];
				const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();
				let lastUsage: Usage | undefined;
				let generationId: string | undefined;

				yield* Stream.runForEach(
					config.provider
						.stream({
							model: config.model,
							messages: effectiveContext,
							...(useTools ? { tools: toolDefs } : {}),
							...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
							...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
							...(config.signal !== undefined ? { signal: config.signal } : {}),
						})
						.pipe(
							Stream.timeoutOrElse({
								duration: Duration.seconds(STREAM_TIMEOUT_SECONDS),
								orElse: () =>
									Stream.fail(
										new ProviderError({
											message: `Stream timeout: no data received for ${STREAM_TIMEOUT_SECONDS}s`,
											retryable: true,
										}),
									),
							}),
						),
					(chunk) =>
						Effect.gen(function* () {
							if (chunk.id) generationId = chunk.id;
							if (chunk.usage) lastUsage = chunk.usage;

							const choice = chunk.choices[0];
							if (!choice) return;

							const delta = choice.delta;
							if (delta.content) {
								textParts.push(delta.content);
								yield* emit({ type: "text_delta", content: delta.content });
							}
							if (delta.tool_calls) {
								for (const tc of delta.tool_calls) {
									yield* processToolCallDelta(tc, toolCallAccumulator, emit);
								}
							}
						}),
				);

				// Emit tool_call_end with the fully accumulated name/args for any tool calls
				for (const [, tc] of toolCallAccumulator) {
					yield* emit({ type: "tool_call_end", id: tc.id, name: tc.name, args: tc.args });
				}

				// Build the completed assistant message
				const text = textParts.join("");
				const toolCalls = buildToolCalls(toolCallAccumulator);
				const assistantMessage: Message = {
					role: "assistant",
					content: text || null,
					...(toolCalls.length > 0 && { tool_calls: toolCalls }),
				};
				return { assistantMessage, toolCalls, lastUsage, generationId };
			}).pipe(
				Effect.retry({
					schedule: Schedule.exponential(RETRY_BASE_DELAY),
					while: (error: ProviderError) => error.retryable,
					times: MAX_API_RETRIES - 1,
				}),
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catchTag("ProviderError", (error) => Effect.succeed({ ok: false as const, error })),
			);

			if (!attemptResult.ok) {
				yield* emit({ type: "error", error: attemptResult.error });
				return;
			}

			const { assistantMessage, toolCalls, lastUsage, generationId } = attemptResult.value;
			context.push(assistantMessage);

			yield* emit({
				type: "message_complete",
				...(lastUsage ? { usage: lastUsage } : {}),
				...(generationId ? { generationId } : {}),
			});

			// If no tool calls, the LLM considers the task complete.
			if (toolCalls.length === 0) {
				yield* emit({ type: "turn_complete", assistantMessage, toolResults: [] });
				return;
			}

			// Loop detection: check if the model is repeating the exact same tool calls
			const callSignature = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).join("|");
			const repeated = recentCallSignatures.filter((s) => s === callSignature).length;
			recentCallSignatures.push(callSignature);
			if (recentCallSignatures.length > 10) recentCallSignatures.shift();

			if (repeated >= 2) {
				context.push({
					role: "user",
					content:
						"[system note] You have repeated the same tool calls 3 times. You are stuck in a loop. Stop and either try a completely different approach or respond to the user explaining what went wrong.",
				});
			}

			// Execute tool calls with dependency-aware ordering: readonly tools run
			// in parallel first; side-effect tools run concurrently across distinct
			// resources, while calls that share a resource (same file) or involve an
			// exclusive tool (e.g. bash) keep their relative order.
			const readonlyCalls = toolCalls.filter((tc) => config.tools.get(tc.function.name)?.readonly);
			const sideEffectCalls = toolCalls.filter((tc) => !config.tools.get(tc.function.name)?.readonly);

			const results: { tc: ToolCall; result: ToolResult }[] = [];
			if (readonlyCalls.length > 0) {
				results.push(
					...(yield* Effect.forEach(readonlyCalls, (tc) => executeTool(tc, config.tools, config.signal), {
						concurrency: "unbounded",
					})),
				);
			}
			if (sideEffectCalls.length > 0) {
				results.push(...(yield* executeSideEffectCalls(sideEffectCalls, config.tools, config.signal)));
			}

			// Emit results in original tool call order and collect tool result messages
			const resultById = new Map(results.map((entry) => [entry.tc.id, entry.result]));
			const toolResultMessages: Message[] = [];
			for (const tc of toolCalls) {
				const result = resultById.get(tc.id);
				if (!result) continue;
				yield* emit({ type: "tool_result", id: tc.id, result });
				const toolMsg: Message = {
					role: "tool",
					tool_call_id: tc.id,
					name: tc.function.name,
					content: result.content,
				};
				context.push(toolMsg);
				toolResultMessages.push(toolMsg);
			}

			if (config.contextLimit) {
				context = trimContext(context, config.contextLimit);
			}

			yield* emit({ type: "turn_complete", assistantMessage, toolResults: toolResultMessages });

			// Loop back to call the LLM again with tool results
		}

		yield* emit({ type: "error", error: new Error(`Exceeded maximum tool rounds (${maxRounds})`) });
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function executeTool(
	tc: ToolCall,
	tools: ToolRegistry,
	signal?: AbortSignal,
): Effect.Effect<{ tc: ToolCall; result: ToolResult }> {
	return Effect.gen(function* () {
		if (signal?.aborted) {
			return { tc, result: { content: "Aborted.", isError: true } };
		}

		const tool = tools.get(tc.function.name);
		if (!tool) {
			return { tc, result: enrichError(tc.function.name, `Unknown tool: ${tc.function.name}`, "unknown_tool") };
		}

		let parsedArgs: unknown;
		try {
			parsedArgs = JSON.parse(tc.function.arguments);
		} catch {
			return { tc, result: enrichError(tc.function.name, tc.function.arguments, "invalid_args") };
		}

		sanitizeToolArgs(tc.function.name, parsedArgs);

		const result = yield* tool.execute(parsedArgs).pipe(
			// Tools report expected failures as `ToolResult.isError` values; only
			// unexpected throws reach this handler.
			Effect.catchCause((cause) =>
				Effect.succeed(enrichError(tc.function.name, causeMessage(cause), "execution")),
			),
		);
		return { tc, result };
	});
}

/**
 * Executes side-effect tool calls with dependency-aware concurrency. A call
 * waits for every earlier call that touches the same resource (as declared by
 * `Tool.resourceKey`), and a call without a resource key is exclusive: it waits
 * for all earlier calls and blocks all later ones. Independent calls overlap.
 * Results are returned in call order.
 */
function executeSideEffectCalls(
	calls: ToolCall[],
	tools: ToolRegistry,
	signal?: AbortSignal,
): Effect.Effect<{ tc: ToolCall; result: ToolResult }[]> {
	return Effect.gen(function* () {
		const entries = calls.map((tc, index) => ({
			tc,
			index,
			key: resourceKeyFor(tc, tools),
			completed: Deferred.makeUnsafe<void>(),
		}));

		const results = yield* Effect.forEach(
			entries,
			(entry) =>
				Effect.gen(function* () {
					for (const earlier of entries.slice(0, entry.index)) {
						if (conflicts(earlier.key, entry.key)) yield* Deferred.await(earlier.completed);
					}
					const executed = yield* executeTool(entry.tc, tools, signal);
					yield* Deferred.succeed(entry.completed, undefined);
					return { ...entry, result: executed.result };
				}).pipe(
					// Always release dependents: an interrupted call must not deadlock
					// the calls waiting on it.
					Effect.ensuring(Deferred.succeed(entry.completed, undefined)),
				),
			{ concurrency: "unbounded", discard: false },
		);

		return results.sort((a, b) => a.index - b.index).map(({ tc, result }) => ({ tc, result }));
	});
}

/** True when two side-effect calls must not overlap. */
function conflicts(a: string | undefined, b: string | undefined): boolean {
	return a === undefined || b === undefined || a === b;
}

/**
 * Resolves a side-effect call's resource key; `undefined` marks an exclusive
 * call. Calls whose tool is unknown or whose arguments are malformed get a
 * unique key — they fail without touching a resource, so they must not hold up
 * unrelated calls.
 */
function resourceKeyFor(tc: ToolCall, tools: ToolRegistry): string | undefined {
	const tool = tools.get(tc.function.name);
	if (!tool) return `unknown:${tc.id}`;
	if (!tool.resourceKey) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(tc.function.arguments);
	} catch {
		return `invalid:${tc.id}`;
	}
	sanitizeToolArgs(tc.function.name, parsed);
	return tool.resourceKey(parsed);
}

function sanitizeToolArgs(toolName: string, args: unknown): void {
	if (typeof args !== "object" || args === null) return;
	const a = args as Record<string, unknown>;

	if (toolName === "bash" && typeof a.command === "string") {
		if (/^:[a-zA-Z]/.test(a.command)) {
			a.command = a.command.slice(1);
		}
	}

	if (
		(toolName === "write_file" || toolName === "edit_file" || toolName === "read_file") &&
		typeof a.path === "string"
	) {
		if (/^:[a-zA-Z]/.test(a.path)) {
			a.path = a.path.slice(1);
		}
	}
}

type ErrorKind = "unknown_tool" | "invalid_args" | "execution";

function enrichError(toolName: string, rawError: string, kind: ErrorKind): ToolResult {
	const hints: Record<ErrorKind, string> = {
		unknown_tool: `Available tools may have different names. Check the tool list and try again with the correct name.`,
		invalid_args: `The arguments could not be parsed as JSON. Review the tool's parameter schema and provide valid JSON.`,
		execution: getExecutionHint(rawError),
	};

	return {
		content: `Error [${toolName}]: ${rawError}\n\nHint: ${hints[kind]}`,
		isError: true,
	};
}

function getExecutionHint(error: string): string {
	if (error.includes("No such file") || error.includes("ENOENT") || error.includes("not found")) {
		return "The file or path does not exist. Use grep or bash (rg/find/ls) to locate the correct path before retrying.";
	}
	if (error.includes("Permission denied") || error.includes("EACCES")) {
		return "Permission denied. Check file permissions or try a different approach.";
	}
	if (error.includes("command not found")) {
		return "The command was not found. Check spelling or verify the tool is installed.";
	}
	if (error.includes("timed out") || error.includes("timeout")) {
		return "The operation timed out. Try a simpler command or increase the timeout.";
	}
	return "The tool execution failed. Review the error message and try a different approach.";
}

function processToolCallDelta(
	delta: DeltaToolCall,
	accumulator: Map<number, { id: string; name: string; args: string }>,
	emit: (event: AgentEvent) => Effect.Effect<void>,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		let entry = accumulator.get(delta.index);

		if (!entry) {
			entry = { id: delta.id ?? "", name: "", args: "" };
			accumulator.set(delta.index, entry);
		}

		if (delta.id) entry.id = delta.id;
		if (delta.function?.name) {
			entry.name = delta.function.name;
			yield* emit({ type: "tool_call_start", id: entry.id, name: entry.name });
		}
		if (delta.function?.arguments) {
			entry.args += delta.function.arguments;
			yield* emit({ type: "tool_call_args_delta", id: entry.id, args: delta.function.arguments });
		}
	});
}

function buildToolCalls(accumulator: Map<number, { id: string; name: string; args: string }>): ToolCall[] {
	const sorted = [...accumulator.entries()].sort(([a], [b]) => a - b);
	return sorted.map(([, tc]) => ({
		id: tc.id,
		type: "function" as const,
		function: { name: tc.name, arguments: tc.args },
	}));
}
