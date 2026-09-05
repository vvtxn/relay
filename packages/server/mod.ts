/**
 * @vvtxn/server — HTTP + SSE server hosting the Relay agent runtime.
 *
 * Exposes the agent loop, sessions, tools, and approvals over the REST + SSE
 * protocol defined in `@vvtxn/client`. Entry point: `startServer()` (also
 * used by the CLI's `relay serve` subcommand).
 *
 * @module
 */

export { startServer } from "./main.ts";
export { createServices } from "./services.ts";
export type { ServerServices } from "./services.ts";
export { handleRequest } from "./router.ts";
export { serverConfigFromEnv } from "./config.ts";
export type { ServerConfig } from "./config.ts";
export { RunConflictError, RunManager } from "./run.ts";
