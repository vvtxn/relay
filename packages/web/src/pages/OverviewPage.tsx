import { createEffect, createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { encodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import type { BootResult } from "#/api/bootstrap.ts";
import { bootstrap } from "#/api/bootstrap.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";
import { settingsQuery, workspacesQuery } from "#/api/queries.ts";
import { runtime } from "#/api/runtime.ts";
import { readStoredSessionId } from "#/api/storage.ts";
import { beginLogin } from "#/auth/auth.ts";
import { AppShell } from "#/components/AppShell.tsx";
import { BootError, BootScreen, LoginScreen } from "#/components/BootScreen.tsx";
import { displayPath, setHomeDir, workspaceName } from "#/state/workspace.ts";

type ReadyBoot = Extract<BootResult, { kind: "ready" }>;

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The root view: every workspace the user has, plus a way back into the last
 * chat. Boot/auth lives here; unlike the old boot page it never creates or
 * opens a session by itself.
 */
export function OverviewPage() {
	const [result] = createResource(() => runtime.runPromise(bootstrap));

	createEffect(() => {
		const boot = result();
		if (!boot || boot.kind !== "ready") return;
		// Seed the layout caches so the first render of the shell needs no fetches.
		queryClient.setQueryData(queryKeys.me, boot.me);
		queryClient.setQueryData(queryKeys.config, boot.config);
		queryClient.setQueryData(queryKeys.workspace, { cwd: boot.defaultCwd });
		if (boot.workspaces) queryClient.setQueryData(queryKeys.workspaces, boot.workspaces);
		// Warm the settings page so opening it is instant.
		void queryClient.prefetchQuery(settingsQuery);
	});

	const ready = createMemo<ReadyBoot | undefined>(() => {
		const boot = result();
		return boot && boot.kind === "ready" ? boot : undefined;
	});

	return (
		<Switch>
			<Match when={result.loading}>
				<BootScreen />
			</Match>
			<Match when={result.error}>{(error) => <BootError message={toMessage(error())} />}</Match>
			<Match when={result()?.kind === "unauthenticated"}>
				<LoginScreen onLogin={beginLogin} />
			</Match>
			<Match when={ready()}>{(boot) => <OverviewContent boot={boot()} />}</Match>
		</Switch>
	);
}

function OverviewContent(props: { boot: ReadyBoot }) {
	const navigate = useNavigate();
	const workspaces = useQuery(() => workspacesQuery);
	const list = createMemo(() => workspaces.data ?? props.boot.workspaces ?? []);
	const lastSessionId = readStoredSessionId();

	createEffect(() => setHomeDir(props.boot.config.home));

	const openWorkspace = (cwd: string) =>
		void navigate({ to: "/w/$token", params: { token: encodeWorkspaceToken(cwd) } });

	return (
		<AppShell
			userName={props.boot.me.name}
			avatarUrl={props.boot.me.avatarUrl}
			activeSessionId={null}
			activeWorkspace={null}
			onOpenSettings={() => void navigate({ to: "/settings" })}
		>
			<div class="overview">
				<header class="overview-head">
					<h1 class="overview-title">Workspaces</h1>
					<p class="overview-sub">
						Open a project to browse its threads, or start a new chat from the sidebar.
					</p>
				</header>

				<Show when={lastSessionId}>
					{(id) => (
						<button
							type="button"
							class="overview-continue"
							onClick={() => void navigate({ to: "/s/$sessionId", params: { sessionId: id() } })}
						>
							<span class="overview-continue-title">Continue</span>
							<span class="overview-continue-hint">jump back into your last chat</span>
						</button>
					)}
				</Show>

				<Show
					when={list().length > 0}
					fallback={
						<p class="pane-empty">
							No workspaces yet. Run <code>relay</code> in a project folder, or add one from the sidebar.
						</p>
					}
				>
					<div class="overview-grid">
						<For each={list()}>
							{(workspace) => (
								<button
									type="button"
									class="overview-card"
									onClick={() => openWorkspace(workspace.cwd)}
								>
									<span class="overview-card-name">{workspaceName(workspace.cwd)}</span>
									<span class="overview-card-path" title={workspace.cwd}>
										{displayPath(workspace.cwd)}
									</span>
									<span class="overview-card-meta">
										{workspace.exists === false
											? "missing"
											: `${workspace.sessionCount} thread${workspace.sessionCount === 1 ? "" : "s"}`}
									</span>
								</button>
							)}
						</For>
					</div>
				</Show>
			</div>
		</AppShell>
	);
}
