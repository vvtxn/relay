import { readFileSync } from "node:fs";

/**
 * Default system prompt for coding agents, shared across clients (TUI, web).
 *
 * Frontends may pass their own prompt via `AgentConfig.systemPrompt`; this is
 * just the shared default, read from the bundled markdown file at startup.
 */
const SYSTEM_PROMPT = readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8");

export { SYSTEM_PROMPT };
