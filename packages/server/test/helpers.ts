// Shared fakes for the server suites: in-memory stores and a scripted Stream
// provider.

import { Effect, Stream } from "effect";
import type { CompletionRequest, CompletionResponse, LLMProvider, StreamChunk, Usage } from "@vvtxn/relay/api/types.ts";
import { ProviderError } from "@vvtxn/relay/api/errors.ts";
import type {
	Entry,
	NewEntry,
	SessionHandle,
	SessionHeader,
	SessionScope,
	SessionStore,
	SessionSummary,
	WorkspaceSummary,
} from "@vvtxn/relay/core/sessions/index.ts";
import type { ServerConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function makeConfig(defaultCwd: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		relayEnv: "development",
		port: 0,
		hostname: "127.0.0.1",
		baseURL: "http://127.0.0.1:9",
		model: "fake-model",
		temperature: 0.1,
		maxTokens: 350_000,
		preserveRecentTurns: 6,
		maxCompletionTokens: 1024,
		tursoUrl: "file::memory:",
		tursoToken: "",
		githubClientId: "fake-client-id",
		githubClientSecret: "fake-client-secret",
		publicUrl: "http://127.0.0.1:7433",
		sessionTtlDays: 30,
		defaultCwd,
		workspaceRoots: [],
		allowedGithub: [],
		staticDir: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

export class MemorySessionHandle implements SessionHandle {
	readonly appended: Entry[] = [];
	readonly header: SessionHeader;
	private tokens = 0;
	private cost = 0;

	constructor(id: string, cwd: string) {
		this.header = { type: "session", version: 1, id, timestamp: new Date().toISOString(), cwd };
	}

	append(entry: NewEntry): Effect.Effect<string> {
		return Effect.sync(() => {
			const id = crypto.randomUUID();
			this.appended.push({ ...entry, id, timestamp: new Date().toISOString() } as Entry);
			return id;
		});
	}

	getEntries(): Entry[] {
		return this.appended;
	}

	getHeader(): SessionHeader {
		return this.header;
	}

	getTokens(): number {
		return this.tokens;
	}

	setTokens(tokens: number): void {
		this.tokens = tokens;
		this.header.tokens = tokens;
	}

	getCost(): number {
		return this.cost;
	}

	setCost(cost: number): void {
		this.cost = cost;
		this.header.cost = cost;
	}

	flush(): Effect.Effect<void> {
		return Effect.void;
	}
}

export class MemorySessionStore implements SessionStore {
	readonly handles = new Map<string, MemorySessionHandle>();
	private readonly scopes = new Map<string, SessionScope>();
	private readonly workspaces = new Map<string, Set<string>>();
	private readonly hidden = new Map<string, Set<string>>();

	create(scope: SessionScope): SessionHandle {
		const id = crypto.randomUUID().slice(0, 8);
		const handle = new MemorySessionHandle(id, scope.cwd);
		this.handles.set(id, handle);
		this.scopes.set(id, { ownerId: scope.ownerId, cwd: scope.cwd });
		return handle;
	}

	continueRecent(_scope: SessionScope): Effect.Effect<SessionHandle | null> {
		return Effect.succeed(null);
	}

	open(reference: string, _ownerId: string): Effect.Effect<SessionHandle> {
		return Effect.suspend(() => {
			const handle = this.handles.get(reference);
			if (!handle) return Effect.die(new Error(`Session not found: ${reference}`));
			return Effect.succeed(handle);
		});
	}

	listSummaries(scope: SessionScope): Effect.Effect<SessionSummary[]> {
		return Effect.sync(() =>
			[...this.handles.entries()]
				.filter(([id]) => {
					const stored = this.scopes.get(id);
					return stored?.ownerId === scope.ownerId && stored.cwd === scope.cwd;
				})
				.map(([id, handle]) => {
					const firstUser = handle
						.getEntries()
						.find((entry) => entry.type === "message" && entry.role === "user");
					return {
						id,
						reference: id,
						timestamp: handle.getHeader().timestamp,
						firstUserMessage:
							firstUser && firstUser.type === "message" && typeof firstUser.content === "string"
								? firstUser.content
								: null,
					};
				}),
		);
	}

	listWorkspaces(ownerId: string): Effect.Effect<WorkspaceSummary[]> {
		return Effect.sync(() => {
			const cwds = new Set<string>(this.workspaces.get(ownerId) ?? []);
			for (const scope of this.scopes.values()) {
				if (scope.ownerId === ownerId) cwds.add(scope.cwd);
			}
			return [...cwds]
				.filter((cwd) => !this.hidden.get(ownerId)?.has(cwd))
				.map((cwd) => ({
					cwd,
					sessionCount: [...this.scopes.values()].filter(
						(scope) => scope.ownerId === ownerId && scope.cwd === cwd,
					).length,
					lastActivity: "",
				}));
		});
	}

	registerWorkspace(scope: SessionScope): Effect.Effect<void> {
		return Effect.sync(() => {
			let set = this.workspaces.get(scope.ownerId);
			if (!set) {
				set = new Set();
				this.workspaces.set(scope.ownerId, set);
			}
			set.add(scope.cwd);
			this.hidden.get(scope.ownerId)?.delete(scope.cwd);
		});
	}

	unregisterWorkspace(scope: SessionScope): Effect.Effect<void> {
		return Effect.sync(() => {
			this.workspaces.get(scope.ownerId)?.delete(scope.cwd);
			let set = this.hidden.get(scope.ownerId);
			if (!set) {
				set = new Set();
				this.hidden.set(scope.ownerId, set);
			}
			set.add(scope.cwd);
		});
	}

	isWorkspaceHidden(scope: SessionScope): Effect.Effect<boolean> {
		return Effect.succeed(this.hidden.get(scope.ownerId)?.has(scope.cwd) ?? false);
	}
}

// ---------------------------------------------------------------------------
// Scripted LLM provider
// ---------------------------------------------------------------------------

/** One response for one `stream()` call, in order. */
export type StreamScript = () => Stream.Stream<StreamChunk, ProviderError>;

export class ScriptedProvider implements LLMProvider {
	readonly requests: CompletionRequest[] = [];
	private readonly scripts: StreamScript[];

	constructor(scripts: StreamScript[]) {
		this.scripts = [...scripts];
	}

	async complete(): Promise<CompletionResponse> {
		throw new Error("ScriptedProvider.complete is not implemented");
	}

	stream(request: CompletionRequest): Stream.Stream<StreamChunk, ProviderError> {
		this.requests.push(request);
		const script = this.scripts.shift();
		if (!script) {
			return Stream.fail(new ProviderError({ message: "ScriptedProvider: no script left", retryable: false }));
		}
		return script();
	}
}

// -- chunk builders ---------------------------------------------------------

const CHUNK_BASE = { id: "gen-1", object: "chat.completion.chunk", created: 0, model: "fake-model" } as const;

export function textChunk(content: string): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

export function usageChunk(usage: Usage): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
}

export function doneChunk(): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

export function toolCallChunk(id: string, name: string, args: string): StreamChunk {
	return {
		...CHUNK_BASE,
		choices: [
			{
				index: 0,
				delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
				finish_reason: null,
			},
		],
	};
}

/** One chunk carrying two tool calls in a single assistant message. */
export function twoToolCallsChunk(
	first: { id: string; name: string; args: string },
	second: { id: string; name: string; args: string },
): StreamChunk {
	return {
		...CHUNK_BASE,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{ index: 0, id: first.id, function: { name: first.name, arguments: first.args } },
						{ index: 1, id: second.id, function: { name: second.name, arguments: second.args } },
					],
				},
				finish_reason: null,
			},
		],
	};
}

// -- scripts ----------------------------------------------------------------

export function chunks(...items: StreamChunk[]): StreamScript {
	return () => Stream.fromIterable(items);
}

export function fail(error: ProviderError): StreamScript {
	return () => Stream.fail(error);
}

/** Never yields; used to model a stalled stream. */
export function hang(): StreamScript {
	return () => Stream.never;
}

/** Yields the given chunks, then hangs forever (cancellation stops the run). */
export function chunksThenHangUntilAborted(...items: StreamChunk[]): StreamScript {
	return () => Stream.concat(Stream.fromIterable(items), Stream.never);
}

/** Hangs forever; cancellation (fiber interruption) stops consumption. */
export function hangUntilAborted(): StreamScript {
	return () => Stream.never;
}

// ---------------------------------------------------------------------------
// Async test utilities
// ---------------------------------------------------------------------------

/** Poll until `predicate` is true or the deadline passes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor: condition not met before timeout");
}
