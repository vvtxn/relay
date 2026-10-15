/**
 * Workspace URL tokens — a canonical workspace path as one URL-safe path
 * segment, shared by the web client (route params) and the CLI (deep links).
 *
 * The encoding is base64url over the UTF-8 bytes because a filesystem path
 * cannot survive a single router path segment verbatim: raw slashes split the
 * segment, and percent-encoded slashes are decoded inconsistently by routers
 * and proxies. Browser-pure — no `node:` imports.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** Encode a canonical workspace path into a single URL path segment. */
export function encodeWorkspaceToken(cwd: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(cwd)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a token back into the workspace path; null when it is not a valid token. */
export function decodeWorkspaceToken(token: string): string | null {
	if (!TOKEN_RE.test(token)) return null;
	try {
		const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const decoded = new TextDecoder().decode(bytes);
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}
