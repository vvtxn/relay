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

/**
 * Serves the built web app. Falls back to index.html for unknown paths so
 * client-side routing works (SPA fallback). Paths that escape the static
 * directory are rejected.
 */
export async function serveStatic(staticDir: string, pathname: string): Promise<Response> {
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
		// SPA fallback — serve index.html for unknown non-file paths
		return await serveIndex(staticDir);
	}

	if (file.isDirectory) return await serveIndex(staticDir);

	const content = await Deno.readFile(normalizedPath);
	const mime = MIME_TYPES[extname(normalizedPath)] ?? "application/octet-stream";
	return new Response(content, { headers: { "Content-Type": mime } });
}

async function serveIndex(staticDir: string): Promise<Response> {
	try {
		const content = await Deno.readFile(join(staticDir, "index.html"));
		return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
	} catch {
		return error(404, "Not found");
	}
}
