import { Effect, Stream } from "effect";
import type { Message, Usage } from "#/api/types.ts";
import { type AgentConfig, run } from "./agent.ts";
import type { ToolResult } from "#/core/tools/types.ts";
import { causeMessage } from "./effect.ts";

/**
 * Callbacks for the agent runner — implemented by each client (TUI, HTTP, etc.).
 * Each callback may return a Promise; the runner will await it.
 */
export interface RunnerCallbacks {
	/** Called for each text delta from the LLM stream. */
	onTextDelta(delta: string): void | Promise<void>;
	/** Called when the LLM starts a new tool call (before args stream in). */
	onToolCallStart?(id: string, name: string): void | Promise<void>;
	/** Called for each tool call arguments delta (raw JSON fragment). */
	onToolCallArgsDelta?(id: string, args: string): void | Promise<void>;
	/** Called when a tool call is fully received (args already accumulated). */
	onToolCallEnd(id: string, name: string, args: string): void | Promise<void>;
	/** Called when a tool execution completes. */
	onToolResult(id: string, result: ToolResult): void | Promise<void>;
	/** Called when the LLM finishes generating a single message. */
	onMessageComplete(usage?: Usage, generationId?: string): void | Promise<void>;
	/** Called when a full agent turn completes (assistant message + tool results). */
	onTurnComplete(assistantMessage: Message, toolResults: Message[]): void | Promise<void>;
	/** Called when the agent encounters an error. */
	onError(error: Error): void | Promise<void>;
}

/**
 * Runs the agent loop and invokes callbacks as events are received.
 *
 * Compatibility adapter over the `run()` stream for callback-based consumers:
 * - Awaits each callback so async work (e.g. session writes) completes in order
 * - A throwing callback is reported through `onError` instead of breaking the loop
 *
 * New consumers should prefer `run()` directly; see `packages/server/run.ts`
 * for an Effect-native consumer.
 */
export async function runAgentLoop(
	messages: Message[],
	config: AgentConfig,
	callbacks: RunnerCallbacks,
): Promise<void> {
	const reportError = async (error: unknown) => {
		try {
			await callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// There is no callback available to report an onError failure to.
		}
	};

	const invoke = (callback: () => void | Promise<void>): Effect.Effect<void> =>
		Effect.tryPromise({
			try: async () => {
				await callback();
			},
			catch: (error) => error,
		}).pipe(Effect.catchCause((cause) => Effect.promise(() => reportError(causeMessage(cause)))));

	await Effect.runPromise(
		Stream.runForEachWhile(run(messages, config), (event) =>
			Effect.gen(function* () {
				switch (event.type) {
					case "text_delta":
						yield* invoke(() => callbacks.onTextDelta(event.content));
						break;

					case "tool_call_start":
						yield* invoke(() => callbacks.onToolCallStart?.(event.id, event.name));
						break;

					case "tool_call_args_delta":
						yield* invoke(() => callbacks.onToolCallArgsDelta?.(event.id, event.args));
						break;

					case "tool_call_end":
						yield* invoke(() => callbacks.onToolCallEnd(event.id, event.name, event.args));
						break;

					case "tool_result":
						yield* invoke(() => callbacks.onToolResult(event.id, event.result));
						break;

					case "message_complete":
						yield* invoke(() => callbacks.onMessageComplete(event.usage, event.generationId));
						break;

					case "turn_complete":
						yield* invoke(() => callbacks.onTurnComplete(event.assistantMessage, event.toolResults));
						break;

					case "error":
						yield* invoke(() => callbacks.onError(event.error));
						break;
				}

				return !config.signal?.aborted;
			}),
		),
	);
}
