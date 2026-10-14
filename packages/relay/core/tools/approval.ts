import { Effect } from "effect";
import type { Tool } from "./types.ts";

/**
 * Decides whether a tool call may execute. Return true to allow, false to
 * deny. Denials surface to the model as a regular tool error, so it can
 * react (ask the user, try a different approach).
 *
 * Handlers that wait on user input should be interruptible (e.g. await a
 * `Deferred`) so cancelling a run doesn't hang on an unanswered prompt.
 */
export type ApprovalHandler = (tool: Tool, input: unknown) => Effect.Effect<boolean>;

export interface ApprovalOptions {
	/** Skip approval for tools marked `readonly`. Defaults to true. */
	skipReadonly?: boolean;
}

/**
 * Wraps each tool so execution is gated on an approval decision. The agent
 * loop needs no changes: approval happens between the `tool_call_end` and
 * `tool_result` events, and a denial is returned as an isError ToolResult.
 */
export function withApproval(tools: Tool[], handler: ApprovalHandler, options: ApprovalOptions = {}): Tool[] {
	const skipReadonly = options.skipReadonly ?? true;
	return tools.map((tool) => {
		if (skipReadonly && tool.readonly) return tool;
		return {
			...tool,
			execute: (input) =>
				Effect.gen(function* () {
					const approved = yield* handler(tool, input);
					if (!approved) {
						return {
							content:
								"The user denied this tool call. Do not retry it unchanged — ask how to proceed, or try a different approach.",
							isError: true,
						};
					}
					return yield* tool.execute(input);
				}),
		};
	});
}
