import type { OpenSessionResponse } from "@vvtxn/client/protocol.ts";
import { createSession } from "#/api/mutations.ts";
import { sessionQuery } from "#/api/queries.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";

/**
 * Start (or resume) a chat in `cwd`, seeding the session cache so the session
 * route paints without a fetch. The server reuses an idle empty session, so
 * repeated calls while nothing was sent return the same id.
 */
export async function startChat(cwd: string): Promise<string> {
	const response = await createSession(cwd);
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
