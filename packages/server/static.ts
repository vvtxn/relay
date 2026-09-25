import { extname, join, normalize } from "@std/path";
import { error } from "./http.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json",
};

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

/**
 * Where the built SPA lives relative to this module. In a source checkout this
 * is the real `packages/web/dist`; in a compiled binary the build script
 * `--include`s it, so `Deno.readFile` resolves it from the embedded filesystem.
 */
const WEB_DIST_URL = new URL("../web/dist/", import.meta.url);

function mimeFor(path: string): string {
	return MIME_TYPES[extname(path)] ?? "application/octet-stream";
}

/**
 * Serves the built web app. Uses `staticDir` when configured (a deployment
 * override), otherwise the bundled `packages/web/dist`. Falls back to
 * index.html for unknown paths so client-side routing works (SPA fallback).
 */
export async function serveStatic(staticDir: string | null, pathname: string): Promise<Response> {
	if (staticDir) return await serveFromDisk(staticDir, pathname);
	return await serveFromUrl(WEB_DIST_URL, pathname);
}

async function serveFromDisk(staticDir: string, pathname: string): Promise<Response> {
	const rel = normalize(pathname).replace(/^([/\\])+/, "");
	const filePath = join(staticDir, rel);

	// Confinement check
	const normalizedRoot = normalize(staticDir);
	const normalizedPath = normalize(filePath);
	if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(normalizedRoot + "/")) {
		return error(403, "Forbidden");
	}

	let file: Deno.FileInfo;
	try {
		file = await Deno.stat(normalizedPath);
	} catch {
		return await serveDiskIndex(staticDir);
	}
	if (file.isDirectory) return await serveDiskIndex(staticDir);

	const content = await Deno.readFile(normalizedPath);
	return new Response(content, { headers: { "Content-Type": mimeFor(normalizedPath) } });
}

async function serveFromUrl(root: URL, pathname: string): Promise<Response> {
	const rel = pathname.replace(/^\/+/, "");
	const url = new URL(rel, root);
	// Confinement: `..` normalizes out of the root, so reject anything outside.
	if (url.pathname !== root.pathname && !url.pathname.startsWith(root.pathname)) {
		return error(403, "Forbidden");
	}

	try {
		const content = await Deno.readFile(url);
		return new Response(content, { headers: { "Content-Type": mimeFor(url.pathname) } });
	} catch {
		return await serveUrlIndex(root);
	}
}

async function serveDiskIndex(staticDir: string): Promise<Response> {
	try {
		const content = await Deno.readFile(join(staticDir, "index.html"));
		return new Response(content, { headers: HTML_HEADERS });
	} catch {
		return error(404, "Not found");
	}
}

async function serveUrlIndex(root: URL): Promise<Response> {
	try {
		const content = await Deno.readFile(new URL("index.html", root));
		return new Response(content, { headers: HTML_HEADERS });
	} catch {
		return error(404, "Not found");
	}
}
