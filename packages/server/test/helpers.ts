// TEMP(effect-migration): shared fakes for the phase-0 characterization tests.
// Kept in a dedicated `test/` folder so the suite deletes as one directory —
// see docs/effect-migration.md ("Testing strategy").

import type { CompletionRequest, CompletionResponse, LLMProvider, StreamChunk, Usage } from "@vvtxn/relay/api/types.ts";
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

	async append(entry: NewEntry): Promise<string> {
		const id = crypto.randomUUID();
		this.appended.push({ ...entry, id, timestamp: new Date().toISOString() } as Entry);
		return id;
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

	async flush(): Promise<void> {}
}

export class MemorySessionStore implements SessionStore {
	readonly handles = new Map<string, MemorySessionHandle>();
	private readonly workspaces = new Map<string, Set<string>>();

	create(scope: SessionScope): SessionHandle {
		const id = crypto.randomUUID().slice(0, 8);
		const handle = new MemorySessionHandle(id, scope.cwd);
		this.handles.set(id, handle);
		return handle;
	}

	async continueRecent(_scope: SessionScope): Promise<SessionHandle | null> {
		return null;
	}

	async open(reference: string, _ownerId: string): Promise<SessionHandle> {
		const handle = this.handles.get(reference);
		if (!handle) throw new Error(`Session not found: ${reference}`);
		return handle;
	}

	async listSummaries(_scope: SessionScope): Promise<SessionSummary[]> {
		return [];
	}

	async listWorkspaces(ownerId: string): Promise<WorkspaceSummary[]> {
		return [...(this.workspaces.get(ownerId) ?? [])].map((cwd) => ({
			cwd,
			sessionCount: 0,
			lastActivity: "",
		}));
	}

	async registerWorkspace(scope: SessionScope): Promise<void> {
		let set = this.workspaces.get(scope.ownerId);
		if (!set) {
			set = new Set();
			this.workspaces.set(scope.ownerId, set);
		}
		set.add(scope.cwd);
	}
}

// ---------------------------------------------------------------------------
// Scripted LLM provider
// ---------------------------------------------------------------------------

/** One response for one `stream()` call, in order. */
export type StreamScript = (request: CompletionRequest) => AsyncIterable<StreamChunk>;

export class ScriptedProvider implements LLMProvider {
	readonly requests: CompletionRequest[] = [];
	private readonly scripts: StreamScript[];

	constructor(scripts: StreamScript[]) {
		this.scripts = [...scripts];
	}

	async complete(): Promise<CompletionResponse> {
		throw new Error("ScriptedProvider.complete is not implemented");
	}

	stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
		this.requests.push(request);
		const script = this.scripts.shift();
		if (!script) throw new Error("ScriptedProvider: no script left for this request");
		return script(request);
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
	return () =>
		(async function* () {
			for (const item of items) yield item;
		})();
}

function iterableOf(next: () => Promise<IteratorResult<StreamChunk>>): AsyncIterable<StreamChunk> {
	return { [Symbol.asyncIterator]: () => ({ next }) };
}

export function fail(error: Error): StreamScript {
	return () => iterableOf(() => Promise.reject(error));
}

/** Never yields; used to model a stalled stream. */
export function hang(): StreamScript {
	return () => iterableOf(() => new Promise<IteratorResult<StreamChunk>>(() => {}));
}

/** Yields the given chunks, then hangs until the request is aborted. */
export function chunksThenHangUntilAborted(...items: StreamChunk[]): StreamScript {
	return (request) =>
		(async function* () {
			for (const item of items) yield item;
			if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			await new Promise<never>((_, reject) => {
				request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		})();
}

/** Hangs until the request is aborted (models an interrupted provider fetch). */
export function hangUntilAborted(): StreamScript {
	return (request) =>
		iterableOf(
			() =>
				new Promise<IteratorResult<StreamChunk>>((_, reject) => {
					if (request.signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				}),
		);
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
