import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query";
import { abbreviateHome } from "@vvtxn/relay/core/display.ts";
import type { SessionSummary, WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { sessionsQuery, workspacesQuery } from "@/api/queries.ts";
import { createSession, registerWorkspace, validateWorkspace } from "@/api/mutations.ts";
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

/** Last path segment, e.g. `/home/me/project` → `project`. */
function workspaceName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

function workspacePath(workspace: WorkspaceSummary): string {
	return homeDir() ? abbreviateHome(workspace.cwd, homeDir()) : workspace.cwd;
}

export function Sidebar(props: {
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	activeSessionId: string;
	onSelect: (id: string) => void;
	onOpenSettings: () => void;
}) {
	const queryClient = useQueryClient();
	const workspaces = useQuery(() => workspacesQuery);
	const [expanded, setExpanded] = createSignal<Set<string>>(new Set(cwd() ? [cwd()] : []));
	const [addOpen, setAddOpen] = createSignal(false);
	const [draftCwd, setDraftCwd] = createSignal("");
	const [addError, setAddError] = createSignal("");
	const [adding, setAdding] = createSignal(false);

	// Include the active workspace even when the server has no sessions for it.
	const items = createMemo<WorkspaceSummary[]>(() => {
		const list = workspaces.data ?? [];
		if (cwd() && !list.some((workspace) => workspace.cwd === cwd())) {
			return [{ cwd: cwd(), sessionCount: 0, lastActivity: "" }, ...list];
		}
		return list;
	});

	// The active workspace is always expanded; others toggle on demand.
	createEffect(() => {
		const active = cwd();
		if (active) setExpanded((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
	});

	// Only fetch sessions for workspaces the user has opened.
	const expandedCwds = createMemo(() =>
		items().filter((workspace) => expanded().has(workspace.cwd)).map((workspace) => workspace.cwd)
	);
	const sessionQueries = useQueries(() => ({
		queries: expandedCwds().map((path) => sessionsQuery(path)),
	}));
	const sessionsFor = (path: string) => {
		const index = expandedCwds().indexOf(path);
		return index >= 0 ? sessionQueries[index] : undefined;
	};

	const create = useMutation(() => ({
		mutationFn: () => createSession(cwd()),
		onSuccess: async (response) => {
			await queryClient.invalidateQueries({ queryKey: ["sessions"] });
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
			props.onSelect(response.id);
		},
		onError: (error) => appendError(error instanceof Error ? error.message : String(error)),
	}));

	function toggleWorkspace(path: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	function selectWorkspace(next: string): void {
		setExpanded((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
		if (next !== cwd()) setCwd(next);
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
		try {
			const validation = await validateWorkspace(resolved);
			if (!validation.ok || !validation.path) {
				setAddError(validation.message ?? "That workspace cannot be used.");
				return;
			}
			await registerWorkspace(validation.path);
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
			setCwd(validation.path);
			setDraftCwd("");
			setAddOpen(false);
		} catch (error) {
			setAddError(error instanceof Error ? error.message : String(error));
		} finally {
			setAdding(false);
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

			<div class="workspace-list">
				<div class="workspace-label">Workspaces</div>
				<For each={items()}>
					{(workspace) => (
						<div class="workspace-node">
							<div class={workspace.cwd === cwd() ? "workspace-row active" : "workspace-row"}>
								<button
									type="button"
									class="workspace-toggle"
									title={expanded().has(workspace.cwd) ? "Collapse" : "Expand"}
									onClick={() => toggleWorkspace(workspace.cwd)}
								>
									{expanded().has(workspace.cwd) ? "▾" : "▸"}
								</button>
								<button
									type="button"
									class="workspace-name-btn"
									title={workspace.cwd}
									onClick={() => selectWorkspace(workspace.cwd)}
								>
									<span class="workspace-name">{workspaceName(workspace.cwd)}</span>
									<span class="workspace-meta">
										{workspace.exists === false ? <span class="workspace-missing">missing</span> : (
											`${workspace.sessionCount}`
										)}
									</span>
								</button>
							</div>
							<Show when={expanded().has(workspace.cwd)}>
								<div class="tree-sessions">
									<Show
										when={sessionsFor(workspace.cwd)?.data}
										fallback={
											<div class="session-empty">
												{sessionsFor(workspace.cwd)?.isFetching
													? "Loading…"
													: "No sessions yet"}
											</div>
										}
									>
										{(list) => (
											<Show
												when={list().length}
												fallback={<div class="session-empty">No sessions yet</div>}
											>
												<For each={list()}>
													{(session) => (
														<button
															type="button"
															class={session.reference === props.activeSessionId
																? "session-item active"
																: "session-item"}
															onClick={() => props.onSelect(session.reference)}
														>
															<span class="session-preview">{preview(session)}</span>
															<span class="session-time">
																{formatTimestamp(session.timestamp)}
															</span>
														</button>
													)}
												</For>
											</Show>
										)}
									</Show>
								</div>
							</Show>
						</div>
					)}
				</For>
				<Show when={cwd()}>
					<p class="workspace-hint">{workspacePath({ cwd: cwd(), sessionCount: 0, lastActivity: "" })}</p>
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
							<button type="button" class="btn ghost" onClick={() => setAddOpen(false)}>Cancel</button>
							<button type="submit" class="btn" disabled={adding()}>
								{adding() ? "Checking…" : "Add"}
							</button>
						</div>
					</form>
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
				<button type="button" class="status-action" onClick={props.onOpenSettings}>settings</button>
			</div>
		</aside>
	);
}
