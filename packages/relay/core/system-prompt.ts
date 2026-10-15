import { buildSystemPrompt } from "./prompts.ts";
import { defaultTools } from "./tools/index.ts";

/**
 * Default system prompt for coding agents using `defaultTools`, shared across
 * clients.
 *
 * Frontends may pass their own prompt via `AgentConfig.systemPrompt`, or build
 * one tuned to their registry with {@link buildSystemPrompt}.
 */
const SYSTEM_PROMPT = buildSystemPrompt({ mode: "main", tools: defaultTools });

export { SYSTEM_PROMPT };
export { buildSystemPrompt } from "./prompts.ts";
export type { BuildSystemPromptOptions, SystemPromptMode } from "./prompts.ts";
