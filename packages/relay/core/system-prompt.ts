import { buildSystemPrompt } from "./prompts.ts";

/**
 * Default system prompt for coding agents, shared across clients.
 *
 * Frontends may pass their own prompt via `AgentConfig.systemPrompt`, or build
 * one tuned to their runtime with {@link buildSystemPrompt}.
 */
const SYSTEM_PROMPT = buildSystemPrompt({ mode: "main" });

export { SYSTEM_PROMPT };
export { buildSystemPrompt } from "./prompts.ts";
export type { BuildSystemPromptOptions, SystemPromptMode } from "./prompts.ts";
