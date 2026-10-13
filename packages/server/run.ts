import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Result, Stream } from "effect";
import type { LLMProvider, Message, Usage } from "@vvtxn/relay/api/types.ts";
import { createToolRegistry, createWorkspaceTools, withApproval } from "@vvtxn/relay/core/tools/index.ts";
import { summarizeToolArgs } from "@vvtxn/relay/core/display.ts";
import { expandMentions, validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import {
	entriesToMessages,
	type SessionHandle,
	type SessionStore,
	stripAttachedContext,
} from "@vvtxn/relay/core/sessions/index.ts";
import { type RunnerCallbacks, runAgentLoop } from "@vvtxn/relay/core/runner.ts";
import { SYSTEM_PROMPT } from "@vvtxn/relay/core/system-prompt.ts";
import type { ApprovalDecision, PendingApprovalInfo, RunStateEvent, ServerEvent } from "@vvtxn/client/protocol.ts";
import type { ServerConfig } from "./config.ts";

type Subscriber = (event: ServerEvent) => void;
type RunFinishReason = Extract<ServerEvent, { type: "run_finished" }>["reason"];
type DraftToolCall = RunStateEvent["toolCalls"][number];

/** Mutable run state, owned by the run's fiber and read by snapshot/handlers. */
interface RunState {
	draftText: string;
	draftToolCalls: DraftToolCall[];
	draftIndex: Map<string, number>;
	pendingApprovals: Map<string, { deferred: Deferred.Deferred<ApprovalDecision>; info: PendingApprovalInfo }>;
	hadError: boolean;
}

/** One in-flight run: its fiber, its state, and the abort handle for the loop. */
interface ActiveRun {
	readonly ref: Ref.Ref<RunState>;
	readonly fiber: Fiber.Fiber<RunFinishReason, never>;
	readonly abort: AbortController;
}

/**
 * Per-session record: the cached handle, per-session approval memory, token /
 * cost totals, the active run (if any), and the SSE subscriber queues.
 */
interface SessionRecord {
	handle: SessionHandle | null;
	ownerId: string | null;
	readonly subscribers: Set<Queue.Queue<ServerEvent>>;
	readonly alwaysApproved: Set<string>;
	tokens: number;
	cost: number;
	run: ActiveRun | null;
}

/** Wraps a promise as an Effect, normalizing thrown values to `Error`. */
function attempt<A>(f: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({
		try: f,
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

/** Best-effort human-readable message for a failed run. */
function causeMessage(cause: Cause.Cause<unknown>): string {
	const failure = Cause.findErrorOption(cause);
	if (Option.isSome(failure)) {
		return failure.value instanceof Error ? failure.value.message : String(failure.value);
	}
	const defect = Cause.findDefect(cause);
	if (Result.isSuccess(defect)) {
		return defect.success instanceof Error ? defect.success.message : String(defect.success);
	}
	return Cause.pretty(cause);
}

/**
 * Owns the active agent runs: one per session at a time.
 *
 * Structured concurrency (phase 2 of the Effect migration):
 * - One fiber per run; `cancel` interrupts it and the finish reason comes from
 *   the run's `Exit` (`completed` / `error` / `cancelled`)
 * - Draft state lives in a `Ref` owned by the run
 * - Approvals are `Deferred`s; a finalizer denies whatever is still pending so
 *   the promises can never leak
 * - SSE fan-out goes through per-subscriber `Queue`s, registered synchronously
 *   so no event can slip between a subscriber's snapshot and its subscription
 *
 * Everything the run executes is a `runAgentLoop` promise for now (phase 3
 * converts the loop itself to a `Stream`); the fiber only supervises it.
 */
export class RunManager {
	private readonly config: ServerConfig;
	private readonly sessionStore: SessionStore;
	private readonly providerFor: (ownerId: string) => Promise<LLMProvider | null>;

	private readonly sessions = new Map<string, SessionRecord>();

	constructor(options: {
		config: ServerConfig;
		sessionStore: SessionStore;
		providerFor: (ownerId: string) => Promise<LLMProvider | null>;
	}) {
		this.config = options.config;
		this.sessionStore = options.sessionStore;
		this.providerFor = options.providerFor;
	}

	isRunning(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.run != null;
	}

	subscribe(sessionId: string, subscriber: Subscriber): () => void {
		const session = this.ensureSession(sessionId);
		// The queue is registered synchronously, before any fiber runs, so an
		// event published right after `subscribe` cannot be lost (the SSE
		// handler sends its `run_state` snapshot immediately before this call).
		const queue = Effect.runSync(Queue.unbounded<ServerEvent>());
		const fiber = Effect.runFork(
			Stream.runForEach(Stream.fromQueue(queue), (event) =>
				Effect.sync(() => {
					try {
						subscriber(event);
					} catch {
						// A broken subscriber must not break the run
					}
				}),
			),
		);
		session.subscribers.add(queue);
		return () => {
			if (!session.subscribers.delete(queue)) return;
			void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
			this.releaseIfIdle(sessionId);
		};
	}

	/** Drop the session record once it is idle and unwatched. */
	private releaseIfIdle(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.run) return;
		if (session.subscribers.size > 0) return;
		this.sessions.delete(sessionId);
	}

	private publish(sessionId: string, event: ServerEvent): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		for (const queue of session.subscribers) {
			Queue.offerUnsafe(queue, event);
		}
	}

	/** Current snapshot for a subscriber joining mid-run. */
	getRunState(sessionId: string): RunStateEvent | null {
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (!session || !run) return null;
		const state = Ref.getUnsafe(run.ref);
		const firstPending = state.pendingApprovals.values().next().value;
		return {
			type: "run_state",
			draftText: state.draftText,
			toolCalls: [...state.draftToolCalls],
			pendingApproval: firstPending ? firstPending.info : null,
			tokens: session.tokens,
			cost: session.cost,
		};
	}

	/** Resolve a pending approval; returns false when no approval is pending for that tool call. */
	resolveApproval(sessionId: string, toolCallId: string, decision: ApprovalDecision): boolean {
		const run = this.sessions.get(sessionId)?.run;
		if (!run) return false;

		// Take the Deferred out atomically so a concurrent finalizer cannot
		// resolve it twice.
		const deferred = Effect.runSync(
			Ref.modify(run.ref, (state): readonly [Deferred.Deferred<ApprovalDecision> | null, RunState] => {
				const pending = state.pendingApprovals.get(toolCallId);
				if (!pending) return [null, state];
				const pendingApprovals = new Map(state.pendingApprovals);
				pendingApprovals.delete(toolCallId);
				return [pending.deferred, { ...state, pendingApprovals }];
			}),
		);
		if (!deferred) return false;

		this.publish(sessionId, { type: "approval_resolved", toolCallId, decision });
		Deferred.doneUnsafe(deferred, Effect.succeed(decision));
		return true;
	}

	cancel(sessionId: string): boolean {
		const run = this.sessions.get(sessionId)?.run;
		if (!run) return false;
		void Effect.runPromise(Fiber.interrupt(run.fiber)).catch(() => {});
		return true;
	}

	/** Number of active runs (for tests and diagnostics). */
	get activeCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.run) count += 1;
		}
		return count;
	}

	/** True when the manager holds a handle for this session (opened or created). */
	hasHandle(sessionId: string, ownerId?: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session?.handle) return false;
		return ownerId === undefined || session.ownerId === ownerId;
	}

	/** The live handle for a session, when the server has one open (created or used this process). */
	getHandle(sessionId: string, ownerId?: string): SessionHandle | null {
		const session = this.sessions.get(sessionId);
		if (!session?.handle) return null;
		if (ownerId !== undefined && session.ownerId !== ownerId) return null;
		return session.handle;
	}

	/** Returns 202-style start; throws RunConflictError when a run is active. */
	startMessage(sessionId: string, content: string): void {
		const session = this.ensureSession(sessionId);
		if (session.run) throw new RunConflictError(sessionId);

		const ref = Ref.makeUnsafe<RunState>({
			draftText: "",
			draftToolCalls: [],
			draftIndex: new Map(),
			pendingApprovals: new Map(),
			hadError: false,
		});
		const abort = new AbortController();
		// The slot is claimed synchronously (above); the run itself executes on
		// its own fiber.
		const fiber = Effect.runFork(this.runProgram(sessionId, content, ref, abort));
		session.run = { ref, fiber, abort };
	}

	private runProgram(
		sessionId: string,
		content: string,
		runRef: Ref.Ref<RunState>,
		abort: AbortController,
	): Effect.Effect<RunFinishReason, never> {
		const config = this.config;
		const providerFor = this.providerFor;
		const getSession = () => this.sessions.get(sessionId);
		const publish = (event: ServerEvent): void => this.publish(sessionId, event);
		const updateRun = (f: (state: RunState) => RunState): void => {
			Effect.runSync(Ref.update(runRef, f));
		};
		const requestApproval = (tool: { definition: { function: { name: string } } }, input: unknown) =>
			this.requestApproval(sessionId, runRef, tool, input);

		const callbacks: RunnerCallbacks = {
			onTextDelta: (delta) => {
				updateRun((state) => ({ ...state, draftText: state.draftText + delta }));
				publish({ type: "text_delta", content: delta });
			},
			onToolCallStart: (id, name) => {
				publish({ type: "tool_call_start", id, name });
			},
			onToolCallArgsDelta: (id, args) => {
				publish({ type: "tool_call_args_delta", id, args });
			},
			onToolCallEnd: (id, name, args) => {
				updateRun((state) => {
					const draftIndex = new Map(state.draftIndex);
					draftIndex.set(id, state.draftToolCalls.length);
					return { ...state, draftToolCalls: [...state.draftToolCalls, { id, name, args }], draftIndex };
				});
				publish({ type: "tool_call_end", id, name, args });
			},
			onToolResult: (id, result) => {
				updateRun((state) => {
					const at = state.draftIndex.get(id);
					if (at === undefined || at >= state.draftToolCalls.length) return state;
					const draftToolCalls = [...state.draftToolCalls];
					const existing = draftToolCalls[at];
					if (existing) draftToolCalls[at] = { ...existing, result };
					return { ...state, draftToolCalls };
				});
				publish({ type: "tool_result", id, result });
			},
			onMessageComplete: (usage?: Usage) => {
				const session = getSession();
				if (usage && session) {
					// `tokens` is the current context-window usage (this call's
					// prompt + completion), not a running total: clients render it
					// against the model's context limit. `cost` does accumulate.
					session.tokens = usage.prompt_tokens + usage.completion_tokens;
					if (usage.cost) session.cost += usage.cost;
					session.handle?.setTokens(session.tokens);
					session.handle?.setCost(session.cost);
				}
				publish({
					type: "message_complete",
					...(usage ? { usage } : {}),
					tokens: session?.tokens ?? 0,
					cost: session?.cost ?? 0,
				});
			},
			onTurnComplete: async (assistantMessage: Message, toolResults: Message[]) => {
				const handle = getSession()?.handle;
				if (!handle) return;
				await handle.append({
					type: "message",
					role: "assistant",
					content: assistantMessage.content,
					...(assistantMessage.tool_calls?.length && { toolCalls: assistantMessage.tool_calls }),
				});
				// Draft tool calls carry the full results (including isError and the diff),
				// which the LLM-facing tool messages don't preserve.
				const results = Ref.getUnsafe(runRef).draftToolCalls;
				const resultById = new Map(results.map((tc) => [tc.id, tc.result]));
				for (const tr of toolResults) {
					const toolCallId = tr.tool_call_id;
					const toolName = tr.name;
					if (!toolCallId || !toolName) continue;
					const result = resultById.get(toolCallId);
					await handle.append({
						type: "tool_result",
						toolCallId,
						toolName,
						content: tr.content ?? "",
						...(result?.isError ? { isError: true } : {}),
						...(result?.meta?.diff ? { diff: result.meta.diff } : {}),
					});
				}
				publish({ type: "turn_complete" });
			},
			onError: (error) => {
				if (abort.signal.aborted) return;
				updateRun((state) => ({ ...state, hadError: true }));
				publish({ type: "error", message: error.message });
			},
		};

		const runLoop = Effect.gen(function* () {
			const session = getSession();
			const handle = session?.handle;
			if (!handle) {
				return yield* Effect.fail(new Error(`No open session handle for ${sessionId}`));
			}

			// Build the provider from the owner's stored key. Per-user keys live in
			// the database, so a run without one is a configuration error.
			const provider = yield* attempt(() => providerFor(session.ownerId ?? ""));
			if (!provider) {
				return yield* Effect.fail(new Error("No API key configured. Add one in Settings."));
			}

			// Re-validate the workspace before every run: the directory may have
			// been deleted or replaced by a symlink since the session was created.
			const storedCwd = handle.getHeader().cwd;
			const workspace = yield* attempt(() => validateWorkspacePath(storedCwd, config.workspaceRoots));
			if (!workspace.ok) {
				return yield* Effect.fail(new Error(`Workspace "${storedCwd}" is not usable: ${workspace.message}`));
			}
			const cwd = workspace.path;

			// Expand @mentions against the session workspace, persist the stripped version
			const expanded = yield* attempt(() => expandMentions(content, cwd));
			yield* attempt(() =>
				handle.append({ type: "message", role: "user", content: stripAttachedContext(expanded) }),
			);
			const messages = entriesToMessages(handle.getEntries());

			// The LLM sees the expanded content for the latest user message
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (message?.role === "user") {
					messages[i] = { ...message, content: expanded };
					break;
				}
			}

			const tools = createToolRegistry(
				withApproval(createWorkspaceTools(cwd), (tool, input) => requestApproval(tool, input)),
			);

			yield* attempt(() =>
				runAgentLoop(
					messages,
					{
						provider,
						tools,
						model: config.model,
						systemPrompt: SYSTEM_PROMPT,
						temperature: config.temperature,
						contextLimit: {
							maxTokens: config.maxTokens,
							preserveRecentTurns: config.preserveRecentTurns,
						},
						maxTokens: config.maxCompletionTokens,
						signal: abort.signal,
					},
					callbacks,
				),
			);

			if (abort.signal.aborted) return "cancelled";
			return Ref.getUnsafe(runRef).hadError ? "error" : "completed";
		});

		const program = runLoop.pipe(
			Effect.catchCause((cause) =>
				Effect.sync((): RunFinishReason => {
					if (abort.signal.aborted) return "cancelled";
					publish({ type: "error", message: causeMessage(cause) });
					return "error";
				}),
			),
		);

		return program.pipe(
			Effect.onExit((exit) => {
				const reason: RunFinishReason = Exit.isSuccess(exit)
					? exit.value
					: Cause.hasInterruptsOnly(exit.cause)
						? "cancelled"
						: "error";
				return this.finalizeRun(sessionId, reason);
			}),
		);
	}

	/**
	 * Run teardown, guaranteed to execute on completion, failure, and
	 * interruption: abort any in-flight provider call, deny still-pending
	 * approvals (their promises must never leak), flush the session, announce
	 * `run_finished`, and drop the session if nobody is watching.
	 */
	private finalizeRun(sessionId: string, reason: RunFinishReason): Effect.Effect<void> {
		const getSession = () => this.sessions.get(sessionId);
		const publish = (event: ServerEvent): void => this.publish(sessionId, event);
		const release = (): void => this.releaseIfIdle(sessionId);
		return Effect.gen(function* () {
			const session = getSession();
			if (!session) return;
			const run = session.run;
			session.run = null;
			if (run) {
				if (reason === "cancelled") run.abort.abort();
				for (const [toolCallId, pending] of Ref.getUnsafe(run.ref).pendingApprovals) {
					publish({ type: "approval_resolved", toolCallId, decision: "deny" });
					Deferred.doneUnsafe(pending.deferred, Effect.succeed<ApprovalDecision>("deny"));
				}
			}
			const handle = session.handle;
			if (handle) {
				yield* Effect.tryPromise(() => handle.flush()).pipe(Effect.catchCause(() => Effect.void));
			}
			publish({ type: "run_finished", reason });
			release();
		}).pipe(Effect.uninterruptible);
	}

	/** Attach an opened session handle so the run can persist to it. */
	attachHandle(sessionId: string, handle: SessionHandle, ownerId: string): void {
		const session = this.ensureSession(sessionId);
		session.handle = handle;
		session.ownerId = ownerId;
		session.tokens = handle.getTokens();
		session.cost = handle.getCost();
	}

	private ensureSession(sessionId: string): SessionRecord {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = {
				handle: null,
				ownerId: null,
				subscribers: new Set(),
				alwaysApproved: new Set(),
				tokens: 0,
				cost: 0,
				run: null,
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/**
	 * Ask the user for permission to run a side-effecting tool. The caller
	 * (`withApproval`) still awaits a promise; it is fulfilled by a `Deferred`
	 * that `resolveApproval` completes and that {@link finalizeRun} denies if
	 * the run ends first.
	 */
	private requestApproval(
		sessionId: string,
		runRef: Ref.Ref<RunState>,
		tool: { definition: { function: { name: string } } },
		input: unknown,
	): Promise<boolean> {
		const name = tool.definition.function.name;
		const session = this.sessions.get(sessionId);
		if (session?.alwaysApproved.has(name)) return Promise.resolve(true);
		if (session?.run?.abort.signal.aborted) return Promise.resolve(false);

		const deferred = Deferred.makeUnsafe<ApprovalDecision>();
		const toolCallId = crypto.randomUUID();
		const info: PendingApprovalInfo = {
			toolCallId,
			toolName: name,
			summary: summarizeToolArgs(name, JSON.stringify(input)),
		};

		Effect.runSync(
			Ref.update(runRef, (state) => {
				const pendingApprovals = new Map(state.pendingApprovals);
				pendingApprovals.set(toolCallId, { deferred, info });
				return { ...state, pendingApprovals };
			}),
		);
		this.publish(sessionId, { type: "approval_required", approval: info });

		return Effect.runPromise(Deferred.await(deferred)).then((decision) => {
			if (decision === "always") session?.alwaysApproved.add(name);
			return decision !== "deny";
		});
	}
}

/** Thrown when a message is sent to a session that already has an active run. */
export class RunConflictError extends Error {
	constructor(sessionId: string) {
		super(`A run is already active on session ${sessionId}`);
		this.name = "RunConflictError";
	}
}
