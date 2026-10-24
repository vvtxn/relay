import { Cause, Deferred, Effect, Exit, Fiber, Queue, Ref, Semaphore, Stream } from "effect";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { BoxLease, BoxManager } from "@vvtxn/box/types.ts";
import { DisabledBoxManager } from "@vvtxn/box/manager.ts";
import { resolveProjectBoxSettings } from "@vvtxn/box/config.ts";
import { isPreparedBoxImage } from "@vvtxn/box/images.ts";
import { profileForSettings } from "@vvtxn/box/profiles.ts";
import {
	createDelegateTool,
	createToolRegistry,
	createWorkspaceTools,
	withApproval,
} from "@vvtxn/relay/core/tools/index.ts";
import { summarizeToolArgs } from "@vvtxn/relay/core/display.ts";
import { expandMentions, validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import { entriesToMessages, type SessionHandle, stripAttachedContext } from "@vvtxn/relay/core/sessions/index.ts";
import { type AgentEvent, run } from "@vvtxn/relay/core/agent.ts";
import { attempt, causeMessage, type StoreError } from "@vvtxn/relay/core/effect.ts";
import { buildSystemPrompt } from "@vvtxn/relay/core/prompts.ts";
import type { ApprovalDecision, PendingApprovalInfo, RunStateEvent, ServerEvent } from "@vvtxn/client/protocol.ts";
import type { ServerConfig } from "./config.ts";
import { createBoxBashTool, createBoxTool } from "./box-tools.ts";

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
	/**
	 * Serializes approval prompts. Side-effect tools may execute in parallel
	 * (the agent loop runs them concurrently across distinct resources), but
	 * the protocol surfaces one pending approval at a time, so the prompt
	 * section of `requestApproval` holds this permit.
	 */
	readonly approvalLock: Semaphore.Semaphore;
	tokens: number;
	cost: number;
	run: ActiveRun | null;
}

/**
 * Owns the active agent runs: one per session at a time.
 *
 * Structured concurrency:
 * - One fiber per run; `cancel` interrupts it and the finish reason comes from
 *   the run's `Exit` (`completed` / `error` / `cancelled`)
 * - Draft state lives in a `Ref` owned by the run
 * - Approvals are `Deferred`s; a finalizer denies whatever is still pending so
 *   the promises can never leak
 * - SSE fan-out goes through per-subscriber `Queue`s, registered synchronously
 *   so no event can slip between a subscriber's snapshot and its subscription
 *
 * The agent loop itself is the `run()` stream; the run fiber consumes it and
 * mirrors each event onto the draft state and subscribers.
 */
export class RunManager {
	private readonly config: ServerConfig;
	private readonly providerFor: (ownerId: string) => Effect.Effect<LLMProvider | null, StoreError>;
	private readonly boxes: BoxManager;

	private readonly sessions = new Map<string, SessionRecord>();

