export { run } from "./agent.ts";
export type { AgentConfig, AgentEvent } from "./agent.ts";

export { runAgentLoop } from "./runner.ts";
export type { RunnerCallbacks } from "./runner.ts";

export {
	createUIToolCall,
	entriesToUIMessages,
	getToolDisplayName,
	getToolDisplayOutput,
	parseDiffLines,
	summarizeToolArgs,
	TOOL_DISPLAY_NAMES,
} from "./display.ts";
export type { DiffLine, UIMessage, UIToolCall } from "./display.ts";

export { estimateMessageTokens, estimateTokens, trimContext } from "./context.ts";
export type { TrimOptions } from "./context.ts";

export { createToolRegistry, createWorkspaceTools, defaultTools, defineTool, getDefinitions } from "./tools/index.ts";
export type { Tool, ToolRegistry, ToolResult } from "./tools/index.ts";
export { type ApprovalHandler, type ApprovalOptions, withApproval } from "./tools/approval.ts";

export { entriesToMessages, FileSessionStore, SessionManager, stripAttachedContext } from "./sessions/index.ts";
export { DatabaseSessionStore } from "./sessions/index.ts";
export { sessionDir, sessionsBaseDir } from "./sessions/index.ts";
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
} from "./sessions/index.ts";

export { DatabaseUserStore } from "./auth/db.ts";
export { GitHubAuthProvider } from "./auth/github.ts";
export { LocalAuthProvider } from "./auth/local.ts";
export { authenticate } from "./auth/service.ts";
export type { GitHubProfile } from "./auth/github.ts";
export type { AuthenticatedUser, AuthIdentity, AuthProvider, UserStore } from "./auth/types.ts";

export { homeDir, relayDir } from "./paths.ts";

export { SYSTEM_PROMPT } from "./system-prompt.ts";

export { expandMentions, getGitBranch, isGitRepo, listProjectFiles, resolveWithinRoot } from "./workspace.ts";
