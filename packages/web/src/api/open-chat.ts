import type { LlmModelSelection, OpenSessionResponse } from "@vvtxn/client/protocol.ts";
import type { MessageEntry } from "@vvtxn/relay/core/sessions/index.ts";
import { createSession, sendMessage } from "#/api/mutations.ts";
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

/**
 * Start a thread in `cwd` and submit its first message in one step, for the
 * overview's hero composer. The cache is seeded with the optimistic user entry
 * after the server accepts the message, so the chat route paints the prompt
 * immediately instead of waiting for the run's first streamed event. The run's
 * `run_finished` invalidation replaces it with the persisted transcript.
 */
export async function startChatWithMessage(
	cwd: string,
	content: string,
	model?: LlmModelSelection | null,
): Promise<string> {
	const response = await createSession(cwd);
	const id = response.id;
	await sendMessage(id, content, model);
	const entry: MessageEntry = {
		type: "message",
		role: "user",
		content,
		id: `optimistic-${globalThis.crypto.randomUUID()}`,
		timestamp: new Date().toISOString(),
	};
	queryClient.setQueryData<OpenSessionResponse>(queryKeys.session(id), {
		header: response.header,
		entries: [entry],
		tokens: 0,
		cost: 0,
		branch: null,
		running: true,
		runPhase: "preparing-workspace",
	});
	void queryClient.invalidateQueries({ queryKey: ["sessions"] });
	void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
	return id;
}
