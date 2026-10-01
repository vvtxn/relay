/**
 * Authentication helpers.
 *
 * The server owns the GitHub App OAuth flow and the session cookie; the client
 * only sends users to the login URL and handles 401 responses (see `bootstrap`).
 * Keeping that behind these helpers means the UI never hardcodes the auth mode.
 */

function env(): Record<string, string | undefined> {
	return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

function redirect(url: string): void {
	globalThis.location.assign(url);
}

/** Server endpoint that begins the login flow (OAuth redirect when enabled). */
export function loginUrl(): string {
	return env().VITE_RELAY_LOGIN_URL ?? "/api/auth/login";
}

export function beginLogin(): void {
	redirect(loginUrl());
}

export async function signOut(): Promise<void> {
	const logoutUrl = env().VITE_RELAY_LOGOUT_URL ?? "/api/auth/logout";
	await fetch(logoutUrl, { method: "POST", credentials: "include" }).catch(() => {});
	redirect("/");
}
