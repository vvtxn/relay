import { QueryClient } from "@tanstack/solid-query";

/**
 * Shared query cache. Server state (identity, workspace, sessions, files)
 * lives here; live run state lives in the session stream store instead.
 */
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

/** Query key helpers — one place so reads and invalidations cannot drift. */
export const queryKeys = {
	me: ["me"] as const,
	config: ["config"] as const,
	workspace: ["workspace"] as const,
	sessions: (cwd: string) => ["sessions", cwd] as const,
	session: (id: string) => ["session", id] as const,
	files: (sessionId: string) => ["files", sessionId] as const,
};
