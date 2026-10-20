/**
 * Build the Linux x64 single executable.
 *
 * The SEA bundle is produced by Vite+ Pack (`exe`). This script prepares the
 * three asset groups it cannot infer:
 *
 * - `web/`   — the built Solid SPA
 * - `fonts/` — the terminal/web font files
 * - `runtime/` — the libSQL JS packages plus the linux-x64 native addon
 *
 * The libSQL tree is kept outside the bundle because native addons cannot be
 * loaded from SEA assets; `packages/local/main.ts` extracts it on first launch.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const relayPackageJson = join(root, "packages", "relay", "package.json");
const vp = join(root, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp");
const runtimeDir = join(root, "packages", "local", ".sea-runtime");
const manifestPath = join(root, "packages", "local", ".sea-assets.json");

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

/** Find a package root by walking the Node module directories. */
function packageDir(name: string, fromPackageJson: string): string {
	let current = dirname(fromPackageJson);
	while (true) {
		const candidates = [
			// Normal dependency resolution.
			join(current, "node_modules", name, "package.json"),
			// pnpm keeps dependencies as siblings inside a package's virtual
			// `node_modules` directory.
			join(current, name, "package.json"),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) return dirname(realpathSync(candidate));
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`Cannot find package directory for ${name}`);
}

/** Copy a package and its runtime dependency tree into the extracted runtime. */
function copyPackage(name: string, seen: Set<string>, fromPackageJson = relayPackageJson): void {
	if (seen.has(name)) return;
	seen.add(name);

	const source = packageDir(name, fromPackageJson);
	const packageJson = join(source, "package.json");
	const target = join(runtimeDir, "node_modules", name);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true, dereference: true });

	const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};

	for (const dependency of Object.keys(pkg.dependencies ?? {})) {
		// Type declarations are not needed at runtime.
		if (dependency.startsWith("@types/")) continue;
		copyPackage(dependency, seen, packageJson);
	}
	for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
		// Only the target platform's libSQL binary is needed. Other optional
		// dependencies are platform-specific or type-only packages.
		if (dependency === "@libsql/linux-x64-gnu") copyPackage(dependency, seen, packageJson);
	}
}

function collectAssets(): Record<string, string> {
	const assets: Record<string, string> = {};

	const addDirectory = (prefix: string, dir: string): void => {
		if (!existsSync(dir)) throw new Error(`Missing asset directory: ${dir}`);
		for (const file of walk(dir)) {
			const relativePath = relative(dir, file).split(sep).join("/");
			assets[`${prefix}/${relativePath}`] = file;
		}
	};

	addDirectory("web", join(root, "packages", "web", "dist"));
	addDirectory("fonts", join(root, "packages", "relay", "assets", "fonts"));
	addDirectory("runtime", runtimeDir);
	return assets;
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
copyPackage("@libsql/client", new Set());

run(vp, ["-C", "packages/web", "build"]);

const assets = collectAssets();
writeFileSync(manifestPath, `${JSON.stringify(assets, null, "\t")}\n`);

try {
	run(vp, ["-C", "packages/local", "pack"]);
} finally {
	rmSync(manifestPath, { force: true });
	rmSync(runtimeDir, { recursive: true, force: true });
}

const binary = join(root, "dist", "relay");
if (!existsSync(binary)) throw new Error(`Expected SEA output at ${binary}`);
chmodSync(binary, 0o755);
console.log(`\nBuilt ${binary}`);
