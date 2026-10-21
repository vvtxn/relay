import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm relay` launcher.
 *
 * Non-TUI subcommands (see `SOURCE_COMMANDS`) run straight from source — Node
 * executes the TS entrypoint natively, so `relay stop`, `relay status`, and
 * friends skip the bundle build entirely. The default TUI needs `vp pack` (JSX
 * cannot be type-stripped), and production cloud mode needs the built web app.
 * Env merging and spawning live in `run-env.ts`; this script only picks the
 * entrypoint and fills missing build artifacts.
 *
 * Product mode is selected by the package script (`pnpm relay` sets
 * RELAY_FLAVOR=local, `pnpm relay:cloud` sets cloud). Arguments are forwarded
 * unchanged, so every subcommand works in both modes.
 *
 * Keep `SOURCE_COMMANDS` in sync with the command switch in
 * `packages/cli/agent/index.ts`.
 */

const SOURCE_COMMANDS = new Set(["serve", "web", "stop", "status", "fonts", "workspace", "version"]);

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const fromSource = command !== undefined && SOURCE_COMMANDS.has(command);
// Resolve the local bin rather than PATH: the launcher also works when run
// directly (`node scripts/relay.ts`) or from a linked worktree.
const vp = join(root, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp");

function runVp(packArgs: string[], label: string): void {
	const result = spawnSync(vp, packArgs, { stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) {
		console.error(`relay: failed to run the ${label} step: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// Production cloud mode serves the SPA itself; build it on first use if needed.
const needsWeb =
	process.env.RELAY_ENV === "production" && (command === undefined || command === "web" || command === "serve");
if (needsWeb && !existsSync(join(root, "packages", "web", "dist", "index.html"))) {
	runVp(["-C", join(root, "packages", "web"), "build"], "web build");
}

if (!fromSource) {
	runVp(["-C", join(root, "packages", "cli"), "pack"], "CLI bundle");
}

const entry = join(root, fromSource ? "packages/cli/agent/index.ts" : "packages/cli/dist/index.mjs");
const result = spawnSync(process.execPath, [join(root, "scripts", "run-env.ts"), entry, ...args], {
	stdio: "inherit",
	cwd: process.cwd(),
});
process.exit(result.status ?? 1);
