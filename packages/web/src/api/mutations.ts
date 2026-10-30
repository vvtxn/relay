import { runApi } from "./runtime.ts";

export const createSession = (cwd: string, options?: { forceNew?: boolean }) =>
	runApi((api) => api.createSession(cwd, options));

export const validateWorkspace = (cwd: string) => runApi((api) => api.validateWorkspace(cwd));

export const registerWorkspace = (cwd: string) => runApi((api) => api.registerWorkspace(cwd));

/** Hide a workspace registration (its sessions are kept). */
export const unregisterWorkspace = (cwd: string) => runApi((api) => api.unregisterWorkspace(cwd));

/** Set the caller's LLM API key, or clear it with null. */
export const setApiKey = (apiKey: string | null) => runApi((api) => api.setApiKey(apiKey));

export const sendMessage = (sessionId: string, content: string) => runApi((api) => api.sendMessage(sessionId, content));

export const cancelRun = (sessionId: string) => runApi((api) => api.cancel(sessionId));
