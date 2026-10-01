/** A stable identity supplied by an authentication provider. */
export interface AuthIdentity {
	provider: string;
	subject: string;
	email?: string;
	/** Display name from the provider (e.g. GitHub name or login). */
	name?: string;
	/** Avatar URL from the provider, when available. */
	avatarUrl?: string;
}

/** The application identity used by domain and storage code. */
export interface AuthenticatedUser {
	id: string;
	/** Human-readable name: stored name, then identity email, then provider subject. */
	name?: string;
	/** The provider that supplied the identity. */
	provider?: string;
	/** Avatar URL from the provider, when available. */
	avatarUrl?: string;
}

/** Client/provider-specific authentication is intentionally outside this contract. */
export interface AuthProvider<Input = void> {
	authenticate(input: Input): Promise<AuthIdentity>;
}

/** Resolves an external identity to an application user. */
export interface UserStore {
	resolve(identity: AuthIdentity): Promise<AuthenticatedUser>;
}

/** Looks up an application user by internal id (used to restore sessions). */
export interface UserDirectory {
	getById(id: string): Promise<AuthenticatedUser | null>;
}
