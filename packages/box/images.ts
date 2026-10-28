/** The locally built toolchain image. */
export const PREPARED_BOX_IMAGE = "relay-box:local";

/**
 * True for the prepared image, including Podman's `localhost/`-prefixed alias
 * and versioned `relay-box:*` references.
 */
export function isPreparedBoxImage(image: string): boolean {
	const normalized = image.replace(/^localhost\//, "");
	return normalized === PREPARED_BOX_IMAGE || normalized.startsWith("relay-box:");
}
