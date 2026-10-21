import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm relay` launcher.
 *
 * Non-TUI subcommands (see `SOURCE_COMMANDS`) run straight from source — Node
 * executes the TS entrypoint natively, so `relay stop`, `relay status`, and
 * friends skip the bundle build entirely. Only the default TUI command needs
 * `vp pack`: its JSX cannot be type-stripped. Env merging and spawning live in
 * `run-env.ts`; this script only picks the entrypoint.
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

if (!fromSource) {
	// Resolve the local bin rather than PATH: the launcher also works when run
	// directly (`node scripts/relay.ts`) or from a linked worktree.
	const vp = join(root, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp");
	const pack = spawnSync(vp, ["-C", join(root, "packages", "cli"), "pack"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (pack.error) {
		console.error(`relay: failed to run the CLI bundle step: ${pack.error.message}`);
		process.exit(1);
	}
	if (pack.status !== 0) process.exit(pack.status ?? 1);
}

const entry = join(root, fromSource ? "packages/cli/agent/index.ts" : "packages/cli/dist/index.mjs");
const result = spawnSync(process.execPath, [join(root, "scripts", "run-env.ts"), entry, ...args], {
	stdio: "inherit",
	cwd: process.cwd(),
});
process.exit(result.status ?? 1);
