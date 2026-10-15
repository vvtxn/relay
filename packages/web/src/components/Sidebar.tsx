import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Link, useNavigate } from "@tanstack/solid-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { SessionSummary, WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { encodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import { sessionsQuery, workspaceQuery, workspacesQuery } from "#/api/queries.ts";
import { unregisterWorkspace } from "#/api/mutations.ts";
import { startChat } from "#/api/open-chat.ts";
import { addWorkspace } from "#/api/workspaces.ts";
import { queryKeys } from "#/api/query-client.ts";
import { displayPath, lastWorkspace, resolveWorkspaceInput, workspaceName } from "#/state/workspace.ts";

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

/** Latest threads shown per workspace in the sidebar tree; the pane lists them all. */
const SIDEBAR_THREAD_LIMIT = 3;

export function Sidebar(props: {
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	activeSessionId: string | null;
	activeWorkspace: string | null;
	onOpenSettings: () => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const workspaces = useQuery(() => workspacesQuery);
	const defaultWorkspace = useQuery(() => workspaceQuery);
	const [expanded, setExpanded] = createSignal<Set<string>>(
		new Set(props.activeWorkspace ? [props.activeWorkspace] : []),
	);
	const [addOpen, setAddOpen] = createSignal(false);
	const [draftCwd, setDraftCwd] = createSignal("");
	const [addError, setAddError] = createSignal("");
	const [adding, setAdding] = createSignal(false);
	/** Failures for New chat / hide; the chat view is not mounted on every page. */
	const [actionError, setActionError] = createSignal("");

	// The active workspace is expanded when it becomes active (arriving through
	// a URL may predate any manual expansion); it stays collapsible afterwards.
	createEffect(
		on(
			() => props.activeWorkspace,
			(active) => {
				if (active && !expanded().has(active)) setExpanded((prev) => new Set(prev).add(active));
			},
			{ defer: true },
		),
	);

	// Include the active workspace even when the server has no sessions for it.
	const items = createMemo<WorkspaceSummary[]>(() => {
		const list = workspaces.data ?? [];
		const active = props.activeWorkspace;
		if (active && !list.some((workspace) => workspace.cwd === active)) {
			return [{ cwd: active, sessionCount: 0, lastActivity: "" }, ...list];
		}
		return list;
	});

	// Only fetch sessions for workspaces the user has opened.
	const expandedCwds = createMemo(() =>
		items()
			.filter((workspace) => expanded().has(workspace.cwd))
			.map((workspace) => workspace.cwd),
	);
	const sessionQueries = useQueries(() => ({
		queries: expandedCwds().map((path) => sessionsQuery(path)),
	}));
	const sessionsFor = (path: string) => {
		const index = expandedCwds().indexOf(path);
		return index >= 0 ? sessionQueries[index] : undefined;
	};

	/** Where "New chat" goes: the open workspace, else the last visible one, else the first listed. */
	const newChatTarget = createMemo(() => {
		if (props.activeWorkspace) return props.activeWorkspace;
		const last = lastWorkspace();
		const visible = items();
		if (last && visible.some((workspace) => workspace.cwd === last)) return last;
		return visible[0]?.cwd ?? defaultWorkspace.data?.cwd ?? "";
	});

	const create = useMutation(() => ({
		mutationFn: () => startChat(newChatTarget()),
		onSuccess: (id) => {
			setActionError("");
			const target = newChatTarget();
			if (target) setExpanded((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
			void navigate({ to: "/s/$sessionId", params: { sessionId: id } });
		},
		onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
	}));

	const remove = useMutation(() => ({
		mutationFn: (cwd: string) => unregisterWorkspace(cwd),
		onSuccess: (_status, cwd) => {
			setActionError("");
			void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
			if (props.activeWorkspace === cwd) void navigate({ to: "/", replace: true });
		},
		onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
	}));

	function toggleWorkspace(path: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	function openWorkspace(path: string): void {
		setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
		void navigate({ to: "/w/$token", params: { token: encodeWorkspaceToken(path) } });
	}

	function hideWorkspace(workspace: WorkspaceSummary): void {
		const name = workspaceName(workspace.cwd);
		const confirmed = globalThis.confirm(
			`Hide "${name}"? Its threads are kept and stay reachable, and the workspace comes back ` +
				`if you add it again or start a chat in it.`,
		);
		if (confirmed) remove.mutate(workspace.cwd);
	}

	async function applyCwd(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const resolved = resolveWorkspaceInput(draftCwd());
		if (!resolved) {
			setAddError("Enter an absolute path (e.g. /home/me/project or ~/project).");
			return;
		}
		setAddError("");
		setAdding(true);
		const result = await addWorkspace(resolved);
		setAdding(false);
		if (!result.ok) {
			setAddError(result.message);
			return;
		}
		setDraftCwd("");
		setAddOpen(false);
		openWorkspace(result.path);
	}

	return (
		<aside class="sidebar">
			<div class="sidebar-top">
				<div class="brand">Relay</div>
				<button
					type="button"
					class="btn primary block"
					disabled={create.isPending || !newChatTarget()}
					onClick={() => create.mutate()}
				>
					{create.isPending ? "Creating…" : "New chat"}
				</button>
				<Show when={actionError()}>
					<p class="workspace-error">{actionError()}</p>
				</Show>
			</div>

			<div class="workspace-list">
				<div class="workspace-label">Workspaces</div>
				<For each={items()}>
					{(workspace) => {
						const open = () => expanded().has(workspace.cwd);
						const result = createMemo(() => sessionsFor(workspace.cwd));
						return (
							<div class="workspace-node">
								<div
									class={
										workspace.cwd === props.activeWorkspace
											? "workspace-row active"
											: "workspace-row"
									}
								>
									<button
										type="button"
										class="workspace-toggle"
										aria-expanded={open()}
										title={open() ? "Collapse" : "Expand"}
										onClick={() => toggleWorkspace(workspace.cwd)}
									>
										{open() ? "▾" : "▸"}
									</button>
									<button
										type="button"
										class="workspace-name-btn"
										aria-expanded={open()}
										title={workspace.cwd}
										onMouseEnter={() =>
											void queryClient.prefetchQuery(sessionsQuery(workspace.cwd))
										}
										onClick={() => openWorkspace(workspace.cwd)}
									>
										<span class="workspace-name">{workspaceName(workspace.cwd)}</span>
										<span class="workspace-meta">
											{workspace.exists === false ? (
												<span class="workspace-missing">missing</span>
											) : (
												`${workspace.sessionCount}`
											)}
										</span>
									</button>
									<button
										type="button"
										class="workspace-remove"
										title="Hide workspace (threads are kept)"
										disabled={remove.isPending}
										onClick={() => hideWorkspace(workspace)}
									>
										×
									</button>
								</div>
								<Show when={open()}>
									<div class="tree-sessions">
										<Show
											when={result()?.data}
											fallback={
												<div class="session-empty">
													{result()?.isFetching
														? "Loading…"
														: result()?.isError
															? "Failed to load"
															: "No sessions yet"}
												</div>
											}
										>
											{(list) => (
												<Show
													when={list().length}
													fallback={<div class="session-empty">No sessions yet</div>}
												>
													<For each={list().slice(0, SIDEBAR_THREAD_LIMIT)}>
														{(session) => (
															<Link
																to="/s/$sessionId"
																params={{ sessionId: session.reference }}
																class={
																	session.reference === props.activeSessionId
																		? "session-item active"
																		: "session-item"
																}
															>
																<span class="session-preview">{preview(session)}</span>
																<span class="session-time">
																	{formatTimestamp(session.timestamp)}
																</span>
															</Link>
														)}
													</For>
													<Show when={list().length > SIDEBAR_THREAD_LIMIT}>
														<Link
															to="/w/$token"
															params={{ token: encodeWorkspaceToken(workspace.cwd) }}
															class="session-more"
														>
															+{list().length - SIDEBAR_THREAD_LIMIT} more…
														</Link>
													</Show>
												</Show>
											)}
										</Show>
									</div>
								</Show>
							</div>
						);
					}}
				</For>
				<Show when={newChatTarget()}>
					<p class="workspace-hint" title="Workspace new chats start in">
						{displayPath(newChatTarget())}
					</p>
				</Show>
				<Show
					when={addOpen()}
					fallback={
						<button type="button" class="workspace-add" onClick={() => setAddOpen(true)}>
							+ Add workspace
						</button>
					}
				>
					<form class="workspace-add-form" onSubmit={applyCwd}>
						<input
							class="input"
							value={draftCwd()}
							placeholder="/path/to/project"
							title="Server-side directory that scopes sessions and confines file tools"
							onInput={(event) => setDraftCwd(event.currentTarget.value)}
						/>
						<Show when={addError()}>
							<p class="workspace-error">{addError()}</p>
						</Show>
						<div class="workspace-add-actions">
							<button type="button" class="btn ghost" onClick={() => setAddOpen(false)}>
								Cancel
							</button>
							<button type="submit" class="btn" disabled={adding()}>
								{adding() ? "Checking…" : "Add"}
							</button>
						</div>
					</form>
				</Show>
			</div>

			<div class="sidebar-footer">
				<button type="button" class="sidebar-user" title="Open settings" onClick={props.onOpenSettings}>
					<span class="status-user">
						<Show when={props.avatarUrl}>
							<img class="avatar" src={props.avatarUrl} alt="" />
						</Show>
						<span class="status-meta">{props.userName ?? "Account"}</span>
					</span>
					<span class="sidebar-user-action">settings</span>
				</button>
			</div>
		</aside>
	);
}
