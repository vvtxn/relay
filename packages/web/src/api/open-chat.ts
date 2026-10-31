import type { OpenSessionResponse } from "@vvtxn/client/protocol.ts";
import { createSession } from "#/api/mutations.ts";
import { sessionQuery } from "#/api/queries.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";

/**
 * Start (or resume) a chat in `cwd`, seeding the session cache so the session
 * route paints without a fetch. The server reuses an idle empty session unless
 * `forceNew` asks for a separate blank thread (the explicit "New chat" action).
 */
export async function startChat(cwd: string, options: { forceNew?: boolean } = {}): Promise<string> {
	const response = await createSession(cwd, options);
	queryClient.setQueryData<OpenSessionResponse>(queryKeys.session(response.id), {
		header: response.header,
		entries: [],
		tokens: 0,
		cost: 0,
		branch: null,
		running: false,
	});
	// Refresh that snapshot behind the scenes (e.g. to learn the branch).
	void queryClient.prefetchQuery({ ...sessionQuery(response.id), staleTime: 0 });
	void queryClient.invalidateQueries({ queryKey: ["sessions"] });
	void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
	return response.id;
}
