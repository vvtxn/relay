import { queryOptions } from "@tanstack/solid-query";
import { Effect } from "effect";
import { runApi } from "./runtime.ts";
import { queryKeys } from "./query-client.ts";

export const meQuery = queryOptions({
	queryKey: queryKeys.me,
	queryFn: () => runApi((api) => api.me()),
	staleTime: Infinity,
});

export const configQuery = queryOptions({
	queryKey: queryKeys.config,
	queryFn: () => runApi((api) => api.getConfig()),
	staleTime: Infinity,
});

export const workspaceQuery = queryOptions({
	queryKey: queryKeys.workspace,
	queryFn: () => runApi((api) => api.workspace()),
	staleTime: Infinity,
});

/** Public auth metadata (available before sign-in). */
export const authInfoQuery = queryOptions({
	queryKey: ["auth", "info"],
	queryFn: () => runApi((api) => api.getAuthInfo()),
	staleTime: Infinity,
});

export function sessionsQuery(cwd: string) {
	return queryOptions({
		queryKey: queryKeys.sessions(cwd),
		queryFn: () => runApi((api) => Effect.map(api.listSessions(cwd), (response) => response.sessions)),
		enabled: cwd.length > 0,
	});
}

/** Known workspaces (project directories) for the workspace picker. */
export const workspacesQuery = queryOptions({
	queryKey: queryKeys.workspaces,
	queryFn: () => runApi((api) => Effect.map(api.listWorkspaces(), (response) => response.workspaces)),
	staleTime: 10_000,
});

export function sessionQuery(id: string) {
	return queryOptions({
		queryKey: queryKeys.session(id),
		queryFn: () => runApi((api) => api.openSession(id)),
		enabled: id.length > 0,
	});
}

export function filesQuery(sessionId: string) {
	return queryOptions({
		queryKey: queryKeys.files(sessionId),
		queryFn: () => runApi((api) => Effect.map(api.listFiles(sessionId), (response) => response.files)),
		enabled: sessionId.length > 0,
		staleTime: 60_000,
	});
}
