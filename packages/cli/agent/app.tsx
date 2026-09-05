import { createUIToolCall, entriesToUIMessages, getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";
import type { ConfigResponse, MeResponse, PendingApprovalInfo, ServerEvent } from "@vvtxn/client/protocol.ts";
import { signal } from "@preact/signals-core";
import { run } from "@/tui/render/index.ts";
import {
	ApprovalPrompt,
	Box,
	CommandPalette,
	ScrollArea,
	Spinner,
	Text,
	TextInput,
	WelcomeScreen,
} from "@/tui/render/components.tsx";
import { getHookKey, hasCleanup, setCleanup, useSignal, useSignalEffect } from "@/tui/render/hooks/signals.ts";
import { useApprovalPrompt } from "@/tui/render/hooks/approval.ts";
import { useTextInput, type VimMode } from "@/tui/render/hooks/text-input.ts";
import { type CommandPaletteItem, useCommandPalette } from "@/tui/render/hooks/command-palette.ts";
import { inputManager } from "@/tui/core/input.ts";
import { useProjectFiles } from "./hooks/project-files.ts";
import { client, serverUrl } from "./client.ts";
import { theme } from "@/tui/theme.ts";
import { VERSION } from "../version.ts";
import { StatusBar } from "./components/status-bar.tsx";
import { BootError, BootScreen } from "./components/boot-screen.tsx";
import { MessageView } from "./components/chat.tsx";

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
	{ id: "quit", title: "Quit", description: "Exit the agent", keywords: ["exit", "close"] },
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type AgentStatus =
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "running_tool"; toolName: string };

