import type { LLMProvider, Message, Usage } from "@vvtxn/relay/api/types.ts";
import type { ToolResult } from "@vvtxn/relay/core/tools/index.ts";
import { createToolRegistry, createWorkspaceTools, withApproval } from "@vvtxn/relay/core/tools/index.ts";
import { summarizeToolArgs } from "@vvtxn/relay/core/display.ts";
import { expandMentions } from "@vvtxn/relay/core/workspace.ts";
import {
	entriesToMessages,
	type SessionHandle,
	type SessionStore,
	stripAttachedContext,
} from "@vvtxn/relay/core/sessions/index.ts";
import { runAgentLoop } from "@vvtxn/relay/core/runner.ts";
import { SYSTEM_PROMPT } from "@vvtxn/relay/core/system-prompt.ts";
import type { ApprovalDecision, PendingApprovalInfo, RunStateEvent, ServerEvent } from "@vvtxn/client/protocol.ts";
import type { ServerConfig } from "./config.ts";

type Subscriber = (event: ServerEvent) => void;

interface PendingApproval {
	resolve: (decision: ApprovalDecision) => void;
	info: PendingApprovalInfo;
}

/**
 * Owns the active agent runs: one per session at a time.
 *
 * Responsibilities:
 * - Serialize runs per session (409-equivalent via `isRunning`)
 * - Bridge runner callbacks onto a per-session SSE subscriber bus
 * - Gate side-effecting tools through `withApproval` + pending-approval map
 * - Persist assistant/tool entries and token/cost on the session handle
 */
export class RunManager {
	private readonly config: ServerConfig;
	private readonly sessionStore: SessionStore;
	private readonly provider: LLMProvider;

	private readonly activeRuns = new Set<string>();
	private readonly aborts = new Map<string, AbortController>();
	private readonly subscribers = new Map<string, Set<Subscriber>>();
	private readonly pendingApprovals = new Map<string, Map<string, PendingApproval>>();
	private readonly alwaysApproved = new Map<string, Set<string>>();
	private readonly handles = new Map<string, SessionHandle>();

	/** In-flight draft state for run_state snapshots (late subscribers). */
	private readonly draftText = new Map<string, string>();
	private readonly draftToolCalls = new Map<
		string,
		{ id: string; name: string; args: string; result?: ToolResult }[]
	>();
	private readonly draftIndex = new Map<string, Map<string, number>>();
	private readonly tokens = new Map<string, number>();
	private readonly cost = new Map<string, number>();

	constructor(options: { config: ServerConfig; sessionStore: SessionStore; provider: LLMProvider }) {
		this.config = options.config;
		this.sessionStore = options.sessionStore;
		this.provider = options.provider;
	}

	isRunning(sessionId: string): boolean {
		return this.activeRuns.has(sessionId);
	}

	subscribe(sessionId: string, subscriber: Subscriber): () => void {
		let set = this.subscribers.get(sessionId);
		if (!set) {
			set = new Set();
			this.subscribers.set(sessionId, set);
		}
		set.add(subscriber);
		return () => {
			set.delete(subscriber);
			if (set.size === 0) this.subscribers.delete(sessionId);
		};
	}

	private emit(sessionId: string, event: ServerEvent): void {
		const set = this.subscribers.get(sessionId);
		if (!set) return;
		for (const subscriber of set) {
			try {
				subscriber(event);
			} catch {
				// A broken subscriber must not break the run
			}
		}
	}

	/** Current snapshot for a subscriber joining mid-run. */
	getRunState(sessionId: string): RunStateEvent | null {
		if (!this.activeRuns.has(sessionId)) return null;
		const pending = this.pendingApprovals.get(sessionId);
		const firstPending = pending?.values().next().value;
		return {
			type: "run_state",
			draftText: this.draftText.get(sessionId) ?? "",
			toolCalls: [...(this.draftToolCalls.get(sessionId) ?? [])],
			pendingApproval: firstPending ? firstPending.info : null,
			tokens: this.tokens.get(sessionId) ?? 0,
			cost: this.cost.get(sessionId) ?? 0,
		};
	}

