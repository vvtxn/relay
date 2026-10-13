/** Cookie serialization for the auth flow. */

export interface CookieOptions {
	maxAgeSeconds?: number;
	httpOnly?: boolean;
	sameSite?: "Lax" | "Strict" | "None";
	secure?: boolean;
	path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	parts.push(`Path=${options.path ?? "/"}`);
	if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
	if (options.httpOnly !== false) parts.push("HttpOnly");
	parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

export function clearCookie(name: string): string {
	return serializeCookie(name, "", { maxAgeSeconds: 0 });
}

/** True when the configured public URL is https, so cookies should be Secure. */
export function isSecureOrigin(publicUrl: string): boolean {
	return publicUrl.startsWith("https://");
}
