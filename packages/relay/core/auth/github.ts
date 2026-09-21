import type { AuthIdentity, AuthProvider } from "./types.ts";

/** The verified identity fields returned by GitHub. OAuth transport is client-specific. */
export interface GitHubProfile {
	id?: number | string | null;
	email?: string | null;
	login?: string | null;
	name?: string | null;
	avatar_url?: string | null;
}

/** Converts a verified GitHub profile into the application identity format. */
export class GitHubAuthProvider implements AuthProvider<GitHubProfile> {
	authenticate(profile: GitHubProfile): Promise<AuthIdentity> {
		if (profile.id === undefined || profile.id === null) {
			throw new Error("A GitHub profile ID is required");
		}
		const subject = String(profile.id);
		const name = profile.name?.trim() || profile.login?.trim();
		return Promise.resolve({
			provider: "github",
			subject,
			...(profile.email ? { email: profile.email } : {}),
			...(name ? { name } : {}),
			...(profile.avatar_url ? { avatarUrl: profile.avatar_url } : {}),
		});
	}
}