	/** Resolve a pending approval; returns false when no approval is pending for that tool call. */
	resolveApproval(sessionId: string, toolCallId: string, decision: ApprovalDecision): boolean {
		const pending = this.pendingApprovals.get(sessionId);
		const approval = pending?.get(toolCallId);
		if (!pending || !approval) return false;

		pending.delete(toolCallId);
		this.emit(sessionId, { type: "approval_resolved", toolCallId, decision });
		approval.resolve(decision);
		return true;
	}

	cancel(sessionId: string): boolean {
		const controller = this.aborts.get(sessionId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	/** Number of active runs (for tests and diagnostics). */
	get activeCount(): number {
		return this.activeRuns.size;
	}

	/** True when the manager holds a handle for this session (opened or created). */
	hasHandle(sessionId: string): boolean {
		return this.handles.has(sessionId);
	}

	/** The live handle for a session, when the server has one open (created or used this process). */
	getHandle(sessionId: string): SessionHandle | null {
		return this.handles.get(sessionId) ?? null;
	}

	/** Returns 202-style start; throws RunConflictError when a run is active. */
	startMessage(sessionId: string, content: string): void {
		if (this.activeRuns.has(sessionId)) throw new RunConflictError(sessionId);
		// Claim the slot synchronously before the async work begins
		this.activeRuns.add(sessionId);
		void this.sendMessage(sessionId, content).catch(() => {
			// Errors are surfaced as SSE error events inside sendMessage
		});
	}

	private async sendMessage(sessionId: string, content: string): Promise<void> {
		// The slot was claimed by startMessage before this async body runs.

		// Get or open the handle for this session. The handle stays cached so
		// token/cost tracking persists across runs.
		const handle = this.handles.get(sessionId);
		if (!handle) {
			this.activeRuns.delete(sessionId);
			throw new Error(`No open session handle for ${sessionId}`);
		}

		const ac = new AbortController();
		this.aborts.set(sessionId, ac);

		// Reset draft state
		this.draftText.set(sessionId, "");
		this.draftToolCalls.set(sessionId, []);
		this.draftIndex.set(sessionId, new Map());

		let finished: ServerEvent = { type: "run_finished", reason: "completed" };

		try {
			const cwd = handle.getHeader().cwd;

			// Expand @mentions against the session workspace, persist the stripped version
			const expanded = await expandMentions(content, cwd);
			await handle.append({ type: "message", role: "user", content: stripAttachedContext(expanded) });
			const messages = entriesToMessages(handle.getEntries());

			// The LLM sees the expanded content for the latest user message
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					messages[i] = { ...messages[i], content: expanded };
					break;
				}
			}

			const tools = createToolRegistry(
				withApproval(
					createWorkspaceTools(cwd),
					(tool, input) => this.requestApproval(sessionId, tool, input, ac.signal),
				),
			);

			await runAgentLoop(messages, {
				provider: this.provider,
				tools,
				model: this.config.model,
				systemPrompt: SYSTEM_PROMPT,
				temperature: this.config.temperature,
				contextLimit: {
					maxTokens: this.config.maxTokens,
					preserveRecentTurns: this.config.preserveRecentTurns,
				},
				maxTokens: this.config.maxCompletionTokens,
				signal: ac.signal,
			}, {
				onTextDelta: (delta) => {
					this.draftText.set(sessionId, (this.draftText.get(sessionId) ?? "") + delta);
					this.emit(sessionId, { type: "text_delta", content: delta });
				},
				onToolCallStart: (id, name) => {
					this.emit(sessionId, { type: "tool_call_start", id, name });
				},
				onToolCallArgsDelta: (id, args) => {
					this.emit(sessionId, { type: "tool_call_args_delta", id, args });
				},
				onToolCallEnd: (id, name, args) => {
					const calls = this.draftToolCalls.get(sessionId)!;
					const index = this.draftIndex.get(sessionId)!;
					index.set(id, calls.length);
					calls.push({ id, name, args });
					this.emit(sessionId, { type: "tool_call_end", id, name, args });
				},
				onToolResult: (id, result) => {
					const calls = this.draftToolCalls.get(sessionId);
					const index = this.draftIndex.get(sessionId);
					const at = index?.get(id);
					if (calls && at !== undefined && at < calls.length) {
						calls[at] = { ...calls[at], result };
					}
					this.emit(sessionId, { type: "tool_result", id, result });
				},
				onMessageComplete: (usage?: Usage) => {
					if (usage) {
						this.tokens.set(sessionId, usage.prompt_tokens + usage.completion_tokens);
						if (usage.cost) {
							this.cost.set(sessionId, (this.cost.get(sessionId) ?? 0) + usage.cost);
						}
						handle.setTokens(this.tokens.get(sessionId)!);
						handle.setCost(this.cost.get(sessionId) ?? 0);
					}
					this.emit(sessionId, {
						type: "message_complete",
						usage,
						tokens: this.tokens.get(sessionId) ?? 0,
						cost: this.cost.get(sessionId) ?? 0,
					});
				},
				onTurnComplete: async (assistantMessage: Message, toolResults: Message[]) => {
					await handle.append({
						type: "message",
						role: "assistant",
						content: assistantMessage.content,
						...(assistantMessage.tool_calls?.length && { toolCalls: assistantMessage.tool_calls }),
					});
					for (const tr of toolResults) {
						await handle.append({
							type: "tool_result",
							toolCallId: tr.tool_call_id!,
							toolName: tr.name!,
							content: tr.content!,
						});
					}
					this.emit(sessionId, { type: "turn_complete" });
				},
				onError: (error) => {
					if (ac.signal.aborted) return;
					finished = { type: "run_finished", reason: "error" };
					this.emit(sessionId, { type: "error", message: error.message });
				},
			});

			if (ac.signal.aborted && finished.reason === "completed") {
				finished = { type: "run_finished", reason: "cancelled" };
			}
		} catch (error) {
			if (ac.signal.aborted) {
				finished = { type: "run_finished", reason: "cancelled" };
			} else {
				finished = { type: "run_finished", reason: "error" };
				this.emit(sessionId, {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			// Deny any approvals still pending so their promises don't leak
			const pending = this.pendingApprovals.get(sessionId);
			if (pending) {
				for (const [id, approval] of pending) {
					this.emit(sessionId, { type: "approval_resolved", toolCallId: id, decision: "deny" });
					approval.resolve("deny");
				}
				pending.clear();
			}

			this.activeRuns.delete(sessionId);
			this.aborts.delete(sessionId);
			this.draftText.delete(sessionId);
			this.draftToolCalls.delete(sessionId);
			this.draftIndex.delete(sessionId);
			await handle.flush().catch(() => {});
			this.emit(sessionId, finished);
		}
	}

	/** Attach an opened session handle so the run can persist to it. */
	attachHandle(sessionId: string, handle: SessionHandle): void {
		this.handles.set(sessionId, handle);
		this.tokens.set(sessionId, handle.getTokens());
		this.cost.set(sessionId, handle.getCost());
	}

	private async requestApproval(
		sessionId: string,
		tool: { definition: { function: { name: string } } },
		input: unknown,
		signal: AbortSignal,
	): Promise<boolean> {
		const name = tool.definition.function.name;
		const always = this.alwaysApproved.get(sessionId);
		if (always?.has(name)) return true;
		if (signal.aborted) return false;

		let pending = this.pendingApprovals.get(sessionId);
		if (!pending) {
			pending = new Map();
			this.pendingApprovals.set(sessionId, pending);
		}

		const toolCallId = crypto.randomUUID();
		const info: PendingApprovalInfo = {
			toolCallId,
			toolName: name,
			summary: summarizeToolArgs(name, JSON.stringify(input)),
		};

		const decision = await new Promise<ApprovalDecision>((resolve) => {
			pending!.set(toolCallId, { resolve, info });
			this.emit(sessionId, { type: "approval_required", approval: info });
			signal.addEventListener("abort", () => {
				if (pending!.delete(toolCallId)) {
					this.emit(sessionId, { type: "approval_resolved", toolCallId, decision: "deny" });
					resolve("deny");
				}
			}, { once: true });
		});

		if (decision === "always") {
			let set = this.alwaysApproved.get(sessionId);
			if (!set) {
				set = new Set();
				this.alwaysApproved.set(sessionId, set);
			}
			set.add(name);
		}
		return decision !== "deny";
	}
}

/** Thrown when a message is sent to a session that already has an active run. */
export class RunConflictError extends Error {
	constructor(sessionId: string) {
		super(`A run is already active on session ${sessionId}`);
		this.name = "RunConflictError";
	}
}
