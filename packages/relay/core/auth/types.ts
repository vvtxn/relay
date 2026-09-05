/** A stable identity supplied by an authentication provider. */
export interface AuthIdentity {
	provider: string;
	subject: string;
	email?: string;
}

/** The application identity used by domain and storage code. */
export interface AuthenticatedUser {
	id: string;
	/** Human-readable name: stored name, then identity email, then provider subject. */
	name?: string;
	/** The provider that supplied the identity. */
	provider?: string;
}

/** Client/provider-specific authentication is intentionally outside this contract. */
export interface AuthProvider<Input = void> {
	authenticate(input: Input): Promise<AuthIdentity>;
}

/** Resolves an external identity to an application user. */
export interface UserStore {
	resolve(identity: AuthIdentity): Promise<AuthenticatedUser>;
}
