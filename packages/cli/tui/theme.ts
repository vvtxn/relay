/**
 * Graphite / Silver theme for the Relay CLI.
 *
 * The tokens live in `@vvtxn/relay/core/theme.ts` so the terminal and web
 * clients share one source of truth. Re-exported here for existing `@/tui/theme.ts`
 * imports.
 */

export { theme, themeToCssVariables } from "@vvtxn/relay/core/theme.ts";
export type { Theme } from "@vvtxn/relay/core/theme.ts";
