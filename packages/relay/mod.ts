/**
 * @vvtxn/relay — Core agent library.
 *
 * Provides the agent loop, tool execution, session management, and display
 * utilities. Designed to be consumed by any frontend (TUI, HTTP, WebSocket,
 * mobile) through a callback-based runner interface.
 *
 * @example Recommended usage with {@link runAgentLoop}
 * ```ts
 * import { runAgentLoop, CompletionsProvider, createToolRegistry, defaultTools } from "@vvtxn/relay";
 *
 * const provider = new CompletionsProvider({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
 * const tools = createToolRegistry(defaultTools);
 *
 * await runAgentLoop(messages, {
 *     provider, tools,
 *     model: "moonshotai/kimi-k2.6",
 *     systemPrompt: "You are a coding assistant.",
 *     signal: abortController.signal,
 * }, {
 *     onTextDelta(delta)         { socket.send(JSON.stringify({ type: "text", delta })); },
 *     onToolCallEnd(id, name, a) { socket.send(JSON.stringify({ type: "tool", id, name, args: a })); },
 *     onToolResult(id, result)   { socket.send(JSON.stringify({ type: "result", id, ... })); },
 *     onTurnComplete(msg, trs)   { db.save(msg, trs); },
 *     onError(err)               { socket.send(JSON.stringify({ type: "error", msg: err.message })); },
 * });
 * ```
 *
 * @example Raw async generator (when you need full control)
 * ```ts
 * import { run } from "@vvtxn/relay";
 *
 * for await (const event of run(messages, config)) {
 *     switch (event.type) {
 *         case "text_delta":
 *             // accumulate text
 *             break;
 *         case "tool_call_start":
 *             // track name and id
 *             break;
 *         case "tool_result":
 *             // update output, show diff
 *             break;
 *         case "turn_complete":
 *             // persist to session
 *             break;
 *         case "error":
 *             // handle
 *             break;
 *     }
 * }
 * ```
 *
 * @module
 */

// Agent loop
export { run } from "./core/agent.ts";
export type { AgentConfig, AgentEvent } from "./core/agent.ts";

// Agent runner (convenience wrapper with callbacks)
export { runAgentLoop } from "./core/runner.ts";
export type { RunnerCallbacks } from "./core/runner.ts";

// Display utilities
export {
	abbreviateHome,
	createUIToolCall,
	entriesToUIMessages,
	expandHome,
	getToolDisplayName,
	getToolDisplayOutput,
	parseDiffLines,
	summarizeToolArgs,
	TOOL_DISPLAY_NAMES,
} from "./core/display.ts";
export type { DiffLine, UIMessage, UIToolCall } from "./core/display.ts";

// Theme (shared design tokens for terminal and web clients)
export { theme, themeToCssVariables } from "./core/theme.ts";
export type { Theme } from "./core/theme.ts";

// Context trimming
export { estimateMessageTokens, estimateTokens, trimContext } from "./core/context.ts";
export type { TrimOptions } from "./core/context.ts";

// Tools
export {
	createToolRegistry,
	createWorkspaceTools,
	defaultTools,
	defineTool,
	getDefinitions,
} from "./core/tools/index.ts";
export type { Tool, ToolRegistry, ToolResult } from "./core/tools/index.ts";
export { type ApprovalHandler, type ApprovalOptions, withApproval } from "./core/tools/approval.ts";

// Sessions
export { entriesToMessages, FileSessionStore, SessionManager, stripAttachedContext } from "./core/sessions/index.ts";
export { DatabaseSessionStore } from "./core/sessions/index.ts";
export { sessionDir, sessionsBaseDir } from "./core/sessions/index.ts";
export type {
	Entry,
	MessageEntry,
	NewEntry,
	Session,
	SessionHandle,
	SessionHeader,
	SessionScope,
	SessionStore,
	SessionSummary,
	ToolResultEntry,
} from "./core/sessions/index.ts";

// Authentication
export {
	authenticate,
	DatabaseAuthSessionStore,
	DatabaseUserStore,
	GitHubAuthProvider,
	LocalAuthProvider,
} from "./core/index.ts";
export type {
	AuthenticatedUser,
	AuthIdentity,
	AuthProvider,
	AuthSession,
	AuthSessionStore,
	GitHubProfile,
	UserDirectory,
	UserStore,
} from "./core/index.ts";

// Database (shared Turso client for the session and user stores)
export { createDatabaseClient, databaseCredentialsFromEnv } from "./core/database.ts";
export type { DatabaseClient, DatabaseCredentials } from "./core/database.ts";

// Paths
export { homeDir, relayDir } from "./core/paths.ts";

// Default system prompt
export { SYSTEM_PROMPT } from "./core/system-prompt.ts";

// Workspace helpers (filesystem operations rooted at an explicit directory)
export {
	expandMentions,
	getGitBranch,
	isGitRepo,
	listProjectFiles,
	resolveRealWithinRoot,
	resolveWithinRoot,
} from "./core/workspace.ts";

// API types
export type {
	CompletionRequest,
	CompletionResponse,
	JsonSchema,
	LLMProvider,
	Message,
	ProviderConfig,
	StreamChunk,
	ToolCall,
	ToolDefinition,
	Usage,
} from "./api/types.ts";

// API providers
export { CompletionsProvider } from "./api/providers/completions.ts";
