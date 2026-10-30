import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Link, useNavigate, useParams } from "@tanstack/solid-router";
import { useMutation, useQuery } from "@tanstack/solid-query";
import { decodeWorkspaceToken, encodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import type { SessionSummary, WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { RelayError } from "@vvtxn/client/services.ts";
import { configQuery, meQuery, sessionsQuery, workspacesQuery } from "#/api/queries.ts";
import { startChat } from "#/api/open-chat.ts";
import { addWorkspace } from "#/api/workspaces.ts";
import { AppShell } from "#/components/AppShell.tsx";
import { BootError, BootScreen } from "#/components/BootScreen.tsx";
import { displayPath, rememberWorkspace, setHomeDir, workspaceName } from "#/state/workspace.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(timestamp: number | string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function preview(session: SessionSummary): string {
	return session.firstUserMessage || "(empty session)";
}

function missing(workspace: WorkspaceSummary | undefined): boolean {
	return workspace?.exists === false;
}

/**
 * A workspace pane: the threads for one directory, plus the entry point for a
 * new chat scoped to it. The workspace path travels as a token in the URL; the
 * session route remains canonical and flat.
 */
export function WorkspacePage() {
	const params = useParams({ from: "/w/$token" });
	const navigate = useNavigate();
	const cwd = createMemo(() => decodeWorkspaceToken(params().token));

	const me = useQuery(() => meQuery);
	const config = useQuery(() => configQuery);
	const workspaces = useQuery(() => workspacesQuery);
	const sessions = useQuery(() => sessionsQuery(cwd() ?? ""));

	// An unreadable token cannot name a workspace.
	createEffect(() => {
		if (cwd() === null) void navigate({ to: "/", replace: true });
	});
	createEffect(() => {
		const path = cwd();
		if (path) rememberWorkspace(path);
	});
	createEffect(() => {
		const home = config.data?.home;
		if (home) setHomeDir(home);
	});
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	const entry = createMemo(() => (workspaces.data ?? []).find((workspace) => workspace.cwd === cwd()));

	// The pane owns the full thread list; the sidebar only shows the latest few.
	const [query, setQuery] = createSignal("");
	createEffect(
		on(
			() => params().token,
			() => setQuery(""),
			{ defer: true },
		),
	);
	const filtered = createMemo(() => {
		const list = sessions.data ?? [];
		const needle = query().trim().toLowerCase();
		if (!needle) return list;
		return list.filter((session) => (session.firstUserMessage ?? "").toLowerCase().includes(needle));
	});
	const totalThreads = () => sessions.data?.length ?? 0;
	const sessionLimit = () => config.data?.maxSessionsPerWorkspace ?? 0;
	const atLimit = () => sessions.isSuccess && sessionLimit() > 0 && totalThreads() >= sessionLimit();

	const [createError, setCreateError] = createSignal("");
	const create = useMutation(() => ({
		mutationFn: () => startChat(cwd() ?? "", { forceNew: true }),
		onSuccess: (id) => void navigate({ to: "/s/$sessionId", params: { sessionId: id } }),
		onError: (error) => setCreateError(errorMessage(error)),
	}));

	// Unknown workspace: validate + register the path, then move to the
	// canonical token (it may differ when the URL used a symlinked path).
	const [adding, setAdding] = createSignal(false);
	const [addError, setAddError] = createSignal("");
	async function add(): Promise<void> {
		const path = cwd();
		if (!path) return;
		setAdding(true);
		const result = await addWorkspace(path);
		setAdding(false);
		if (!result.ok) {
			setAddError(result.message);
			return;
		}
		setAddError("");
		if (result.path !== path) {
			void navigate({ to: "/w/$token", params: { token: encodeWorkspaceToken(result.path) }, replace: true });
		}
	}

	return (
		<Show
			when={!me.isError && !config.isError}
			fallback={<BootError message={errorMessage(me.error ?? config.error)} />}
		>
			<Show when={me.data && config.data} fallback={<BootScreen />}>
				<AppShell
					userName={me.data!.name}
					avatarUrl={me.data!.avatarUrl}
					activeSessionId={null}
					activeWorkspace={cwd()}
					onOpenSettings={() => void navigate({ to: "/settings" })}
				>
					<div class="pane">
						<header class="pane-head">
							<div class="pane-title-block">
								<span class="pane-title">{cwd() ? workspaceName(cwd()!) : ""}</span>
								<span class="pane-path" title={cwd() ?? ""}>
									{cwd() ? displayPath(cwd()!) : ""}
								</span>
							</div>
							<div class="pane-head-actions">
								<Show when={sessionLimit() > 0}>
									<div
										class={`pane-limit${atLimit() ? " full" : ""}`}
										title={`Relay keeps up to ${sessionLimit()} threads per workspace`}
									>
										<span class="pane-limit-count">
											{sessions.isSuccess ? totalThreads() : "—"} / {sessionLimit()}
										</span>
										<Show when={atLimit()}>
											<span class="pane-limit-hint">oldest removed automatically</span>
										</Show>
									</div>
								</Show>
								<button
									type="button"
									class="btn primary"
									disabled={!entry() || missing(entry()) || create.isPending}
									onClick={() => create.mutate()}
								>
									{create.isPending ? "Creating…" : "New chat"}
								</button>
							</div>
						</header>

						<Show when={missing(entry())}>
							<div class="pane-banner">
								This directory no longer exists on the server. Existing threads can still be read; new
								chats are disabled.
							</div>
						</Show>

						<Show when={entry() && !sessions.isError && totalThreads() > 0}>
							<div class="pane-toolbar">
								<input
									class="input pane-search"
									type="search"
									placeholder="Search threads…"
									aria-label="Search threads"
									value={query()}
									onInput={(event) => setQuery(event.currentTarget.value)}
								/>
								<Show when={query().trim()}>
									<span class="pane-search-count">
										{filtered().length} of {totalThreads()}
									</span>
								</Show>
							</div>
						</Show>

						<div class="pane-body">
							<Show when={createError()}>
								<p class="workspace-error">{createError()}</p>
							</Show>

							<Show when={workspaces.isError}>
								<div class="pane-notice">
									<p class="pane-notice-title">Could not load workspaces</p>
									<p class="settings-hint">
										{errorMessage(workspaces.error)} — retry to check whether this workspace is
										registered.
									</p>
									<button type="button" class="btn" onClick={() => void workspaces.refetch()}>
										Retry
									</button>
								</div>
							</Show>

							<Show when={workspaces.isSuccess && cwd() !== null && !entry()}>
								<div class="pane-notice">
									<p class="pane-notice-title">Workspace not found</p>
									<p class="settings-hint">
										This directory is not registered on the server. Add it to browse its threads.
									</p>
									<Show when={addError()}>
										<p class="workspace-error">{addError()}</p>
									</Show>
									<button type="button" class="btn" disabled={adding()} onClick={() => void add()}>
										{adding() ? "Checking…" : "Add workspace"}
									</button>
								</div>
							</Show>

							<Show when={sessions.isError}>
								<div class="pane-notice">
									<p class="pane-notice-title">Could not load threads</p>
									<p class="settings-hint">{errorMessage(sessions.error)}</p>
									<button type="button" class="btn" onClick={() => void sessions.refetch()}>
										Retry
									</button>
								</div>
							</Show>

							<Show when={entry() && !sessions.isError}>
								<Show when={sessions.data} fallback={<p class="pane-empty">Loading threads…</p>}>
									{(list) => (
										<Show
											when={list().length > 0}
											fallback={<p class="pane-empty">No threads here yet.</p>}
										>
											<Show
												when={filtered().length > 0}
												fallback={
													<p class="pane-empty">No threads match “{query().trim()}”.</p>
												}
											>
												<div class="thread-list">
													<For each={filtered()}>
														{(session) => (
															<Link
																to="/s/$sessionId"
																params={{ sessionId: session.reference }}
																class="thread-item"
															>
																<span class="thread-preview">{preview(session)}</span>
																<span class="thread-time">
																	{formatTimestamp(session.timestamp)}
																</span>
															</Link>
														)}
													</For>
												</div>
											</Show>
										</Show>
									)}
								</Show>
							</Show>
						</div>
					</div>
				</AppShell>
			</Show>
		</Show>
	);
}
