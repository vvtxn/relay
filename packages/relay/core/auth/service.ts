import type { AuthenticatedUser, AuthProvider, UserStore } from "./types.ts";

/**
 * Shared authentication boundary used by every frontend.
 *
 * The display name resolves with the following precedence:
 * 1. name stored on the user record (the provider's display name)
 * 2. name from the provider identity
 * 3. email from the provider identity
 * 4. provider subject
 *
 * Empty strings are treated as missing so callers never render a blank name.
 */
export async function authenticate<Input>(
	provider: AuthProvider<Input>,
	input: Input,
	users: UserStore,
): Promise<AuthenticatedUser> {
	const identity = await provider.authenticate(input);
	const user = await users.resolve(identity);
	const avatarUrl = user.avatarUrl || identity.avatarUrl;
	const name = user.name || identity.name || identity.email || identity.subject;
	return {
		...user,
		...(name ? { name } : {}),
		provider: identity.provider,
		...(avatarUrl ? { avatarUrl } : {}),
	};
}
