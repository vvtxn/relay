/** Request-header helpers shared by the provider adapters. */

import { VERSION } from "../version.ts";

/**
 * Relay's user agent. Gateways such as OpenCode Go ask clients to identify
 * themselves instead of sending a generic HTTP-library name.
 */
export const USER_AGENT = `relay/${VERSION}`;

/** Session ids gateways expect (`ses_...`); accept one that is already shaped. */
export function conversationId(sessionId: string): string {
	return sessionId.startsWith("ses_") ? sessionId : `ses_${sessionId}`;
}

/**
 * Builds the final header set for one request: adapter auth first, then
 * preset-provided headers, then the user agent and optional session header.
 * Extra headers may intentionally override the adapter's defaults.
 */
export function requestHeaders(
	defaults: Record<string, string | undefined>,
	options: {
		headers?: Record<string, string> | undefined;
		sessionHeader?: string | undefined;
		sessionId?: string | undefined;
	},
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(defaults)) {
		if (value !== undefined) result[name] = value;
	}
	Object.assign(result, options.headers ?? {});
	result["User-Agent"] = USER_AGENT;
	if (options.sessionHeader && options.sessionId) {
		result[options.sessionHeader] = conversationId(options.sessionId);
	}
	return result;
}
