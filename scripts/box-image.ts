/**
 * Build the prepared box image and load it into the local Microsandbox cache.
 *
 * The image contains Node 26, pnpm, Playwright + Chromium, git, ripgrep, and
 * the rest of the common agent toolchain. Boxes select it automatically when
 * RELAY_BOX_IMAGE is `auto` (the default).
 *
 * Playwright browser archives are downloaded once into the ignored
 * `packages/box/image/browsers` directory and copied into the build. This
 * avoids Playwright's own downloader running inside the image build.
 */

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const imageDir = join(root, "packages", "box", "image");
const containerfile = join(imageDir, "Containerfile");
const browserDir = join(imageDir, "browsers");
const imageTag = process.env.RELAY_BOX_IMAGE_TAG?.trim() || "relay-box:local";
const noCache = process.argv.includes("--no-cache");

const FALLBACK_VERSION = "1.49.1";
const FALLBACK_REVISION = "1148";

interface BrowserArtifact {
	name: string;
	url: string;
}

interface PlaywrightBrowsers {
	version: string;
	revision: string;
	chromium: BrowserArtifact;
	headlessShell: BrowserArtifact;
}

function commandExists(command: string): boolean {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return result.status === 0;
}

function run(command: string, args: string[]): void {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with code ${result.status ?? 1}`);
}

function findMsb(): string {
	const candidates = [
		join(root, "packages", "box", "node_modules", ".bin", "msb"),
		join(root, "node_modules", ".bin", "msb"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	const fallback = spawnSync("msb", ["--version"], { stdio: "ignore" });
	if (fallback.status === 0) return "msb";
	throw new Error("Cannot find the Microsandbox CLI (msb). Run `pnpm install` first.");
}

/** Ask the project's Playwright which browser build it expects. */
function playwrightBrowsers(): PlaywrightBrowsers {
	const fallback: PlaywrightBrowsers = {
		version: FALLBACK_VERSION,
		revision: FALLBACK_REVISION,
		chromium: {
			name: "chromium-linux.zip",
			url: `https://playwright.azureedge.net/builds/chromium/${FALLBACK_REVISION}/chromium-linux.zip`,
		},
		headlessShell: {
			name: "chromium-headless-shell-linux.zip",
			url: `https://playwright.azureedge.net/builds/chromium/${FALLBACK_REVISION}/chromium-headless-shell-linux.zip`,
		},
	};
	const executable = join(root, "node_modules", ".bin", "playwright");
	if (!existsSync(executable)) return fallback;
	const result = spawnSync(executable, ["install", "--dry-run", "chromium"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || !result.stdout) return fallback;
	const lines = result.stdout.split("\n").map((line) => line.trim());
	let version = fallback.version;
	try {
		const packageJson = JSON.parse(
			readFileSync(join(root, "node_modules", "playwright", "package.json"), "utf8"),
		) as {
			version?: unknown;
		};
		if (typeof packageJson.version === "string" && packageJson.version) version = packageJson.version;
	} catch {
		// Keep the fallback package version.
	}
	let chromiumUrl: string | null = null;
	let headlessUrl: string | null = null;
	let target: "chromium" | "headless" | null = null;
	for (const line of lines) {
		if (line.startsWith("browser: chromium version ")) {
			target = "chromium";
			continue;
		}
		if (line.startsWith("browser: chromium-headless-shell version ")) {
			target = "headless";
			continue;
		}
		if (target === "chromium" && line.startsWith("Download url:")) {
			chromiumUrl = line.slice("Download url:".length).trim();
			target = null;
			continue;
		}
		if (target === "headless" && line.startsWith("Download url:")) {
			headlessUrl = line.slice("Download url:".length).trim();
			target = null;
		}
	}
	const chromium = chromiumUrl ?? fallback.chromium.url;
	const headlessShell = headlessUrl ?? fallback.headlessShell.url;
	const revisionMatch = /\/builds\/chromium\/(\d+)\//.exec(chromium);
	return {
		version,
		revision: revisionMatch?.[1] ?? fallback.revision,
		chromium: { name: "chromium-linux.zip", url: chromium },
		headlessShell: { name: "chromium-headless-shell-linux.zip", url: headlessShell },
	};
}

async function download(url: string, destination: string): Promise<void> {
	console.log(`Downloading ${url}`);
	const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
	}
	mkdirSync(dirname(destination), { recursive: true });
	const partial = `${destination}.partial`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	await rename(partial, destination);
}

async function ensureBrowsers(browsers: PlaywrightBrowsers): Promise<void> {
	const marker = join(browserDir, ".version");
	const expected = `${browsers.version}-${browsers.revision}`;
	mkdirSync(browserDir, { recursive: true });
	if (existsSync(marker) && readFileSync(marker, "utf8").trim() === expected) {
		const chromium = join(browserDir, browsers.chromium.name);
		const headless = join(browserDir, browsers.headlessShell.name);
		if (existsSync(chromium) && existsSync(headless)) {
			console.log(`Using cached Playwright browsers (${expected})`);
			return;
		}
	}
	rmSync(join(browserDir, browsers.chromium.name), { force: true });
	rmSync(join(browserDir, browsers.headlessShell.name), { force: true });
	await download(browsers.chromium.url, join(browserDir, browsers.chromium.name));
	await download(browsers.headlessShell.url, join(browserDir, browsers.headlessShell.name));
	writeFileSync(marker, `${expected}\n`);
}

const engine = process.env.CONTAINER_ENGINE?.trim() || (commandExists("podman") ? "podman" : "docker");
if (engine !== "podman" && engine !== "docker") {
	throw new Error("Set CONTAINER_ENGINE to podman or docker.");
}
if (!commandExists(engine)) {
	throw new Error(`Cannot find ${engine}. Install podman or docker, or set CONTAINER_ENGINE.`);
}

const browsers = playwrightBrowsers();
await ensureBrowsers(browsers);

const tar = join(mkdtempSync(join(tmpdir(), "relay-box-image-")), "relay-box.tar");
try {
	const buildArgs = [
		"build",
		"-t",
		imageTag,
		"-f",
		containerfile,
		"--build-arg",
		`PLAYWRIGHT_VERSION=${browsers.version}`,
		"--build-arg",
		`CHROMIUM_REVISION=${browsers.revision}`,
	];
	if (noCache) buildArgs.push("--no-cache");
	buildArgs.push(imageDir);
	run(engine, buildArgs);
	run(engine, ["save", "-o", tar, imageTag]);
	run(findMsb(), ["load", "-i", tar, "-t", imageTag]);
	console.log(`\nLoaded ${imageTag} into the Microsandbox image cache.`);
	console.log("Boxes with RELAY_BOX_IMAGE=auto (the default) will use it.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(dirname(tar), { recursive: true, force: true });
}
