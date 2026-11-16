import type { UpdateSettingsRequest } from "@vvtxn/client/protocol.ts";
import { runApi } from "./runtime.ts";

export const createSession = (cwd: string, options?: { forceNew?: boolean }) =>
	runApi((api) => api.createSession(cwd, options));

export const validateWorkspace = (cwd: string) => runApi((api) => api.validateWorkspace(cwd));

export const registerWorkspace = (cwd: string) => runApi((api) => api.registerWorkspace(cwd));

/** Hide a workspace registration (its sessions are kept). */
export const unregisterWorkspace = (cwd: string) => runApi((api) => api.unregisterWorkspace(cwd));

/** Save the caller's LLM selection and/or API key. Omitted fields are kept. */
export const updateSettings = (settings: UpdateSettingsRequest) => runApi((api) => api.updateSettings(settings));

export const sendMessage = (sessionId: string, content: string) => runApi((api) => api.sendMessage(sessionId, content));

export const cancelRun = (sessionId: string) => runApi((api) => api.cancel(sessionId));
