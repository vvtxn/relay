import { createEffect, createSignal, For, Show } from "solid-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { abbreviateHome } from "@vvtxn/relay/core/display.ts";
import type { SessionSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { sessionsQuery } from "@/api/queries.ts";
import { createSession } from "@/api/mutations.ts";
import { queryKeys } from "@/api/query-client.ts";
import { appendError } from "@/state/session.ts";
import { cwd, homeDir, resolveWorkspaceInput, setCwd } from "@/state/workspace.ts";

function formatTimestamp(timestamp: number | string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function preview(session: SessionSummary): string {
	if (!session.firstUserMessage) return "(empty session)";
	return session.firstUserMessage.length > 48
		? `${session.firstUserMessage.slice(0, 48)}…`
		: session.firstUserMessage;
}

export function Sidebar(props: {
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	activeSessionId: string;
	onSelect: (id: string) => void;
}) {
	const queryClient = useQueryClient();
	// Only abbreviate when the server told us the home dir, otherwise the input
	// could show `~` that we cannot expand back into a real path.
	const displayCwd = () => (homeDir() ? abbreviateHome(cwd(), homeDir()) : cwd());
	const [draftCwd, setDraftCwd] = createSignal(displayCwd());
	const sessions = useQuery(() => sessionsQuery(cwd()));

	createEffect(() => setDraftCwd(displayCwd()));

	const create = useMutation(() => ({
		mutationFn: () => createSession(cwd()),
		onSuccess: async (response) => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.sessions(cwd()) });
			props.onSelect(response.id);
		},
		onError: (error) => appendError(error instanceof Error ? error.message : String(error)),
	}));

	function applyCwd(event: SubmitEvent): void {
		event.preventDefault();
		const resolved = resolveWorkspaceInput(draftCwd());
		if (resolved) {
			setCwd(resolved);
		} else {
			// Unresolvable input (e.g. `~` without a known home) — keep the
			// current workspace and restore the displayed value.
			setDraftCwd(displayCwd());
		}
	}

	return (
		<aside class="sidebar">
			<div class="sidebar-top">
				<div class="brand">Relay</div>
				<button
					type="button"
					class="btn primary block"
					disabled={create.isPending}
					onClick={() => create.mutate()}
				>
					New chat
				</button>
			</div>

			<form class="workspace" onSubmit={applyCwd}>
				<label class="workspace-label" for="cwd">Workspace</label>
				<input
					id="cwd"
					class="input"
					value={draftCwd()}
					placeholder="/path/to/project"
					title="Server-side directory that scopes sessions and confines file tools"
					onInput={(event) => setDraftCwd(event.currentTarget.value)}
				/>
				<p class="workspace-hint">
					Sessions live here; file tools (read, write, edit, grep) are confined to this folder.
				</p>
				<button type="submit" class="btn ghost block">Switch workspace</button>
			</form>

			<div class="session-list">
				<Show
					when={sessions.data?.length}
					fallback={
						<div class="session-empty">
							{sessions.isFetching ? "Loading sessions..." : "No sessions yet"}
						</div>
					}
				>
					<For each={sessions.data}>
						{(session) => (
							<button
								type="button"
								class={session.reference === props.activeSessionId
									? "session-item active"
									: "session-item"}
								onClick={() => props.onSelect(session.reference)}
							>
								<span class="session-preview">{preview(session)}</span>
								<span class="session-time">{formatTimestamp(session.timestamp)}</span>
							</button>
						)}
					</For>
				</Show>
			</div>

			<div class="sidebar-footer">
				<Show when={props.userName}>
					<span class="status-user">
						<Show when={props.avatarUrl}>
							<img class="avatar" src={props.avatarUrl} alt="" />
						</Show>
						<span class="status-meta">{props.userName}</span>
					</span>
				</Show>
			</div>
		</aside>
	);
}