	constructor(options: {
		config: ServerConfig;
		providerFor: (ownerId: string) => Effect.Effect<LLMProvider | null, StoreError>;
		boxes?: BoxManager;
	}) {
		this.config = options.config;
		this.providerFor = options.providerFor;
		this.boxes = options.boxes ?? new DisabledBoxManager();
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

	/**
	 * Subscribes as a `Stream` of events, for Effect-native consumers (the SSE
	 * response). The queue is registered synchronously; the subscription is
	 * released when the stream ends or is interrupted.
	 */
	subscribeStream(sessionId: string): Stream.Stream<ServerEvent> {
		const session = this.ensureSession(sessionId);
		const queue = Effect.runSync(Queue.unbounded<ServerEvent>());
		session.subscribers.add(queue);
		return Stream.fromQueue(queue).pipe(
			Stream.ensuring(
				Effect.sync(() => {
					if (session.subscribers.delete(queue)) this.releaseIfIdle(sessionId);
				}),
			),
		);
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

	/** Number of active runs (for diagnostics). */
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

	/**
	 * The idle, never-used session for this owner and workspace, when one is
	 * still open. Empty sessions are not persisted until their first message,
	 * so this is the only place "reuse the blank chat" can be enforced; it keeps
	 * repeated `relay` launches and "New chat" clicks from piling up handles.
	 */
	findIdleEmpty(ownerId: string, cwd: string): SessionHandle | null {
		for (const session of this.sessions.values()) {
			const handle = session.handle;
			if (!handle || session.ownerId !== ownerId || session.run) continue;
			if (handle.getHeader().cwd !== cwd) continue;
			if (handle.getEntries().length > 0) continue;
			return handle;
		}
		return null;
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
		const boxes = this.boxes;
		const getSession = () => this.sessions.get(sessionId);
		const publish = (event: ServerEvent): void => this.publish(sessionId, event);
		const requestApproval = (tool: { definition: { function: { name: string } } }, input: unknown) =>
			this.requestApproval(sessionId, runRef, tool, input);
		const handleEvent = (event: AgentEvent): Effect.Effect<void, Error> =>
			this.handleAgentEvent(sessionId, runRef, abort, event);

		const runLoop = Effect.gen(function* () {
			const session = getSession();
			const handle = session?.handle;
			if (!handle) {
				return yield* Effect.fail(new Error(`No open session handle for ${sessionId}`));
			}

			// Build the provider from the owner's stored key. Per-user keys live in
			// the database, so a run without one is a configuration error.
			const provider = yield* providerFor(session.ownerId ?? "");
			if (!provider) {
				return yield* Effect.fail(new Error("No API key configured. Add one in Settings."));
			}

			// Re-validate the workspace before every run: the directory may have
			// been deleted or replaced by a symlink since the session was created.
			// With boxes enabled, the box manifest is the durable workspace; the
			// project path is only needed to create the first clone.
			const storedCwd = handle.getHeader().cwd;
			const ownerId = session.ownerId ?? "";
			let cwd: string;
			let lease: BoxLease | null = null;

			if (boxes.enabled) {
				const existing = yield* boxes.findBySession(sessionId);
				if (existing) {
					lease = yield* boxes.acquire({
						sessionId,
						ownerId,
						projectCwd: existing.projectCwd,
						settings: existing.settings,
						signal: abort.signal,
					});
				} else {
					const workspace = yield* attempt(() => validateWorkspacePath(storedCwd, config.workspaceRoots));
					if (!workspace.ok) {
						return yield* Effect.fail(
							new Error(`Workspace "${storedCwd}" is not usable: ${workspace.message}`),
						);
					}
					const settings = yield* attempt(() =>
						resolveProjectBoxSettings(workspace.path, config.box.defaults),
					);
					lease = yield* boxes.acquire({
						sessionId,
						ownerId,
						projectCwd: workspace.path,
						settings,
						signal: abort.signal,
					});
				}
				cwd = lease.workspace;
			} else {
				const workspace = yield* attempt(() => validateWorkspacePath(storedCwd, config.workspaceRoots));
				if (!workspace.ok) {
					return yield* Effect.fail(
						new Error(`Workspace "${storedCwd}" is not usable: ${workspace.message}`),
					);
				}
				cwd = workspace.path;
			}

			const execute = Effect.gen(function* () {
				// Expand @mentions against the session workspace, persist the stripped version
				const expanded = yield* attempt(() => expandMentions(content, cwd));
				yield* handle.append({ type: "message", role: "user", content: stripAttachedContext(expanded) });
				const messages = entriesToMessages(handle.getEntries());

				// The LLM sees the expanded content for the latest user message
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i];
					if (message?.role === "user") {
						messages[i] = { ...message, content: expanded };
						break;
					}
				}

				const workspaceTools = createWorkspaceTools(cwd, lease ? { bash: createBoxBashTool(lease) } : {});
				// Subagents get a fresh loop with read-only workspace tools and no
				// access to this conversation; their cost rolls into the session below.
				const delegate = createDelegateTool({
					provider,
					model: config.model,
					tools: createToolRegistry(workspaceTools.filter((tool) => tool.readonly)),
					maxToolRounds: 10,
					temperature: config.temperature,
					contextLimit: {
						maxTokens: config.maxTokens,
						preserveRecentTurns: config.preserveRecentTurns,
					},
					maxTokens: config.maxCompletionTokens,
					signal: abort.signal,
				});
				const baseTools = [...workspaceTools, delegate];
				// The box is the security boundary: everything inside it runs without
				// approval prompts. Host runs keep the approval layer.
				const tools = createToolRegistry(
					lease
						? [...baseTools, createBoxTool(boxes, lease)]
						: withApproval(baseTools, (tool, input) => requestApproval(tool, input)),
				);
				// Rendered from the registry the run actually exposes, so the tool
				// guidance can never drift from the available tools.
				const systemPrompt = buildSystemPrompt({
					mode: "main",
					tools,
					...(lease
						? {
								box: {
									profile: profileForSettings(lease.status.settings),
									cpus: lease.status.settings.cpus,
									memoryMiB: lease.status.settings.memoryMiB,
									maxProfile: lease.status.settings.maxProfile,
									playwright: isPreparedBoxImage(lease.status.settings.image),
								},
							}
						: {}),
				});

				// The agent loop is a Stream of events; the run fiber consumes it and
				// mirrors each event onto the session draft state + SSE subscribers.
				yield* Stream.runForEach(
					run(messages, {
						provider,
						tools,
						model: config.model,
						systemPrompt,
						temperature: config.temperature,
						contextLimit: {
							maxTokens: config.maxTokens,
							preserveRecentTurns: config.preserveRecentTurns,
						},
						maxTokens: config.maxCompletionTokens,
						signal: abort.signal,
					}),
					handleEvent,
				);

				if (abort.signal.aborted) return "cancelled";
				return Ref.getUnsafe(runRef).hadError ? "error" : "completed";
			});

			return yield* lease ? execute.pipe(Effect.ensuring(lease.release())) : execute;
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

	/** Mirrors one agent event onto the session draft state and SSE subscribers. */
	private handleAgentEvent(
		sessionId: string,
		runRef: Ref.Ref<RunState>,
		abort: AbortController,
		event: AgentEvent,
	): Effect.Effect<void, Error> {
		const getSession = () => this.sessions.get(sessionId);
		const publish = (serverEvent: ServerEvent): void => this.publish(sessionId, serverEvent);
		const updateRun = (f: (state: RunState) => RunState): void => {
			Effect.runSync(Ref.update(runRef, f));
		};
		return Effect.gen(function* () {
			switch (event.type) {
				case "text_delta": {
					updateRun((state) => ({ ...state, draftText: state.draftText + event.content }));
					publish({ type: "text_delta", content: event.content });
					return;
				}
				case "tool_call_start": {
					publish({ type: "tool_call_start", id: event.id, name: event.name });
					return;
				}
				case "tool_call_args_delta": {
					publish({ type: "tool_call_args_delta", id: event.id, args: event.args });
					return;
				}
				case "tool_call_end": {
					updateRun((state) => {
						const draftIndex = new Map(state.draftIndex);
						draftIndex.set(event.id, state.draftToolCalls.length);
						return {
							...state,
							draftToolCalls: [
								...state.draftToolCalls,
								{ id: event.id, name: event.name, args: event.args },
							],
							draftIndex,
						};
					});
					publish({ type: "tool_call_end", id: event.id, name: event.name, args: event.args });
					return;
				}
				case "tool_result": {
					updateRun((state) => {
						const at = state.draftIndex.get(event.id);
						if (at === undefined || at >= state.draftToolCalls.length) return state;
						const draftToolCalls = [...state.draftToolCalls];
						const existing = draftToolCalls[at];
						if (existing) draftToolCalls[at] = { ...existing, result: event.result };
						return { ...state, draftToolCalls };
					});
					publish({ type: "tool_result", id: event.id, result: event.result });
					// Subagent cost rolls into the session total; the next
					// `message_complete` publishes the updated numbers.
					if (event.result.meta?.cost) {
						const session = getSession();
						if (session) {
							session.cost += event.result.meta.cost;
							session.handle?.setCost(session.cost);
						}
					}
					return;
				}
				case "message_complete": {
					const session = getSession();
					if (event.usage && session) {
						// `tokens` is the current context-window usage (this call's
						// prompt + completion), not a running total: clients render it
						// against the model's context limit. `cost` does accumulate.
						session.tokens = event.usage.prompt_tokens + event.usage.completion_tokens;
						if (event.usage.cost) session.cost += event.usage.cost;
						session.handle?.setTokens(session.tokens);
						session.handle?.setCost(session.cost);
					}
					publish({
						type: "message_complete",
						...(event.usage ? { usage: event.usage } : {}),
						tokens: session?.tokens ?? 0,
						cost: session?.cost ?? 0,
					});
					return;
				}
				case "turn_complete": {
					const handle = getSession()?.handle;
					if (handle) {
						yield* handle.append({
							type: "message",
							role: "assistant",
							content: event.assistantMessage.content,
							...(event.assistantMessage.tool_calls?.length && {
								toolCalls: event.assistantMessage.tool_calls,
							}),
						});
						// Draft tool calls carry the full results (including isError and the diff),
						// which the LLM-facing tool messages don't preserve.
						const results = Ref.getUnsafe(runRef).draftToolCalls;
						const resultById = new Map(results.map((tc) => [tc.id, tc.result]));
						for (const tr of event.toolResults) {
							const toolCallId = tr.tool_call_id;
							const toolName = tr.name;
							if (!toolCallId || !toolName) continue;
							const result = resultById.get(toolCallId);
							yield* handle.append({
								type: "tool_result",
								toolCallId,
								toolName,
								content: tr.content ?? "",
								...(result?.isError ? { isError: true } : {}),
								...(result?.meta?.diff ? { diff: result.meta.diff } : {}),
							});
						}
					}
					publish({ type: "turn_complete" });
					return;
				}
				case "error": {
					if (abort.signal.aborted) return;
					updateRun((state) => ({ ...state, hadError: true }));
					publish({ type: "error", message: event.error.message });
					return;
				}
			}
		});
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
				yield* handle.flush().pipe(Effect.catchCause(() => Effect.void));
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
				approvalLock: Semaphore.makeUnsafe(1),
				tokens: 0,
				cost: 0,
				run: null,
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/**
	 * Ask the user for permission to run an unconfined side-effecting tool
	 * (in a workspace run: bash; readonly and `confined` tools never get here).
	 * The wait is a `Deferred` that `resolveApproval` completes and that
	 * {@link finalizeRun} denies if the run ends first; because the wait sits
	 * inside the run fiber, interruption cancels it automatically.
	 *
	 * Prompts are serialized per session: tool sets that gate parallel
	 * side-effects may reach this point together, while the protocol surfaces
	 * one pending approval at a time. Queued calls re-check `alwaysApproved`
	 * and the abort signal, so an "always" decision (or a cancellation) skips
	 * the prompt for everything still waiting behind it.
	 */
	private requestApproval(
		sessionId: string,
		runRef: Ref.Ref<RunState>,
		tool: { definition: { function: { name: string } } },
		input: unknown,
	): Effect.Effect<boolean> {
		const name = tool.definition.function.name;
		const session = this.sessions.get(sessionId);
		if (session?.alwaysApproved.has(name)) return Effect.succeed(true);
		if (session?.run?.abort.signal.aborted) return Effect.succeed(false);

		const publish = (event: ServerEvent): void => this.publish(sessionId, event);
		const request = Effect.gen(function* () {
			// Re-check after acquiring the lock: while this call was queued, an
			// earlier prompt may have been answered "always" — or the run cancelled.
			if (session?.alwaysApproved.has(name)) return true;
			if (session?.run?.abort.signal.aborted) return false;

			const deferred = Deferred.makeUnsafe<ApprovalDecision>();
			const toolCallId = crypto.randomUUID();
			const info: PendingApprovalInfo = {
				toolCallId,
				toolName: name,
				summary: summarizeToolArgs(name, JSON.stringify(input)),
			};

			yield* Ref.update(runRef, (state) => {
				const pendingApprovals = new Map(state.pendingApprovals);
				pendingApprovals.set(toolCallId, { deferred, info });
				return { ...state, pendingApprovals };
			});
			publish({ type: "approval_required", approval: info });

			const decision = yield* Deferred.await(deferred);
			if (decision === "always") session?.alwaysApproved.add(name);
			return decision !== "deny";
		});
		return session ? Semaphore.withPermit(session.approvalLock)(request) : request;
	}
}

/** Thrown when a message is sent to a session that already has an active run. */
export class RunConflictError extends Error {
	constructor(sessionId: string) {
		super(`A run is already active on session ${sessionId}`);
		this.name = "RunConflictError";
	}
}
