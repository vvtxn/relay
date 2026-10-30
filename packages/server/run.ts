import { Cause, Effect, Exit, Fiber, Queue, Ref, Stream } from "effect";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { BoxManager, BoxSettings } from "@vvtxn/box/types.ts";
import type { WorkspaceManager } from "@vvtxn/box/workspaces.ts";
import { DisabledBoxManager } from "@vvtxn/box/manager.ts";
import { resolveProjectBoxSettings } from "@vvtxn/box/config.ts";
import { isPreparedBoxImage } from "@vvtxn/box/images.ts";
import { createWorkspaceBaseline, hasWorkspaceBaseline } from "@vvtxn/box/sync.ts";
import { clampBoxSettings, profileForSettings } from "@vvtxn/box/profiles.ts";
import { createDelegateTool, createToolRegistry, createWorkspaceTools } from "@vvtxn/relay/core/tools/index.ts";
import { expandMentions, validateWorkspacePath } from "@vvtxn/relay/core/workspace.ts";
import { entriesToMessages, type SessionHandle, stripAttachedContext } from "@vvtxn/relay/core/sessions/index.ts";
import { type AgentEvent, run } from "@vvtxn/relay/core/agent.ts";
import { attempt, causeMessage, type StoreError } from "@vvtxn/relay/core/effect.ts";
import { buildSystemPrompt } from "@vvtxn/relay/core/prompts.ts";
import type { RunPhase, RunStateEvent, RunSummary, ServerEvent } from "@vvtxn/client/protocol.ts";
import type { ServerConfig } from "./config.ts";
import { createBoxBashTool, createBoxTool } from "./box-tools.ts";
import { createBrowserTool } from "./browser-tool.ts";
import { createSandboxProvider, type RunWorkspace, type SandboxProvider } from "./sandbox.ts";

type Subscriber = (event: ServerEvent) => void;
type RunFinishReason = Extract<ServerEvent, { type: "run_finished" }>["reason"];
type DraftToolCall = RunStateEvent["toolCalls"][number];

/**
 * Box work often includes a few environment/setup rounds before the actual
 * edit. The core default stays conservative; server runs get headroom, and the
 * agent loop emits budget warnings near the end.
 */
const SERVER_MAX_TOOL_ROUNDS = 40;

/** Mutable run state, owned by the run's fiber and read by snapshot/handlers. */
interface RunState {
	draftText: string;
	draftToolCalls: DraftToolCall[];
	draftIndex: Map<string, number>;
	hadError: boolean;
	phase: RunPhase;
	boxId: string | null;
	queuePosition: number | null;
}

/** One in-flight run: its fiber, its state, and the abort handle for the loop. */
interface ActiveRun {
	readonly runId: string;
	readonly startedAt: string;
	readonly ref: Ref.Ref<RunState>;
	readonly fiber: Fiber.Fiber<RunFinishReason, never>;
	readonly abort: AbortController;
}

/**
 * Per-session record: the cached handle, token / cost totals, the active run
 * (if any), and the SSE subscriber queues.
 */
interface SessionRecord {
	handle: SessionHandle | null;
	ownerId: string | null;
	readonly subscribers: Set<Queue.Queue<ServerEvent>>;
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
	private readonly workspaces: WorkspaceManager;

	private readonly sessions = new Map<string, SessionRecord>();

	constructor(options: {
		config: ServerConfig;
		providerFor: (ownerId: string) => Effect.Effect<LLMProvider | null, StoreError>;
		boxes?: BoxManager;
		workspaces: WorkspaceManager;
	}) {
		this.config = options.config;
		this.providerFor = options.providerFor;
		this.boxes = options.boxes ?? new DisabledBoxManager();
		this.workspaces = options.workspaces;
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
		return {
			type: "run_state",
			runId: run.runId,
			phase: state.phase,
			draftText: state.draftText,
			toolCalls: [...state.draftToolCalls],
			tokens: session.tokens,
			cost: session.cost,
			...(state.boxId ? { boxId: state.boxId } : {}),
			...(state.queuePosition !== null ? { queuePosition: state.queuePosition } : {}),
		};
	}

