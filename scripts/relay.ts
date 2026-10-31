import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm relay` launcher.
 *
 * Subcommands (see `SOURCE_COMMANDS`) run straight from source — Node executes
 * the TS entrypoint natively, while the TUI needs `vp pack` because JSX cannot
 * be type-stripped. Commands that serve the app (`relay`, `relay web`,
 * `relay serve`) also build the web app; lifecycle-only commands skip builds.
 * Env merging and spawning live in `run-env.ts`; this script only picks the
 * entrypoint and fills missing build artifacts.
 *
 * Product mode is selected by the package script (`pnpm relay` sets cloud,
 * `pnpm relay:local` sets local). Arguments are forwarded unchanged, so every
 * subcommand works in both modes.
 *
 * Keep `SOURCE_COMMANDS` in sync with the command switch in
 * `packages/cli/agent/index.ts`, except commands that import the TSX app
 * (`attach`, and the default TUI command) which must run from the bundle.
 */

const SOURCE_COMMANDS = new Set(["serve", "web", "stop", "status", "fonts", "workspace", "threads", "version"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const fromSource = command !== undefined && (SOURCE_COMMANDS.has(command) || VERSION_COMMANDS.has(command));
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

// The normal app path always runs the bundled SPA. Build both artifacts for
// the commands that serve it, and skip builds for lifecycle-only commands.
const needsBundles =
	command === undefined ||
	(command.startsWith("-") && !VERSION_COMMANDS.has(command)) ||
	command === "web" ||
	command === "serve";
if (needsBundles) {
	runVp(["-C", join(root, "packages", "web"), "build"], "web build");
	runVp(["-C", join(root, "packages", "cli"), "pack"], "CLI bundle");
} else if (!fromSource) {
	runVp(["-C", join(root, "packages", "cli"), "pack"], "CLI bundle");
}

const entry = join(root, fromSource ? "packages/cli/agent/index.ts" : "packages/cli/dist/index.mjs");
const result = spawnSync(process.execPath, [join(root, "scripts", "run-env.ts"), entry, ...args], {
	stdio: "inherit",
	cwd: process.cwd(),
});
process.exit(result.status ?? 1);
