/**
 * Relay version — the single source for every client and the server.
 *
 * Lives in `@vvtxn/relay` (the leaf package) so the CLI, web app, and server
 * can all import it without a dependency cycle. `scripts/bump.ts` writes here.
 */
export const VERSION = "0.8.0";
