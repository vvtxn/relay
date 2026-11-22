import type { LlmModelSelection, UpdateSettingsRequest } from "@vvtxn/client/protocol.ts";
import { runApi } from "./runtime.ts";

export const createSession = (cwd: string, options?: { forceNew?: boolean }) =>
	runApi((api) => api.createSession(cwd, options));

export const validateWorkspace = (cwd: string) => runApi((api) => api.validateWorkspace(cwd));

export const registerWorkspace = (cwd: string) => runApi((api) => api.registerWorkspace(cwd));

/** Hide a workspace registration (its sessions are kept). */
export const unregisterWorkspace = (cwd: string) => runApi((api) => api.unregisterWorkspace(cwd));

/** Save the caller's LLM selection and/or API key. Omitted fields are kept. */
export const updateSettings = (settings: UpdateSettingsRequest) => runApi((api) => api.updateSettings(settings));

/** Begin a subscription sign-in; returns the provider URL. */
export const startOAuth = (provider: string) => runApi((api) => api.startOAuth(provider));

/** Complete the paste flow with the provider-displayed code. */
export const completeOAuth = (provider: string, code: string) => runApi((api) => api.completeOAuth(provider, code));

/** Remove a stored subscription credential. */
export const disconnectOAuth = (provider: string) => runApi((api) => api.disconnectOAuth(provider));

/** Store an API key for one preset without changing the default selection. */
export const setConnection = (preset: string, apiKey: string) => runApi((api) => api.setConnection(preset, apiKey));

/** Remove a preset's stored credential. */
export const removeConnection = (preset: string) => runApi((api) => api.removeConnection(preset));

export const sendMessage = (sessionId: string, content: string, model?: LlmModelSelection) =>
	runApi((api) => api.sendMessage(sessionId, content, model));

export const cancelRun = (sessionId: string) => runApi((api) => api.cancel(sessionId));