	/** Phase of the active run, or null when the session is idle. */
	getRunPhase(sessionId: string): RunPhase | null {
		const run = this.sessions.get(sessionId)?.run;
		return run ? Ref.getUnsafe(run.ref).phase : null;
	}

	/** Box last leased by the session's run, if any. */
	getActiveBoxId(sessionId: string): string | null {
		const run = this.sessions.get(sessionId)?.run;
		return run ? Ref.getUnsafe(run.ref).boxId : null;
	}

	/** Owner-scoped snapshots of every active run. */
	listActive(ownerId?: string): RunSummary[] {
		const runs: RunSummary[] = [];
		for (const [sessionId, session] of this.sessions) {
			const run = session.run;
			if (!run) continue;
			if (ownerId !== undefined && session.ownerId !== ownerId) continue;
			const state = Ref.getUnsafe(run.ref);
			runs.push({
				runId: run.runId,
				sessionId,
				cwd: session.handle?.getHeader().cwd ?? "",
				phase: state.phase,
				startedAt: run.startedAt,
				...(state.boxId ? { boxId: state.boxId } : {}),
				...(state.queuePosition !== null ? { queuePosition: state.queuePosition } : {}),
			});
		}
		return runs;
	}

	/** Update the run phase and notify every subscriber. */
	private setPhase(
		sessionId: string,
		runRef: Ref.Ref<RunState>,
		phase: RunPhase,
		extra: { boxId?: string | null; queuePosition?: number | null } = {},
	): void {
		Effect.runSync(
			Ref.update(runRef, (state) => ({
				...state,
				phase,
				boxId:
					extra.boxId !== undefined
						? extra.boxId
						: phase === "queued" || phase === "starting-box"
							? null
							: state.boxId,
				queuePosition:
					extra.queuePosition !== undefined
						? extra.queuePosition
						: phase === "queued"
							? state.queuePosition
							: null,
			})),
		);
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (!run) return;
		const state = Ref.getUnsafe(runRef);
		this.publish(sessionId, {
			type: "run_status",
			runId: run.runId,
			phase,
			...(state.boxId ? { boxId: state.boxId } : {}),
			...(state.queuePosition !== null ? { queuePosition: state.queuePosition } : {}),
		});
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
			// A session with a live viewer belongs to another client; handing it
			// to a new CLI would silently make both terminals share a blank thread.
			if (session.subscribers.size > 0) continue;
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
			hadError: false,
			phase: "preparing-workspace",
			boxId: null,
			queuePosition: null,
		});
		const abort = new AbortController();
		const runId = crypto.randomUUID();
		const startedAt = new Date().toISOString();
		// The slot is claimed synchronously (above); the run itself executes on
		// its own fiber.
		const fiber = Effect.runFork(this.runProgram(sessionId, content, runId, ref, abort));
		session.run = { runId, startedAt, ref, fiber, abort };
		this.publish(sessionId, { type: "run_status", runId, phase: "preparing-workspace" });
	}

	private runProgram(
		sessionId: string,
		content: string,
		runId: string,
		runRef: Ref.Ref<RunState>,
		abort: AbortController,
	): Effect.Effect<RunFinishReason, never> {
		const config = this.config;
		const providerFor = this.providerFor;
		const boxes = this.boxes;
		const workspaces = this.workspaces;
		const getSession = () => this.sessions.get(sessionId);
		const publish = (event: ServerEvent): void => this.publish(sessionId, event);
		const setPhase = (phase: RunPhase, extra?: { boxId?: string | null; queuePosition?: number | null }): void =>
			this.setPhase(sessionId, runRef, phase, extra);
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
			// With boxes enabled, the session workspace is durable; the project
			// path is only needed to create the first clone.
			const storedCwd = handle.getHeader().cwd;
			const ownerId = session.ownerId ?? "";
			let cwd: string;
			let boxSettings: BoxSettings | null = null;
			let boxImage: string | null = null;
			let sandbox: SandboxProvider | null = null;

			if (boxes.enabled) {
				const existing = yield* boxes.findBySession(sessionId);
				const legacy = existing?.legacy ? existing : null;
				if (legacy) {
					// Compatibility path: v2 boxes own their workspace clone and
					// stay session-affine until they are retired.
					const legacyImage =
						legacy.settings.image === "auto" ? yield* boxes.resolveImage() : legacy.settings.image;
					const legacySettings = { ...legacy.settings, image: legacyImage };
					boxSettings = legacySettings;
					boxImage = legacyImage;
					// Backfill before the provider snapshots sync availability; a
					// file-only run never leases the box, so waiting for `acquire`
					// would leave it unable to sync its changes.
					if (!hasWorkspaceBaseline(legacy.workspace)) {
						const created = yield* attempt(() => createWorkspaceBaseline(legacy.workspace)).pipe(
							Effect.catchCause((cause) =>
								Effect.sync(() => {
									console.warn(
										`relay box: could not initialize the legacy sync baseline: ${causeMessage(cause)}`,
									);
									return false;
								}),
							),
						);
						if (created) {
							console.warn(
								`relay box: initialized a sync baseline for legacy box ${legacy.boxId}; ` +
									"earlier changes remain in the box workspace",
							);
						}
					}
					const legacyWorkspace: RunWorkspace = {
						hostPath: legacy.workspace,
						execPath: "/workspace",
						projectCwd: legacy.projectCwd,
						sync: () =>
							workspaces.syncCheckout({
								projectCwd: legacy.projectCwd,
								hostPath: legacy.workspace,
							}),
					};
					sandbox = createSandboxProvider({
						boxes,
						settings: legacySettings,
						runId,
						sessionId,
						ownerId,
						projectCwd: legacy.projectCwd,
						workspace: legacyWorkspace,
						signal: abort.signal,
						onPhase: setPhase,
					});
					cwd = legacy.workspace;
				} else {
					const project = yield* attempt(() => validateWorkspacePath(storedCwd, config.workspaceRoots));
					if (!project.ok) {
						return yield* Effect.fail(
							new Error(`Workspace "${storedCwd}" is not usable: ${project.message}`),
						);
					}
					const settings = yield* attempt(() => resolveProjectBoxSettings(project.path, config.box.defaults));
					const image = settings.image === "auto" ? yield* boxes.resolveImage() : settings.image;
					const runSettings = clampBoxSettings({ ...settings, image }, config.box.maxProfile);
					boxSettings = runSettings;
					boxImage = image;
					const workspace = yield* workspaces.ensure({
						sessionId,
						ownerId,
						projectCwd: project.path,
						exclude: settings.exclude,
					});
					const runWorkspace: RunWorkspace = {
						hostPath: workspace.hostPath,
						execPath: workspace.execPath,
						projectCwd: workspace.projectCwd,
						sync: () =>
							config.threadBranches ? workspaces.sync(workspace) : workspaces.syncCheckout(workspace),
					};
					sandbox = createSandboxProvider({
						boxes,
						settings: runSettings,
						runId,
						sessionId,
						ownerId,
						projectCwd: project.path,
						workspace: runWorkspace,
						signal: abort.signal,
						onPhase: setPhase,
					});
					cwd = workspace.hostPath;
				}
			} else {
				const workspace = yield* attempt(() => validateWorkspacePath(storedCwd, config.workspaceRoots));
				if (!workspace.ok) {
					return yield* Effect.fail(
						new Error(`Workspace "${storedCwd}" is not usable: ${workspace.message}`),
					);
				}
				cwd = workspace.path;
			}

			setPhase("running");

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

				const workspaceTools = createWorkspaceTools(cwd, sandbox ? { bash: createBoxBashTool(sandbox) } : {});
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
				const sandboxTools =
					sandbox && boxImage
						? [
								createBoxTool(boxes, sandbox),
								...(isPreparedBoxImage(boxImage) ? [createBrowserTool(sandbox)] : []),
							]
						: [];
				// The sandbox is the shell/browser boundary: boxed runs are
				// unrestricted inside it, and host runs are explicitly unsandboxed.
				const tools = createToolRegistry([...baseTools, ...sandboxTools]);
				// Rendered from the registry the run actually exposes, so the tool
				// guidance can never drift from the available tools.
				const systemPrompt = buildSystemPrompt({
					mode: "main",
					tools,
					...(sandbox && boxSettings && boxImage
						? {
								box: {
									profile: profileForSettings(boxSettings),
									cpus: boxSettings.cpus,
									memoryMiB: boxSettings.memoryMiB,
									maxProfile: boxSettings.maxProfile,
									playwright: isPreparedBoxImage(boxImage),
								},
							}
						: { host: true }),
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
						maxToolRounds: SERVER_MAX_TOOL_ROUNDS,
						signal: abort.signal,
					}),
					handleEvent,
				);

				if (abort.signal.aborted) return "cancelled";
				if (Ref.getUnsafe(runRef).hadError) return "error";

				// A successful boxed run lands its changes in the project checkout.
				// The box tool can sync mid-run too; this is the safety net for the
				// agent forgetting to call it. A failed sync is a run error because
				// the user's checkout did not receive the work.
				if (sandbox?.syncAvailable) {
					const synced = yield* sandbox.sync().pipe(
						Effect.map((result) => ({ ok: true as const, result })),
						Effect.catchTag("BoxError", (error) => Effect.succeed({ ok: false as const, error })),
					);
					if (!synced.ok) {
						publish({
							type: "error",
							message: `Could not sync the workspace changes to the project: ${synced.error.message}`,
						});
						return "error";
					}
					if (synced.result.files.length > 0) {
						console.log(
							`relay box: synced ${synced.result.files.length} workspace change(s) from ${sessionId}`,
						);
					}
				} else if (sandbox) {
					console.warn(
						"relay box: the session workspace has no sync baseline; changes stay in the workspace",
					);
				}
				return "completed";
			});

			return yield* execute.pipe(Effect.ensuring(sandbox ? sandbox.release() : Effect.void));
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
					console.warn(`relay run ${sessionId}: ${event.error.message}`);
					publish({ type: "error", message: event.error.message });
					return;
				}
			}
		});
	}

	/**
	 * Run teardown, guaranteed to execute on completion, failure, and
	 * interruption: abort any in-flight provider call, flush the session,
	 * announce `run_finished`, and drop the session if nobody is watching.
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
			if (run && reason === "cancelled") run.abort.abort();
			const handle = session.handle;
			if (handle) {
				yield* handle.flush().pipe(Effect.catchCause(() => Effect.void));
			}
			publish({ type: "run_finished", reason });
			release();
		}).pipe(Effect.uninterruptible);
	}

	/**
	 * Attach an opened session handle so the run can persist to it.
	 *
	 * A live run owns its handle: another client subscribing or opening the
	 * session must not swap it out mid-run or reset the unflushed cost/token
	 * totals. When no run is active, the freshly opened handle becomes the
	 * cache for the next run.
	 */
	attachHandle(sessionId: string, handle: SessionHandle, ownerId: string): void {
		const session = this.ensureSession(sessionId);
		if (session.ownerId !== null && session.ownerId !== ownerId) return;
		if (session.run) {
			session.ownerId = ownerId;
			return;
		}
		if (session.handle === handle) {
			session.ownerId = ownerId;
			return;
		}
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
				tokens: 0,
				cost: 0,
				run: null,
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}
}

/** Thrown when a message is sent to a session that already has an active run. */
export class RunConflictError extends Error {
	constructor(sessionId: string) {
		super(`A run is already active on session ${sessionId}`);
		this.name = "RunConflictError";
	}
}
