import { entriesToUIMessages, getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import type { ConfigResponse, PendingApprovalInfo, ServerEvent } from "@vvtxn/client/protocol.ts";
import {
	applyServerEvent,
	initialSessionStreamState,
	resetSessionStreamState,
	type SessionStatus,
	type SessionStreamState,
	viewMessages,
} from "@vvtxn/client/session-state.ts";
import { batch, signal } from "@preact/signals-core";
import { run } from "#/tui/render/index.ts";
import {
	ApprovalPrompt,
	Box,
	CommandPalette,
	ScrollArea,
	Spinner,
	Text,
	TextInput,
	WelcomeScreen,
} from "#/tui/render/components.tsx";
import { getHookKey, hasCleanup, setCleanup, useSignal, useSignalEffect } from "#/tui/render/hooks/signals.ts";
import { useApprovalPrompt } from "#/tui/render/hooks/approval.ts";
import { useTextInput, type VimMode } from "#/tui/render/hooks/text-input.ts";
import { type CommandPaletteItem, useCommandPalette } from "#/tui/render/hooks/command-palette.ts";
import { inputManager } from "#/tui/core/input.ts";
import { useProjectFiles } from "./hooks/project-files.ts";
import { getClient, serverUrl } from "./client.ts";
import { resumeRequested, workspaceCwd } from "./config.ts";
import { openBrowser } from "./open.ts";
import { theme } from "#/tui/theme.ts";
import { VERSION } from "../version.ts";
import { StatusBar } from "./components/status-bar.tsx";
import { BootError, BootScreen } from "./components/boot-screen.tsx";
import { MessageView } from "./components/chat.tsx";
import { DiffViewer } from "./components/diff.tsx";
import { buildDiffRows, collectSessionDiffs, type DiffRows, type SessionDiff } from "./diffs.ts";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS: CommandPaletteItem[] = [
	{ id: "new-chat", title: "New Chat", description: "Start a new conversation", keywords: ["clear", "reset"] },
	{
		id: "threads",
		title: "Threads",
		description: "Switch to a previous session",
		keywords: ["sessions", "history"],
	},
	{
		id: "web",
		title: "Open in Browser",
		description: "Open this session in the web client",
		keywords: ["browser", "web", "url"],
	},
	{
		id: "diffs",
		title: "Review Changes",
		description: "Open the latest edit/write diff",
		keywords: ["diff", "diffs", "changes", "patch"],
	},
	{ id: "quit", title: "Quit", description: "Exit the agent", keywords: ["exit", "close"] },
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type AgentStatus = SessionStatus;

function formatStatus(status: AgentStatus): string {
	switch (status.kind) {
		case "idle":
			return "Ready";
		case "thinking":
			return "Thinking...";
		case "writing":
			return "Writing...";
		case "running_tool":
			return `Running ${getToolDisplayName(status.toolName)}...`;
	}
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

interface AppProps {
	onQuit: () => void;
	initialSessionId: string;
	info: ConfigResponse;
}

function App({ onQuit, initialSessionId, info }: AppProps) {
	// Registered first so a pending approval consumes keys (Esc denies) before
	// the double-Esc cancel handler below sees them.
	const approval = useApprovalPrompt();
	const input = useSignal("");
	const cursor = useSignal(0);
	const mode = useSignal<VimMode>("INSERT");
	const sessionId = useSignal<string | null>(initialSessionId);
	const branchName = useSignal<string | null>(null);
	const stream = useSignal<SessionStreamState>(initialSessionStreamState);
	const escPrimed = useSignal(false);

	// The TUI re-invokes component functions on every render, so cross-render
	// state lives in persisted signals. `sync.pending` accumulates events off
	// the render signal; `stream` is flushed on a 50ms throttle for text deltas
	// and immediately for structural events.
	const sync = useSignal<{
		pending: SessionStreamState;
		timer: ReturnType<typeof setTimeout> | null;
		syncing: boolean;
	}>({
		pending: initialSessionStreamState,
		timer: null,
		syncing: false,
	});
	const currentAsk = useSignal<{ sessionId: string; toolCallId: string } | null>(null);
	const remotelyResolved = useSignal<Set<string>>(new Set());
	/** Session id whose history is still loading — shows a hint instead of the welcome screen. */
	const loadingSession = useSignal<string | null>(null);
	/**
	 * Open diff review: the session's diffs at the time it was opened, the
	 * selected position, and pre-built full-context rows. Held by value so
	 * streamed events behind the overlay never close or re-parse it.
	 */
	const diffViewer = useSignal<{
		diffs: SessionDiff[];
		index: number;
		view: DiffRows;
	} | null>(null);

	const pushStream = () => {
		stream.value = sync.value.pending;
		sync.value.syncing = false;
	};

	const syncStream = (force = false) => {
		if (force) {
			if (sync.value.timer) clearTimeout(sync.value.timer);
			sync.value.timer = null;
			pushStream();
			return;
		}
		if (sync.value.syncing) return;
		sync.value.syncing = true;
		sync.value.timer = setTimeout(() => {
			sync.value.timer = null;
			pushStream();
		}, 50);
	};

	const showError = (message: string) => {
		sync.value.pending = applyServerEvent(sync.value.pending, { type: "error", message });
		syncStream(true);
	};

	const refreshSession = async () => {
		const id = sessionId.value;
		if (!id) return;
		try {
			const response = await getClient().openSession(id);
			if (sessionId.value !== id) return;
			sync.value.pending = {
				...sync.value.pending,
				messages: entriesToUIMessages(response.entries),
				draftText: "",
				draftToolCalls: [],
				toolCallIndex: {},
				cost: response.cost,
			};
			syncStream(true);
			branchName.value = response.branch;
			loadingSession.value = null;
		} catch {
			// Keep the current view on transient failures
			loadingSession.value = null;
		}
	};

	// -----------------------------------------------------------------------
	// Approval flow — requests arrive as SSE events; decisions POST back
	// -----------------------------------------------------------------------

	const handleApprovalRequired = (info: PendingApprovalInfo) => {
		// The server keeps at most one approval pending per session (side-effect
		// tools run sequentially), so never replace an open prompt: doing so would
		// drop its decision and leave the server waiting forever.
		if (currentAsk.value) return;
		void (async () => {
			const askSessionId = sessionId.value;
			if (!askSessionId) return;
			currentAsk.value = { sessionId: askSessionId, toolCallId: info.toolCallId };
			const decision = await approval.ask({
				toolName: getToolDisplayName(info.toolName),
				summary: info.summary,
			});
			const wasCurrent = currentAsk.value?.toolCallId === info.toolCallId;
			currentAsk.value = null;
			if (!wasCurrent) return;
			if (remotelyResolved.value.has(info.toolCallId)) {
				remotelyResolved.value.delete(info.toolCallId);
				return;
			}
			if (sessionId.value !== askSessionId) return;
			try {
				await getClient().approve(askSessionId, info.toolCallId, decision);
			} catch {
				// The server already resolved (or dropped) this approval
			}
		})();
	};

	const dropPendingAsk = (denyOnServer: boolean) => {
		const ask = currentAsk.value;
		currentAsk.value = null;
		if (!ask) return;
		if (denyOnServer)
			void getClient()
				.approve(ask.sessionId, ask.toolCallId, "deny")
				.catch(() => {});
		approval.cancel();
	};

	// -----------------------------------------------------------------------
	// SSE event folding
	// -----------------------------------------------------------------------

	const foldEvent = (event: ServerEvent) => {
		if (event.type === "run_state" && event.pendingApproval) handleApprovalRequired(event.pendingApproval);
		if (event.type === "approval_required") handleApprovalRequired(event.approval);
		if (event.type === "approval_resolved") {
			remotelyResolved.value.add(event.toolCallId);
			if (currentAsk.value?.toolCallId === event.toolCallId) {
				currentAsk.value = null;
				approval.cancel();
			}
		}
		sync.value.pending = applyServerEvent(sync.value.pending, event);
		syncStream(event.type !== "text_delta");
		if (event.type === "run_finished") void refreshSession();
	};

	// -----------------------------------------------------------------------
	// Session stream — one subscription per session, reconnect with backoff
	// -----------------------------------------------------------------------

	useSignalEffect(() => {
		const id = sessionId.value;
		if (!id) return;
		const ac = new AbortController();
		let backoff = 500;

		void (async () => {
			while (!ac.signal.aborted) {
				try {
					for await (const event of getClient().subscribe(id, { signal: ac.signal })) {
						if (sessionId.value !== id) break;
						foldEvent(event);
					}
				} catch (error) {
					if (ac.signal.aborted || sessionId.value !== id) break;
					showError(`Stream error: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (ac.signal.aborted || sessionId.value !== id) break;
				await new Promise((resolve) => setTimeout(resolve, backoff));
				backoff = Math.min(backoff * 2, 5000);
			}
		})();

		// Load the session content (branch, tokens, history) for the new id
		void refreshSession();

		return () => ac.abort();
	});

	// -----------------------------------------------------------------------
	// Diff review overlay
	// -----------------------------------------------------------------------

	const openDiffViewer = (index?: number) => {
		const diffs = collectSessionDiffs(viewMessages(stream.value));
		if (diffs.length === 0) return;
		const next = Math.max(0, Math.min(index ?? diffs.length - 1, diffs.length - 1));
		const diff = diffs[next];
		if (!diff) return;
		diffViewer.value = { diffs, index: next, view: buildDiffRows(diff.diff, { context: true }) };
	};

	const cycleDiffViewer = (delta: number) => {
		const current = diffViewer.value;
		if (!current) return;
		// Rebuild so changes that arrived while the overlay was open are included.
		const diffs = collectSessionDiffs(viewMessages(stream.value));
		if (diffs.length === 0) {
			diffViewer.value = null;
			return;
		}
		const index = (current.index + delta + diffs.length) % diffs.length;
		const diff = diffs[index];
		if (!diff) return;
		diffViewer.value = { diffs, index, view: buildDiffRows(diff.diff, { context: true }) };
	};

	const closeDiffViewer = () => {
		diffViewer.value = null;
	};

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	const handleSubmit = (value: string) => {
		const id = sessionId.value;
		if (!value.trim() || stream.value.running || !id) return;

		sync.value.pending = {
			...sync.value.pending,
			messages: [...sync.value.pending.messages, { role: "user", content: value }],
			running: true,
			status: { kind: "thinking" },
		};
		syncStream(true);
		batch(() => {
			input.value = "";
			cursor.value = 0;
		});

		void (async () => {
			try {
				await getClient().sendMessage(id, value);
			} catch (error) {
				sync.value.pending = { ...sync.value.pending, running: false, status: { kind: "idle" } };
				syncStream(true);
				showError(error instanceof Error ? error.message : String(error));
			}
		})();
	};

	const openSessionById = (id: string) => {
		if (sessionId.value === id) return;
		dropPendingAsk(true);
		closeDiffViewer();
		sessionId.value = id;
		sync.value.pending = resetSessionStreamState();
		syncStream(true);
		branchName.value = null;
		loadingSession.value = id;
		// History + stream arrive via the session effect (refresh + subscribe)
	};

	const startNewChat = async () => {
		dropPendingAsk(true);
		closeDiffViewer();
		try {
			const response = await getClient().createSession(workspaceCwd());
			sessionId.value = response.id;
			sync.value.pending = resetSessionStreamState();
			syncStream(true);
			branchName.value = null;
			loadingSession.value = null;
		} catch (error) {
			showError(error instanceof Error ? error.message : String(error));
		}
	};

	// -----------------------------------------------------------------------
	// Palettes
	// -----------------------------------------------------------------------

	const fileMentionStart = useSignal<number | null>(null);
	const projectFiles = useProjectFiles(() => sessionId.value);

	const threadItems = useSignal<CommandPaletteItem[]>([]);

	const threadsPalette = useCommandPalette({
		items: threadItems.value,
		openKey: null,
		maxResults: 20,
		onSelect: (item) => {
			if (stream.value.running) return;
			openSessionById(item.id);
		},
	});

	const filePalette = useCommandPalette({
		items: projectFiles.files.value,
		openKey: null,
		maxResults: 10,
		onSelect: (item) => {
			const start = fileMentionStart.value;
			if (start !== null) {
				const insertText = `@${item.title} `;
				batch(() => {
					input.value = input.value.slice(0, start) + insertText + input.value.slice(start + 1);
					cursor.value = start + insertText.length;
					fileMentionStart.value = null;
				});
			}
		},
		onDismiss: () => {
			projectFiles.cancelIndexing();
			const start = fileMentionStart.value;
			if (start !== null) {
				batch(() => {
					input.value = input.value.slice(0, start) + input.value.slice(start + 1);
					cursor.value = start;
					fileMentionStart.value = null;
				});
			}
		},
	});

	const palette = useCommandPalette({
		items: COMMANDS,
		mode,
		// The review overlay owns the keyboard while it is open.
		openKey: diffViewer.value === null ? "/" : null,
		onSelect: (item) => {
			if (item.id === "new-chat") {
				void startNewChat();
			} else if (item.id === "threads") {
				void getClient()
					.listSessions(workspaceCwd())
					.then((response) => {
						threadItems.value = response.sessions.map((s) => {
							const date = new Date(s.timestamp);
							const label = date.toLocaleString();
							const preview = s.firstUserMessage
								? s.firstUserMessage.length > 45
									? s.firstUserMessage.slice(0, 45) + "…"
									: s.firstUserMessage
								: "(empty session)";
							return { id: s.reference, title: preview, description: label, keywords: [s.id] };
						});
						threadsPalette.openPalette();
					})
					.catch((error) => {
						showError(error instanceof Error ? error.message : String(error));
					});
			} else if (item.id === "web") {
				const id = sessionId.value;
				openBrowser(id ? `${info.webUrl}/s/${id}` : info.webUrl);
			} else if (item.id === "diffs") {
				openDiffViewer();
			} else if (item.id === "quit") {
				onQuit();
			}
		},
	});

	useTextInput({
		value: input,
		cursorPosition: cursor,
		mode,
		focused: diffViewer.value === null,
		onSubmit: handleSubmit,
		onCharInserted: (char, cursorPos) => {
			if (char === "@" && !filePalette.open.value && !palette.open.value && !stream.value.running) {
				fileMentionStart.value = cursorPos - 1;
				projectFiles.startIndexing();
				filePalette.openPalette();
			}
		},
	});

	// Diff review keys are registered after the palettes (so an open palette
	// consumes them) and before cancel (so Escape closes the overlay instead of
	// priming run cancellation). Navigation keys fall through to the overlay's
	// ScrollArea; every other key is swallowed so the composer can't type behind it.
	const diffViewerKey = getHookKey("diff-viewer-");
	if (!hasCleanup(diffViewerKey)) {
		const cleanup = inputManager.onKeyGlobal((event) => {
			if (event.ctrl && event.key === "o") {
				if (diffViewer.value) closeDiffViewer();
				else openDiffViewer();
				return true;
			}

			if (!diffViewer.value) return false;

			if (event.key === "escape" || event.key === "q") {
				closeDiffViewer();
				return true;
			}
			if (!event.ctrl && !event.meta && event.key === "n") {
				cycleDiffViewer(1);
				return true;
			}
			if (!event.ctrl && !event.meta && event.key === "p") {
				cycleDiffViewer(-1);
				return true;
			}
			if (event.ctrl && event.key === "c") return false;

			if (["up", "down", "pageup", "pagedown", "wheelup", "wheeldown"].includes(event.key)) return false;
			return true;
		});
		setCleanup(diffViewerKey, cleanup);
	}

	// Double-Esc to cancel the running turn (only when loading, so it doesn't
	// conflict with vim mode toggle)
	const cancelKey = getHookKey("cancel-");
	if (!hasCleanup(cancelKey)) {
		let lastEsc = 0;
		let escTimer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = inputManager.onKeyGlobal((event) => {
			if (event.key !== "escape" || !stream.value.running) return false;
			const id = sessionId.value;
			if (!id) return false;
			const now = Date.now();
			if (now - lastEsc < 1500) {
				void getClient()
					.cancel(id)
					.catch(() => {});
				lastEsc = 0;
				escPrimed.value = false;
				if (escTimer) {
					clearTimeout(escTimer);
					escTimer = null;
				}
			} else {
				lastEsc = now;
				escPrimed.value = true;
				if (escTimer) clearTimeout(escTimer);
				escTimer = setTimeout(() => {
					escPrimed.value = false;
					escTimer = null;
				}, 1500);
			}
			return true;
		});
		setCleanup(cancelKey, cleanup);
	}

	const messages = viewMessages(stream.value);
	const hasDiffs = messages.some((message) => message.toolCalls?.some((call) => call.diff !== undefined));
	const viewer = diffViewer.value;
	const viewerDiff = viewer?.diffs[viewer.index];

	return (
		<Box flex flexDirection="column" padding={1} bgColor={theme.background}>
			<StatusBar totalCost={stream.value.cost} branchName={branchName.value ?? ""} />

			{messages.length === 0 ? (
				loadingSession.value !== null ? (
					<Box flex flexDirection="column" justifyContent="center" alignItems="center">
						<Text color={theme.textDim} italic>
							Loading thread…
						</Text>
					</Box>
				) : (
					<WelcomeScreen hints="Enter to send • @ for files • / for commands • PageUp/PageDown to scroll • i/Esc to toggle mode" />
				)
			) : (
				<ScrollArea
					flex
					flexDirection="column"
					paddingX={2}
					paddingY={1}
					gap={1}
					scrollbar
					focused={viewer === null}
					autoScroll
				>
					{messages.map((msg, i) => (
						<MessageView key={i} msg={msg} />
					))}
				</ScrollArea>
			)}

			<Box height={1} />
			<Box
				paddingX={1}
				paddingY={1}
				borderColor={theme.border}
				borderRadius
				borderLabel={mode.value}
				borderLabelColor={theme.borderLabel}
			>
				<TextInput
					value={input.value}
					cursorPosition={cursor.value}
					placeholder="Write a message..."
					placeholderColor={theme.textDim}
					focused={viewer === null}
					maxLines={8}
				/>
			</Box>

			<Box flexDirection="row" gap={1} paddingX={2} paddingTop={1} justifyContent="space-between">
				<Box flexDirection="row" gap={1}>
					{stream.value.running ? (
						<>
							<Spinner color={theme.accent} />
							<Text color={theme.textMuted} bold italic>
								{formatStatus(stream.value.status)}
							</Text>
							{escPrimed.value ? (
								<Text color={theme.warning} bold>
									Press Esc again to cancel
								</Text>
							) : (
								<Text color={theme.textDim} italic>
									Esc to cancel
								</Text>
							)}
						</>
					) : (
						<Text color={theme.textFaint} italic>
							{hasDiffs
								? "@ files • / commands • ctrl+o diffs • i/Esc mode"
								: "@ files • / commands • i/Esc mode"}
						</Text>
					)}
				</Box>
				<Text color={theme.textFaint}>v{VERSION}</Text>
			</Box>

			{viewer && viewerDiff && (
				<DiffViewer diff={viewerDiff} view={viewer.view} index={viewer.index} total={viewer.diffs.length} />
			)}

			<CommandPalette palette={palette} />
			<CommandPalette palette={filePalette} placeholder="Search files..." />
			<CommandPalette palette={threadsPalette} placeholder="Search threads..." width={80} />
			<ApprovalPrompt approval={approval} />
		</Box>
	);
}

// ---------------------------------------------------------------------------
// Boot — verify the server is reachable, resolve the user, create a session
// ---------------------------------------------------------------------------

type BootState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; sessionId: string; info: ConfigResponse };

const boot = signal<BootState>({ kind: "loading" });

void bootstrap();

async function bootstrap(): Promise<void> {
	try {
		try {
			await getClient().health();
		} catch {
			throw new Error(`Cannot reach the Relay server at ${serverUrl()}. Start one with 'relay serve'.`);
		}
		// `me()` validates the session; the CLI no longer renders the user identity.
		const [, info] = await Promise.all([getClient().me(), getClient().getConfig()]);
		const sessionId = await initialSession(workspaceCwd());
		boot.value = { kind: "ready", sessionId, info };
	} catch (error) {
		boot.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * `-c`/`--continue` resumes the most recent thread for the workspace; without
 * it the server creates a session, reusing an idle empty one when it can.
 */
async function initialSession(cwd: string): Promise<string> {
	if (resumeRequested()) {
		const { sessions } = await getClient().listSessions(cwd);
		const recent = sessions[0];
		if (recent) return recent.reference;
	}
	const created = await getClient().createSession(cwd);
	return created.id;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function Root({ quit }: { quit: () => void }) {
	const state = boot.value;
	if (state.kind === "loading") return <BootScreen />;
	if (state.kind === "error") return <BootError message={state.message} />;
	return <App onQuit={quit} initialSessionId={state.sessionId} info={state.info} />;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

run(
	(quit) => <Root quit={quit} />,
	() => {},
	{ defaultBg: theme.background },
);
