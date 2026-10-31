export { run } from "./agent.ts";
export type { AgentConfig, AgentEvent } from "./agent.ts";

export { runAgentLoop } from "./runner.ts";
export type { RunnerCallbacks } from "./runner.ts";

export {
	createUIToolCall,
	diffStats,
	entriesToUIMessages,
	getToolDisplayName,
	getToolDisplayOutput,
	groupToolCalls,
	parseDiff,
	parseDiffLines,
	summarizeToolArgs,
	TOOL_DISPLAY_NAMES,
} from "./display.ts";
export type { DiffFile, DiffHunk, DiffLine, ToolCallGroup, UIMessage, UIToolCall } from "./display.ts";

export { estimateMessageTokens, estimateTokens, trimContext } from "./context.ts";
export type { TrimOptions } from "./context.ts";

export {
	createDelegateTool,
	createToolRegistry,
	createWorkspaceTools,
	defaultTools,
	defineTool,
	getDefinitions,
} from "./tools/index.ts";
export type { DelegateToolOptions, Tool, ToolRegistry, ToolResult } from "./tools/index.ts";
export { ToolError } from "./tools/index.ts";

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
	WorkspaceSummary,
} from "./sessions/index.ts";

export { createDatabaseClient, normalizeDatabaseUrl } from "./database.ts";
export type { DatabaseClient, DatabaseCredentials } from "./database.ts";

export { DatabaseUserStore } from "./auth/db.ts";
export { apiKeyHint, DatabaseUserSettingsStore } from "./auth/settings.ts";
export { FileUserSettingsStore } from "./auth/settings-file.ts";
export {
	createSecretCipher,
	isEncryptedSecret,
	loadMasterKey,
	loadOrCreateLocalMasterKey,
	parseMasterKey,
	userSettingsAad,
} from "./auth/secret.ts";
export { GitHubAuthProvider } from "./auth/github.ts";
export { DatabaseAuthSessionStore } from "./auth/sessions.ts";
export { clearStoredSession, readStoredSession, writeStoredSession } from "./auth/session-file.ts";
export { authenticate } from "./auth/service.ts";
export type { SecretCipher } from "./auth/secret.ts";
export type { UserSettingsStatus, UserSettingsStore } from "./auth/settings.ts";
export type { GitHubProfile } from "./auth/github.ts";
export type { AuthSession, AuthSessionStore } from "./auth/sessions.ts";
export type { StoredSession } from "./auth/session-file.ts";
export type { AuthenticatedUser, AuthIdentity, AuthProvider, UserDirectory, UserStore } from "./auth/types.ts";

export { scrubbedAgentEnv } from "./env.ts";

export { homeDir, relayDir } from "./paths.ts";
export { serverLogPath, serverStatePath } from "./server-state.ts";

export { buildSystemPrompt, SYSTEM_PROMPT } from "./system-prompt.ts";
export type { BuildSystemPromptOptions, SystemPromptMode } from "./system-prompt.ts";

export {
	expandMentions,
	getGitBranch,
	isGitRepo,
	listProjectFiles,
	resolveRealWithinRoot,
	resolveWithinRoot,
	validateWorkspacePath,
	validateWorkspacePathSync,
} from "./workspace.ts";
export type { WorkspaceRejection, WorkspaceValidation } from "./workspace.ts";

export { decodeWorkspaceToken, encodeWorkspaceToken } from "./workspace-token.ts";
