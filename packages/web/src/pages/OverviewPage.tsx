import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { useNavigate } from "@tanstack/solid-router";
import { useQueries, useQuery } from "@tanstack/solid-query";
import type { LlmModelSelection } from "@vvtxn/client/protocol.ts";
import type { SessionSummary, WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { encodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import type { BootResult } from "#/api/bootstrap.ts";
import { bootstrap } from "#/api/bootstrap.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";
import { startChat, startChatWithMessage } from "#/api/open-chat.ts";
import { sessionsQuery, settingsQuery, workspacesQuery } from "#/api/queries.ts";
import { runtime } from "#/api/runtime.ts";
import { readStoredSessionId } from "#/api/storage.ts";
import { addWorkspace } from "#/api/workspaces.ts";
import { beginLogin } from "#/auth/auth.ts";
import { AppShell } from "#/components/AppShell.tsx";
import { BootError, BootScreen, LoginScreen } from "#/components/BootScreen.tsx";
import { ModelSelector } from "#/components/ModelSelector.tsx";
import { RelayAnimation } from "#/components/RelayAnimation.tsx";
import { formatExactTime, formatRelativeTime, runPhaseLabel, threadPreview, timestampValue } from "#/state/format.ts";
import {
	displayPath,
	lastWorkspace,
	rememberWorkspace,
	resolveWorkspaceInput,
	setHomeDir,
	workspaceName,
} from "#/state/workspace.ts";
import { VERSION } from "#/version.ts";

type ReadyBoot = Extract<BootResult, { kind: "ready" }>;

/** Workspaces whose thread lists the overview tracks for recent activity. */
const MAX_TRACKED_WORKSPACES = 4;
/** Recent threads listed under the continue card. */
const MAX_RECENT_THREADS = 5;

interface ThreadEntry {
	cwd: string;
	session: SessionSummary;
}

type HeroModel = { preset: string; model: string; label?: string; contextTokens?: number } | null;

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function activityValue(workspace: WorkspaceSummary): number {
	return timestampValue(workspace.lastActivity);
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
		// Warm the recent thread lists the overview activity reads.
		const recent = [...(boot.workspaces ?? [])]
			.sort((a, b) => activityValue(b) - activityValue(a))
			.slice(0, MAX_TRACKED_WORKSPACES);
		for (const workspace of recent) {
			if (workspace.cwd) void queryClient.prefetchQuery(sessionsQuery(workspace.cwd));
		}
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
	const totalThreads = createMemo(() => list().reduce((sum, workspace) => sum + workspace.sessionCount, 0));

	createEffect(() => setHomeDir(props.boot.config.home));

	const openWorkspace = (cwd: string) =>
		void navigate({ to: "/w/$token", params: { token: encodeWorkspaceToken(cwd) } });
	const openSession = (sessionId: string) => void navigate({ to: "/s/$sessionId", params: { sessionId } });

	return (
		<AppShell
			userName={props.boot.me.name}
			avatarUrl={props.boot.me.avatarUrl}
			activeSessionId={null}
			activeWorkspace={null}
			onOpenSettings={() => void navigate({ to: "/settings" })}
		>
			<div class="overview">
				<div class="overview-inner">
					<OverviewHero model={props.boot.config.model} workspaces={list().length} threads={totalThreads()} />
					<HeroComposer
						workspaces={list()}
						defaultCwd={props.boot.defaultCwd}
						defaultModel={props.boot.config.model}
						onSent={openSession}
					/>
					<OverviewDashboard
						workspaces={list()}
						onOpenSession={openSession}
						onOpenWorkspace={openWorkspace}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function OverviewHero(props: { model: string; workspaces: number; threads: number }) {
	const modelLabel = () => props.model.split("/").pop() ?? props.model;
	return (
		<header class="overview-hero">
			<div class="overview-hero-art">
				<RelayAnimation />
			</div>
			<div class="overview-hero-copy">
				<div class="overview-hero-mark">
					<span class="overview-wordmark">RELAY</span>
					<span class="overview-version">v{VERSION}</span>
				</div>
				<p class="overview-tagline">Coding agent on your workspaces · {modelLabel()}</p>
				<div class="overview-stats">
					<span>
						<b>{props.workspaces}</b> workspace{props.workspaces === 1 ? "" : "s"}
					</span>
					<span class="overview-stat-sep" />
					<span>
						<b>{props.threads}</b> thread{props.threads === 1 ? "" : "s"}
					</span>
				</div>
			</div>
		</header>
	);
}

/**
 * The command hub's prompt box: pick a workspace and a model, describe the
 * task, and land directly in a running thread.
 */
function HeroComposer(props: {
	workspaces: WorkspaceSummary[];
	defaultCwd: string;
	defaultModel: string;
	onSent: (sessionId: string) => void;
}) {
	const [value, setValue] = createSignal("");
	const [model, setModel] = createSignal<HeroModel>(null);
	const [target, setTarget] = createSignal("");
	const [pickerOpen, setPickerOpen] = createSignal(false);
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal("");
	let pickerRef: HTMLDivElement | undefined;

	const usable = createMemo(() => props.workspaces.filter((workspace) => workspace.exists !== false));

	/** Explicit pick, else the last visited workspace, else the first listed, else the server default. */
	const effectiveTarget = createMemo(() => {
		const chosen = target();
		const listed = usable();
		if (chosen && listed.some((workspace) => workspace.cwd === chosen)) return chosen;
		const last = lastWorkspace();
		if (last && listed.some((workspace) => workspace.cwd === last)) return last;
		return listed[0]?.cwd ?? props.defaultCwd;
	});

	const canSend = () => value().trim().length > 0 && effectiveTarget().length > 0 && !sending();

	createEffect(() => {
		if (!pickerOpen()) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (pickerRef && event.target instanceof Node && !pickerRef.contains(event.target)) {
				setPickerOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setPickerOpen(false);
		};
		globalThis.addEventListener("pointerdown", onPointerDown);
		globalThis.addEventListener("keydown", onKeyDown);
		onCleanup(() => {
			globalThis.removeEventListener("pointerdown", onPointerDown);
			globalThis.removeEventListener("keydown", onKeyDown);
		});
	});

	async function send(): Promise<void> {
		const content = value().trim();
		const cwd = effectiveTarget();
		if (!content || !cwd || sending()) return;
		const current = model();
		const selection: LlmModelSelection | null = current
			? {
					preset: current.preset,
					model: current.model,
					...(current.contextTokens !== undefined ? { contextTokens: current.contextTokens } : {}),
				}
			: null;
		setSending(true);
		setError("");
		try {
			const sessionId = await startChatWithMessage(cwd, content, selection);
			rememberWorkspace(cwd);
			props.onSent(sessionId);
		} catch (cause) {
			setError(toMessage(cause));
			setSending(false);
		}
	}

	function handleKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	return (
		<section class="hero" aria-label="Start a new thread">
			<div class="hero-composer">
				<textarea
					class="hero-input"
					rows={2}
					placeholder="Ask Relay anything, or describe a task to run in a workspace…"
					aria-label="Prompt for a new thread"
					value={value()}
					onInput={(event) => setValue(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
				/>
				<div class="hero-actions">
					<div class="hero-actions-left">
						<div class="workspace-picker" ref={pickerRef}>
							<button
								type="button"
								class={pickerOpen() ? "workspace-pill open" : "workspace-pill"}
								aria-haspopup="listbox"
								aria-expanded={pickerOpen()}
								title={effectiveTarget()}
								onClick={() => setPickerOpen((open) => !open)}
							>
								<span class="workspace-pill-icon">▣</span>
								<span class="workspace-pill-name">{workspaceName(effectiveTarget())}</span>
								<span class="workspace-pill-caret">▾</span>
							</button>
							<Show when={pickerOpen()}>
								<div class="workspace-popover">
									<div class="workspace-popover-head">
										<span>Workspace</span>
										<span>{usable().length} available</span>
									</div>
									<Show
										when={usable().length > 0}
										fallback={
											<p class="workspace-popover-empty">
												No workspaces yet — add a project directory below.
											</p>
										}
									>
										<div class="workspace-popover-list" role="listbox">
											<For each={usable()}>
												{(workspace) => (
													<button
														type="button"
														role="option"
														aria-selected={workspace.cwd === effectiveTarget()}
														class={
															workspace.cwd === effectiveTarget()
																? "workspace-option selected"
																: "workspace-option"
														}
														onClick={() => {
															setTarget(workspace.cwd);
															setPickerOpen(false);
														}}
													>
														<span class="workspace-option-name">
															{workspaceName(workspace.cwd)}
														</span>
														<span class="workspace-option-path">
															{displayPath(workspace.cwd)}
														</span>
														<span class="workspace-option-count">
															{workspace.sessionCount}
														</span>
													</button>
												)}
											</For>
										</div>
									</Show>
									<AddWorkspaceForm
										onAdded={(path) => {
											setTarget(path);
											setPickerOpen(false);
										}}
										onCancel={() => setPickerOpen(false)}
									/>
								</div>
							</Show>
						</div>
						<ModelSelector
							current={model()}
							defaultModel={props.defaultModel}
							onSelect={(selection, label) =>
								setModel(
									selection
										? {
												preset: selection.preset,
												model: selection.model,
												label,
												...(selection.contextTokens !== undefined
													? { contextTokens: selection.contextTokens }
													: {}),
											}
										: null,
								)
							}
						/>
					</div>
					<button
						type="button"
						class="btn primary hero-send"
						disabled={!canSend()}
						onClick={() => void send()}
					>
						{sending() ? "Starting…" : "Send ↵"}
					</button>
				</div>
			</div>
			<Show when={error()}>
				<p class="hero-error">{error()}</p>
			</Show>
			<p class="hero-hint">
				Runs in <code>{displayPath(effectiveTarget())}</code> · Enter to send · Shift+Enter for a new line
			</p>
		</section>
	);
}

/**
 * Recent activity + workspaces. The session queries are created here and every
 * `.data` read is guarded by `isPending`, so a first fetch can never suspend
 * the route into the full-screen boot screen (the component is not wrapped in
 * a Suspense boundary). Rows fill in as the lists arrive.
 */
function OverviewDashboard(props: {
	workspaces: WorkspaceSummary[];
	onOpenSession: (sessionId: string) => void;
	onOpenWorkspace: (cwd: string) => void;
}) {
	const [adding, setAdding] = createSignal(false);
	const [startingCwd, setStartingCwd] = createSignal("");
	const [createError, setCreateError] = createSignal("");

	const recent = createMemo(() => trackedWorkspaces(props.workspaces));
	const sessionQueries = useQueries(() => ({
		queries: recent().map((workspace) => sessionsQuery(workspace.cwd)),
	}));

	const sessionsByCwd = createMemo(() => {
		const byCwd = new Map<string, SessionSummary[]>();
		const tracked = recent();
		for (let index = 0; index < tracked.length; index++) {
			const workspace = tracked[index];
			const query = sessionQueries[index];
			if (!workspace || !query || query.isPending) continue;
			const sessions = query.data;
			if (sessions) byCwd.set(workspace.cwd, sessions);
		}
		return byCwd;
	});

	const threads = createMemo<ThreadEntry[]>(() => {
		const entries: ThreadEntry[] = [];
		for (const [cwd, sessions] of sessionsByCwd()) {
			for (const session of sessions) entries.push({ cwd, session });
		}
		entries.sort((a, b) => timestampValue(b.session.timestamp) - timestampValue(a.session.timestamp));
		return entries;
	});

	const loading = createMemo(() => recent().length > 0 && sessionsByCwd().size === 0);

	const continuation = createMemo<ThreadEntry | null>(() => {
		const list = threads();
		if (list.length === 0) return null;
		const stored = readStoredSessionId();
		return list.find((entry) => entry.session.id === stored) ?? list[0] ?? null;
	});

	const recentThreads = createMemo<ThreadEntry[]>(() => {
		const current = continuation();
		const rest = current ? threads().filter((entry) => entry.session.id !== current.session.id) : threads();
		return rest.slice(0, MAX_RECENT_THREADS);
	});

	const runningFor = (cwd: string): number =>
		(sessionsByCwd().get(cwd) ?? []).filter((session) => session.running).length;

	async function startIn(cwd: string): Promise<void> {
		if (startingCwd()) return;
		setStartingCwd(cwd);
		setCreateError("");
		try {
			const sessionId = await startChat(cwd, { forceNew: true });
			props.onOpenSession(sessionId);
		} catch (cause) {
			setCreateError(toMessage(cause));
			setStartingCwd("");
		}
	}

	return (
		<>
			<section class="overview-section overview-activity" aria-label="Recent activity">
				<Show
					when={continuation()}
					fallback={
						<Show
							when={loading()}
							fallback={
								<p class="overview-empty">
									No threads yet. Describe a task above to start your first one.
								</p>
							}
						>
							<div class="overview-loading">
								<div class="overview-loading-row" />
								<div class="overview-loading-row" />
							</div>
						</Show>
					}
				>
					{(entry) => <ContinueCard entry={entry()} onOpen={() => props.onOpenSession(entry().session.id)} />}
				</Show>

				<Show when={recentThreads().length > 0}>
					<div class="overview-section-head">
						<h2 class="overview-section-title">Recent threads</h2>
						<span class="overview-section-meta">across your active workspaces</span>
					</div>
					<div class="thread-feed">
						<For each={recentThreads()}>
							{(entry) => (
								<button
									type="button"
									class="feed-row"
									onClick={() => props.onOpenSession(entry.session.id)}
								>
									<span
										class={entry.session.running ? "feed-dot running" : "feed-dot"}
										aria-hidden="true"
									/>
									<span class="feed-main">
										<span class="feed-preview">{threadPreview(entry.session)}</span>
										<span class="feed-meta">
											<span class="feed-workspace">{workspaceName(entry.cwd)}</span>
											<span class="feed-sep" aria-hidden="true">
												·
											</span>
											<span class="feed-time" title={formatExactTime(entry.session.timestamp)}>
												{formatRelativeTime(entry.session.timestamp)}
											</span>
										</span>
									</span>
									<Show when={entry.session.running}>
										<RunningPill label={runPhaseLabel(entry.session.runPhase)} />
									</Show>
									<span class="feed-open" aria-hidden="true">
										→
									</span>
								</button>
							)}
						</For>
					</div>
				</Show>
			</section>

			<section class="overview-section" aria-label="Workspaces">
				<div class="overview-section-head">
					<h2 class="overview-section-title">Workspaces</h2>
					<span class="overview-section-meta">
						{props.workspaces.length} project{props.workspaces.length === 1 ? "" : "s"}
					</span>
					<Show
						when={!adding()}
						fallback={
							<AddWorkspaceForm
								onAdded={(path) => {
									setAdding(false);
									props.onOpenWorkspace(path);
								}}
								onCancel={() => setAdding(false)}
							/>
						}
					>
						<button type="button" class="overview-section-action" onClick={() => setAdding(true)}>
							+ Add workspace
						</button>
					</Show>
				</div>

				<Show when={createError()}>
					<p class="workspace-error">{createError()}</p>
				</Show>

				<Show
					when={props.workspaces.length > 0}
					fallback={
						<p class="overview-empty">
							No workspaces yet. Run <code>relay</code> in a project folder, or add one above.
						</p>
					}
				>
					<div class="overview-grid">
						<For each={props.workspaces}>
							{(workspace) => (
								<WorkspaceCard
									workspace={workspace}
									running={runningFor(workspace.cwd)}
									starting={startingCwd() === workspace.cwd}
									onOpen={() => props.onOpenWorkspace(workspace.cwd)}
									onStart={() => void startIn(workspace.cwd)}
								/>
							)}
						</For>
					</div>
				</Show>
			</section>
		</>
	);
}

function ContinueCard(props: { entry: ThreadEntry; onOpen: () => void }) {
	return (
		<button type="button" class="continue-card" onClick={props.onOpen}>
			<span class="continue-eyebrow">
				<span>Continue</span>
				<Show when={props.entry.session.running}>
					<RunningPill label={runPhaseLabel(props.entry.session.runPhase)} />
				</Show>
			</span>
			<span class="continue-title">{threadPreview(props.entry.session)}</span>
			<span class="continue-meta">
				<span class="continue-workspace">{workspaceName(props.entry.cwd)}</span>
				<span class="continue-sep">·</span>
				<span title={formatExactTime(props.entry.session.timestamp)}>
					{formatRelativeTime(props.entry.session.timestamp)}
				</span>
				<span class="continue-path">{displayPath(props.entry.cwd)}</span>
			</span>
			<span class="continue-arrow" aria-hidden="true">
				→
			</span>
		</button>
	);
}

function WorkspaceCard(props: {
	workspace: WorkspaceSummary;
	running: number;
	starting: boolean;
	onOpen: () => void;
	onStart: () => void;
}) {
	const missing = () => props.workspace.exists === false;
	return (
		<div class={missing() ? "overview-card missing" : "overview-card"}>
			<button type="button" class="overview-card-main" onClick={props.onOpen}>
				<span class="overview-card-head">
					<span class="overview-card-name">{workspaceName(props.workspace.cwd)}</span>
					<Show when={missing()}>
						<span class="pill warning">missing</span>
					</Show>
					<Show when={!missing() && props.running > 0}>
						<RunningPill label={`${props.running} running`} />
					</Show>
				</span>
				<span class="overview-card-path" title={props.workspace.cwd}>
					{displayPath(props.workspace.cwd)}
				</span>
				<span class="overview-card-meta">
					{missing()
						? "directory unavailable"
						: `${props.workspace.sessionCount} thread${props.workspace.sessionCount === 1 ? "" : "s"}`}
				</span>
			</button>
			<div class="overview-card-foot">
				<span class="overview-card-time">
					{props.workspace.lastActivity
						? `active ${formatRelativeTime(props.workspace.lastActivity)}`
						: "no activity yet"}
				</span>
				<button
					type="button"
					class="overview-card-start"
					disabled={missing() || props.starting}
					onClick={props.onStart}
				>
					{props.starting ? "Starting…" : "New thread →"}
				</button>
			</div>
		</div>
	);
}

function RunningPill(props: { label: string }) {
	return (
		<span class="pill running">
			<span class="pill-dot" aria-hidden="true" />
			{props.label}
		</span>
	);
}

function AddWorkspaceForm(props: { onAdded: (path: string) => void; onCancel?: () => void }) {
	const [draft, setDraft] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const resolved = resolveWorkspaceInput(draft());
		if (!resolved) {
			setError("Enter an absolute path (e.g. /home/me/project or ~/project).");
			return;
		}
		setError("");
		setBusy(true);
		const result = await addWorkspace(resolved);
		setBusy(false);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		setDraft("");
		props.onAdded(result.path);
	}

	return (
		<form class="workspace-add-inline" onSubmit={(event) => void submit(event)}>
			<input
				class="input"
				value={draft()}
				placeholder="/path/to/project"
				aria-label="Workspace directory"
				title="Server-side directory that scopes sessions and confines file tools"
				onInput={(event) => setDraft(event.currentTarget.value)}
			/>
			<button type="submit" class="btn" disabled={busy()}>
				{busy() ? "Checking…" : "Add"}
			</button>
			<Show when={props.onCancel}>
				{(cancel) => (
					<button type="button" class="btn ghost" onClick={cancel()}>
						Cancel
					</button>
				)}
			</Show>
			<Show when={error()}>
				<p class="workspace-error">{error()}</p>
			</Show>
		</form>
	);
}

/**
 * The workspaces whose thread lists feed the overview: the most recently active
 * ones, plus the last visited workspace so the continue card can find it.
 */
function trackedWorkspaces(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
	const ordered = [...workspaces].sort((a, b) => activityValue(b) - activityValue(a));
	const tracked = ordered.slice(0, MAX_TRACKED_WORKSPACES);
	const last = lastWorkspace();
	if (last && !tracked.some((workspace) => workspace.cwd === last)) {
		const match = ordered.find((workspace) => workspace.cwd === last);
		if (match) tracked.push(match);
	}
	return tracked;
}