function formatStatus(status: AgentStatus): string {
	switch (status.kind) {
		case "thinking":
			return "Thinking...";
		case "writing":
			return "Writing...";
		case "running_tool":
			return `Running ${status.toolName}...`;
	}
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

interface AppProps {
	onQuit: () => void;
	user: MeResponse;
	initialSessionId: string;
	info: ConfigResponse;
}

function App({ onQuit, user, initialSessionId, info }: AppProps) {
	// Registered first so a pending approval consumes keys (Esc denies) before
	// the double-Esc cancel handler below sees them.
	const approval = useApprovalPrompt();
	const input = useSignal("");
	const cursor = useSignal(0);
	const mode = useSignal<VimMode>("INSERT");
	const isLoading = useSignal(false);
	const status = useSignal<AgentStatus>({ kind: "thinking" });
	const tokenCount = useSignal(0);
	const totalCost = useSignal(0);
	const sessionId = useSignal<string | null>(initialSessionId);
	const branchName = useSignal<string | null>(null);
	const uiMessages = useSignal<UIMessage[]>([]);
	const escPrimed = useSignal(false);

	// Streaming draft state (shared across the session's event stream)
	const draft = { text: "", toolCalls: [] as UIToolCall[], msgIndex: -1 };
	let toolCallIndex = new Map<string, number>();
	let syncTimer: ReturnType<typeof setTimeout> | null = null;
	let syncPending = false;
	let currentAsk: { sessionId: string; toolCallId: string } | null = null;
	const remotelyResolved = new Set<string>();

	const doSync = () => {
		const msgs = [...uiMessages.value];
		const entry: UIMessage = { role: "agent", content: draft.text, toolCalls: [...draft.toolCalls] };
		if (draft.msgIndex >= 0 && draft.msgIndex < msgs.length) {
			msgs[draft.msgIndex] = entry;
		} else {
			draft.msgIndex = msgs.length;
			msgs.push(entry);
		}
		uiMessages.value = msgs;
		syncPending = false;
	};

	const syncDraft = (force = false) => {
		if (force) {
			if (syncTimer) clearTimeout(syncTimer);
			syncTimer = null;
			doSync();
			return;
		}
		if (syncPending) return;
		syncPending = true;
		syncTimer = setTimeout(() => {
			syncTimer = null;
			doSync();
		}, 50);
	};

	const finalizeDraft = () => {
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = null;
		syncPending = false;
		if (draft.text || draft.toolCalls.length > 0) doSync();
		draft.text = "";
		draft.toolCalls = [];
		draft.msgIndex = -1;
		toolCallIndex = new Map();
	};

	const showError = (message: string) => {
		uiMessages.value = [...uiMessages.value, { role: "agent", content: `**Error:** ${message}` }];
	};

	const refreshSession = async () => {
		const id = sessionId.value;
		if (!id) return;
		try {
			const response = await client.openSession(id);
			if (sessionId.value !== id) return;
			uiMessages.value = entriesToUIMessages(response.entries);
			tokenCount.value = response.tokens;
			totalCost.value = response.cost;
			branchName.value = response.branch;
		} catch {
			// Keep the current view on transient failures
		}
	};

	// -----------------------------------------------------------------------
	// Approval flow — requests arrive as SSE events; decisions POST back
	// -----------------------------------------------------------------------

	const handleApprovalRequired = (info: PendingApprovalInfo) => {
		void (async () => {
			const askSessionId = sessionId.value;
			if (!askSessionId) return;
			currentAsk = { sessionId: askSessionId, toolCallId: info.toolCallId };
			const decision = await approval.ask({
				toolName: getToolDisplayName(info.toolName),
				summary: info.summary,
			});
			const wasCurrent = currentAsk?.toolCallId === info.toolCallId;
			currentAsk = null;
			if (!wasCurrent) return;
			if (remotelyResolved.has(info.toolCallId)) {
				remotelyResolved.delete(info.toolCallId);
				return;
			}
			if (sessionId.value !== askSessionId) return;
			try {
				await client.approve(askSessionId, info.toolCallId, decision);
			} catch {
				// The server already resolved (or dropped) this approval
			}
		})();
	};

	const dropPendingAsk = (denyOnServer: boolean) => {
		const ask = currentAsk;
		currentAsk = null;
		if (!ask) return;
		if (denyOnServer) void client.approve(ask.sessionId, ask.toolCallId, "deny").catch(() => {});
		approval.cancel();
	};

	// -----------------------------------------------------------------------
	// SSE event folding
	// -----------------------------------------------------------------------

	const foldEvent = (event: ServerEvent) => {
		switch (event.type) {
			case "run_state": {
				draft.text = event.draftText;
				draft.toolCalls = event.toolCalls.map((tc) => ({
					...createUIToolCall(tc.name, tc.args),
					output: tc.result?.content ?? "",
					diff: tc.result?.meta?.diff,
				}));
				toolCallIndex = new Map();
				event.toolCalls.forEach((tc, i) => toolCallIndex.set(tc.id, i));
				draft.msgIndex = -1;
				tokenCount.value = event.tokens;
				totalCost.value = event.cost;
				isLoading.value = true;
				if (event.pendingApproval) handleApprovalRequired(event.pendingApproval);
				syncDraft(true);
				break;
			}
			case "text_delta":
				status.value = { kind: "writing" };
				draft.text += event.content;
				syncDraft();
				break;
			case "tool_call_start":
				status.value = { kind: "running_tool", toolName: event.name };
				break;
			case "tool_call_end": {
				toolCallIndex.set(event.id, draft.toolCalls.length);
				draft.toolCalls.push(createUIToolCall(event.name, event.args));
				syncDraft(true);
				break;
			}
			case "tool_result": {
				const idx = toolCallIndex.get(event.id);
				if (idx !== undefined && idx < draft.toolCalls.length) {
					draft.toolCalls[idx] = {
						...draft.toolCalls[idx],
						output: event.result.content,
						diff: event.result.meta?.diff,
					};
				}
				syncDraft(true);
				break;
			}
			case "message_complete":
				tokenCount.value = event.tokens;
				totalCost.value = event.cost;
				status.value = { kind: "thinking" };
				break;
			case "turn_complete":
				finalizeDraft();
				status.value = { kind: "thinking" };
				break;
			case "approval_required":
				handleApprovalRequired(event.approval);
				break;
			case "approval_resolved":
				remotelyResolved.add(event.toolCallId);
				if (currentAsk?.toolCallId === event.toolCallId) {
					currentAsk = null;
					approval.cancel();
				}
				break;
			case "error":
				showError(event.message);
				break;
			case "run_finished":
				finalizeDraft();
				isLoading.value = false;
				void refreshSession();
				break;
		}
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
					for await (const event of client.subscribe(id, { signal: ac.signal })) {
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

	// Double-Esc to cancel the running turn (only when loading, so it doesn't
	// conflict with vim mode toggle)
	const cancelKey = getHookKey("cancel-");
	if (!hasCleanup(cancelKey)) {
		let lastEsc = 0;
		let escTimer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = inputManager.onKeyGlobal((event) => {
			if (event.key !== "escape" || !isLoading.value) return false;
			const id = sessionId.value;
			if (!id) return false;
			const now = Date.now();
			if (now - lastEsc < 1500) {
				void client.cancel(id).catch(() => {});
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

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	const handleSubmit = (value: string) => {
		const id = sessionId.value;
		if (!value.trim() || isLoading.value || !id) return;

		uiMessages.value = [...uiMessages.value, { role: "user", content: value }];
		input.value = "";
		cursor.value = 0;
		isLoading.value = true;
		status.value = { kind: "thinking" };

		void (async () => {
			try {
				await client.sendMessage(id, value);
			} catch (error) {
				isLoading.value = false;
				status.value = { kind: "thinking" };
				showError(error instanceof Error ? error.message : String(error));
			}
		})();
	};

	const openSessionById = (id: string) => {
		if (sessionId.value === id) return;
		dropPendingAsk(true);
		sessionId.value = id;
		uiMessages.value = [];
		tokenCount.value = 0;
		totalCost.value = 0;
		branchName.value = null;
		isLoading.value = false;
		// History + stream arrive via the session effect (refresh + subscribe)
	};

	const startNewChat = async () => {
		dropPendingAsk(true);
		try {
			const response = await client.createSession(Deno.cwd());
			sessionId.value = response.id;
			uiMessages.value = [];
			tokenCount.value = 0;
			totalCost.value = 0;
			branchName.value = null;
			isLoading.value = false;
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
			if (isLoading.value) return;
			void openSessionById(item.id);
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
				input.value = input.value.slice(0, start) + insertText + input.value.slice(start + 1);
				cursor.value = start + insertText.length;
				fileMentionStart.value = null;
			}
		},
		onDismiss: () => {
			projectFiles.cancelIndexing();
			const start = fileMentionStart.value;
			if (start !== null) {
				input.value = input.value.slice(0, start) + input.value.slice(start + 1);
				cursor.value = start;
				fileMentionStart.value = null;
			}
		},
	});

	const palette = useCommandPalette({
		items: COMMANDS,
		mode,
		onSelect: (item) => {
			if (item.id === "new-chat") {
				void startNewChat();
			} else if (item.id === "threads") {
				void client.listSessions(Deno.cwd()).then((response) => {
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
				}).catch((error) => {
					showError(error instanceof Error ? error.message : String(error));
				});
			} else if (item.id === "quit") {
				onQuit();
			}
		},
	});

	useTextInput({
		value: input,
		cursorPosition: cursor,
		mode,
		focused: true,
		onSubmit: handleSubmit,
		onCharInserted: (char, cursorPos) => {
			if (char === "@" && !filePalette.open.value && !palette.open.value && !isLoading.value) {
				fileMentionStart.value = cursorPos - 1;
				projectFiles.startIndexing();
				filePalette.openPalette();
			}
		},
	});

	return (
		<Box flex flexDirection="column" padding={1}>
			<StatusBar
				tokenCount={tokenCount.value}
				totalCost={totalCost.value}
				branchName={branchName.value ?? ""}
				userName={user.name}
				contextWindow={info.contextTokens}
				model={info.model}
			/>

			{uiMessages.value.length === 0
				? (
					<WelcomeScreen
						version={VERSION}
						userName={user.name}
						model={info.model}
						hints="Enter to send • @ for files • / for commands • PageUp/PageDown to scroll • i/Esc to toggle mode"
					/>
				)
				: (
					<ScrollArea flex flexDirection="column" padding={1} gap={1} scrollbar focused autoScroll>
						{uiMessages.value.map((msg, i) => <MessageView key={i} msg={msg} />)}
					</ScrollArea>
				)}

			<Box height={1} />
			<Box
				border="round"
				borderColor={theme.border}
				borderLabel={mode.value}
				borderLabelColor={theme.borderLabel}
				padding={1}
			>
				<TextInput
					value={input.value}
					cursorPosition={cursor.value}
					placeholder="Write a message..."
					placeholderColor={theme.textDim}
					focused
				/>
			</Box>

			{isLoading.value && (
				<Box flexDirection="row" padding={1}>
					<Box flexDirection="row" gap={1}>
						<Spinner color={theme.accent} />
						<Text color={theme.textMuted} bold italic>
							{formatStatus(status.value)}
						</Text>
						{escPrimed.value
							? (
								<Text color={theme.warning} bold>
									Press Esc again to cancel
								</Text>
							)
							: (
								<Text color={theme.textDim} italic>
									Esc to cancel
								</Text>
							)}
					</Box>
				</Box>
			)}

			<CommandPalette palette={palette} />
			<CommandPalette palette={filePalette} placeholder="Search files..." borderLabel="Files" />
			<CommandPalette palette={threadsPalette} placeholder="Search threads..." borderLabel="Threads" width={80} />
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
	| { kind: "ready"; user: MeResponse; sessionId: string; info: ConfigResponse };

const boot = signal<BootState>({ kind: "loading" });

void bootstrap();

async function bootstrap(): Promise<void> {
	try {
		try {
			await client.health();
		} catch {
			throw new Error(
				`Cannot reach the Relay server at ${serverUrl}. Start one with 'relay serve'.`,
			);
		}
		const [user, info] = await Promise.all([client.me(), client.getConfig()]);
		const response = await client.createSession(Deno.cwd());
		boot.value = { kind: "ready", user, sessionId: response.id, info };
	} catch (error) {
		boot.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function Root({ quit }: { quit: () => void }) {
	const state = boot.value;
	if (state.kind === "loading") return <BootScreen />;
	if (state.kind === "error") return <BootError message={state.message} />;
	return <App onQuit={quit} user={state.user} initialSessionId={state.sessionId} info={state.info} />;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

run((quit) => <Root quit={quit} />, () => {});
