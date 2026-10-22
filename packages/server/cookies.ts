/** Cookie helpers shared by the OAuth routes. */

/** True when the configured public URL is https, so cookies should be Secure. */
export function isSecureOrigin(publicUrl: string): boolean {
	return publicUrl.startsWith("https://");
}
