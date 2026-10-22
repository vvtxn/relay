# AGENTS.md - Core

Core agent logic: agent loop, runner, tool execution, context management, sessions, and display utilities.

## Architecture

```
core/
├── index.ts              # Internal barrel re-exports (see packages/relay/mod.ts for public API)
├── agent.ts              # Agent loop (Stream of AgentEvents)
├── runner.ts             # runAgentLoop(): callback adapter over the event stream
├── display.ts            # Display utilities: UIMessage, UIToolCall, parseDiffLines, tool-call summaries
├── theme.ts              # Graphite/Silver design tokens (incl. per-tool accents) shared by terminal + web clients
├── fonts.ts              # Shared font identity: web faces, CSS stack, terminal install files
├── assets/fonts/         # Bundled font files + license (see its README for the swap procedure)
├── paths.ts              # relayDir(), homeDir() helpers
├── context.ts            # Context trimming (token estimation, turn-based truncation)
├── effect.ts             # Shared Effect helpers: attempt, causeMessage, StoreError, storeEffect
├── env.ts                # scrubbedAgentEnv(): credential-free environment for tool subprocesses
├── database.ts           # Shared libSQL client factory (local file or Turso) used by every store
├── auth/                 # Identity + sessions
│   ├── types.ts          # AuthIdentity, AuthenticatedUser, AuthProvider, UserStore, UserDirectory
│   ├── github.ts         # GitHubAuthProvider (profile → identity)
│   ├── db.ts             # DatabaseUserStore: provider identity → user, profile columns
│   ├── sessions.ts       # DatabaseAuthSessionStore: opaque hashed session tokens
│   ├── settings.ts       # UserSettingsStore contract + DatabaseUserSettingsStore (encrypted keys)
│   ├── settings-file.ts  # FileUserSettingsStore: per-user encrypted files (the default backend)
│   ├── settings-migrate.ts # migrateApiKeysToFile(): one-shot database → file move + purge
│   ├── secret.ts         # AES-GCM SecretCipher, master-key parsing/generation, owner-bound AAD
│   └── service.ts        # authenticate(): provider + user store → AuthenticatedUser
├── prompts.ts            # buildSystemPrompt(): section composition + registry-aware tool guidance
├── system-prompt.ts      # SYSTEM_PROMPT default (built from defaultTools); re-exports the builder
├── workspace.ts          # Workspace-rooted fs helpers: expandMentions, listProjectFiles, git metadata
├── workspace-token.ts    # URL-safe workspace path tokens shared by the web routes and CLI deep links
├── tools/                # Tool system
│   ├── index.ts          # Tool exports, defaultTools registry, createWorkspaceTools
│   ├── types.ts          # Tool, ToolRegistry, ToolResult, ToolError types; defineTool helper
│   ├── approval.ts       # withApproval wrapper (gate tool execution on an Effect decision)
│   ├── delegate.ts       # createDelegateTool: read-only subagent factory over the agent loop
│   ├── bash.ts           # Shell command execution (createBashTool factory, optional cwd, scrubbed env)
│   ├── read.ts           # File reading
│   ├── write.ts          # File writing
│   ├── edit.ts           # File editing (find-and-replace)
│   ├── diff.ts           # Unified diff generation via git diff
│   └── grep.ts           # Text search (ripgrep-style)
└── sessions/             # Session persistence
    ├── index.ts          # Public exports
    ├── manager.ts        # Session CRUD (create, list, load, save, delete)
    ├── paths.ts          # Session storage paths (~/.relay/sessions/)
    └── types.ts          # Session types + Effect-based handle/store contracts
```

## Key Concepts

### Agent Loop (`agent.ts`)

`run(messages, config)` returns a `Stream<AgentEvent>`:

1. Receive user input as messages
2. Build context (system prompt + history + tools)
3. Stream the LLM response via `provider.stream()` (an Effect `Stream`)
4. Parse response for tool calls
5. Execute tools: read-only tools in parallel (unbounded); side-effect tools with dependency-aware concurrency — calls
   sharing a resource (same file) are serialized, an exclusive tool (e.g. bash) waits for all earlier calls and blocks
   all later ones, and independent calls overlap
6. Emit `AgentEvent`s for the UI to consume
7. Repeat until the assistant responds without tool calls

The stream never fails: provider errors are retried (`Effect.retry` with `Schedule.exponential`, 1s/2s, gated on
`ProviderError.retryable`), a stalled stream fails after 60s of silence (`Stream.timeoutOrElse`, also retryable), and
once the budget is exhausted — or any other failure surfaces — an `error` event is emitted and the stream completes.
Consumers render errors in-band. Features: self-reflection every 12 rounds and repeated-call loop detection.

### Agent Runner (`runner.ts`)

`runAgentLoop()` is a compatibility adapter for callback-based consumers, implemented over the `run()` stream: it
awaits each callback so async work (e.g. session writes) completes in order, and reports a throwing callback through
`onError` instead of breaking the loop. Effect-native consumers should use `run()` directly (see
`packages/server/run.ts`).

```typescript
await runAgentLoop(messages, config, {
    onTextDelta(delta) { ... },
    onToolCallEnd(id, name, args) { ... },
    onToolResult(id, result) { ... },
    onMessageComplete(usage, generationId) { ... },
    onTurnComplete(assistantMessage, toolResults) { ... },
    onError(error) { ... },
});
```

### AgentEvent Types

```typescript
type AgentEvent =
	| { type: "text_delta"; content: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; args: string }
	| { type: "tool_call_end"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; result: ToolResult }
	| { type: "message_complete"; usage?: Usage; generationId?: string }
	| { type: "turn_complete"; assistantMessage: Message; toolResults: Message[] }
	| { type: "error"; error: Error };
```

### Display Utilities (`display.ts`)

Shared across all clients (TUI, web). Deliberately dependency-free so browser bundles can import it — this file (like
`theme.ts` and `fonts.ts`) must never gain an Effect or `node:` dependency:

- `UIToolCall` — Display-ready tool call with summarized args, formatted output, optional `diff`, and `isError` flag
- `UIMessage` — Client-agnostic chat message (`user` or `agent` with tool calls)
- `entriesToUIMessages()` — Converts session entries into UIMessages, folding tool results into their calls
- `stripAttachedContext()` — Removes `@mention` attached-context blocks from user content
- `createUIToolCall()` — Creates a UIToolCall from tool name and JSON args
- `summarizeToolArgs()` — Converts JSON args to human-readable summary (path, pattern, command, etc.)
- `getToolDisplayName()` — Maps internal tool names to display labels (e.g. `read_file` → "read")
- `getToolDisplayOutput()` — Formats tool output as concise summaries for display
- `groupToolCalls()` — Collapses a turn's tool calls into one row per tool (first-seen order): compact targets
  (`app.tsx, chat.tsx +2 more`, capped by count and length), an aggregated stat (`12 matches in 3 files`, `+4 −2`,
  `running…` while results are pending), an error count, and the underlying `calls` for per-call detail rendering
- `abbreviateHome()` / `expandHome()` — Replace a home-directory prefix with `~` for display and back
- `parseDiff()` — Parses unified diffs into files → hunks → lines with line numbers; handles git headers, multiple
  hunks/files, no-newline markers, and header-looking content lines
- `diffStats()` — Added/removed line counts from a diff's hunk bodies (never file headers)
- `parseDiffLines()` — Flat `DiffLine[]` view of `parseDiff()`, kept for the web's plain-line diff fallback

### Tool System

Tools are defined using `defineTool()`:

```typescript
interface Tool {
	definition: ToolDefinition;
	readonly?: boolean;
	confined?: boolean;
	usageHint?: string;
	resourceKey?(input: unknown): string | undefined;
	execute(input: unknown): Effect.Effect<ToolResult, ToolError>;
}
```

`defineTool` keeps authoring promise-based (`execute: (input) => Promise<ToolResult>`) and lifts the body into the
Effect-based interface: an unexpected throw becomes a typed `ToolError`. Built-in tools (`defaultTools`): `bash` (Run),
`read_file` (Read), `write_file` (Write), `edit_file` (Edit), `grep` (Grep). Each tool carries an optional `usageHint`
— the prompt-level policy for that tool (see "System Prompt Composition"); the schema `description` stays the
model-facing mechanics.

`createWorkspaceTools(root)` returns the built-in tools rooted at a workspace directory: file tools resolve their `path`
argument against `root` (escapes are rejected with an error result, and paths whose parent directories do not exist yet
resolve against their deepest existing ancestor), `write_file` creates missing parent directories, and bash runs with
`root` as its cwd and a scrubbed environment (`scrubbedAgentEnv`, no `*_TOKEN`/`*_SECRET`/`RELAY_SECRET_KEY*` — see
`env.ts`), so `env` in a command cannot hand the model server credentials. Note bash is not truly confined — shell
commands can still use absolute paths. Wrapped file tools
are marked `confined` (approval layers treat them as sandboxed) and get a `resourceKey` of their canonical path, so
concurrent calls to the same file are serialized by the agent loop while calls to different files overlap; bash stays
exclusive (no key) and unconfined.

`createDelegateTool(options)` builds the `delegate` tool: each call runs a fresh, isolated `run()` with the given
(typically read-only) tool registry — no conversation history, its own round cap, and the parent abort signal. The
subagent's system prompt defaults to `buildSystemPrompt({ mode: "subagent", tools })` and can be overridden wholesale
via `systemPrompt`. The final report returns as a `ToolResult`, and subagent cost is aggregated into `meta.cost` so
the server can roll it into the session total. The tool is `readonly`, so calls skip approval and run in the parallel
readonly phase; an internal semaphore caps concurrent subagent loops (`maxConcurrency`, default 3). The server wires
one per run with `read_file` + `grep`.

`withApproval(tools, handler)` wraps each tool's `execute` so calls are gated on an `Effect<boolean>` decision.
Readonly and workspace-`confined` tools skip approval by default (`skipReadonly` / `skipConfined` to change), so a
workspace run only prompts for unconfined side-effecting tools (bash). Denials return an `isError` ToolResult, so
the agent loop needs no changes and the model can react. Handlers waiting on user input should await a `Deferred` (see
`packages/server/run.ts`) so cancelling the run interrupts the wait.

### System Prompt Composition (`prompts.ts`)

`buildSystemPrompt({ mode, tools, extraInstructions })` composes the prompt from named sections:

- `mode: "main"` (default) renders identity, agency, tool usage, workflow, code quality, self-review, and
  communication; `mode: "subagent"` renders a focused read-only investigator prompt (identity, parallel-lookup policy,
  tool usage, report requirements).
- The Tool Usage section is rendered from `tools` (a `ToolRegistry` or `Tool[]`): each tool contributes a bullet from
  its `usageHint`, falling back to the first sentence of its schema description. The Agency section names the read-only
  tools from the same source, and Self-Review only mentions `read_file` when it is present — the prompt can never drift
  from the exposed tool set, and custom tools are covered automatically.
- `extraInstructions` is appended verbatim at the end.

`SYSTEM_PROMPT` in `system-prompt.ts` is the shared default:
`buildSystemPrompt({ mode: "main", tools: defaultTools })`. The server builds its prompt per run from the registry it
actually wires (workspace tools + `delegate`), and `createDelegateTool` defaults to the subagent mode for its registry.

### Context Management

`trimContext()` in `context.ts` trims messages to fit a token budget:

1. Group messages into turns (system, user, assistant+tool results)
2. If over budget: summarize old tool results (preview first 3 lines)
3. If still over: drop oldest droppable turns (preserving recent turns)

### Session Management

`sessions/` provides Effect-native storage contracts and adapters:

- `DatabaseSessionStore` stores shared sessions and ordered messages in the database; `SessionHandle` operations
  (`append`, `flush`) are Effects that fail with `StoreError`, while synchronous in-memory reads stay synchronous.
  Each owner/workspace is capped at `maxSessionsPerWorkspace` (`0` = unlimited; local default). With a finite limit,
  persisting a user message atomically deletes older sessions and their entries, and `pruneAll()` trims pre-existing
  overflow at startup.
- `FileSessionStore` preserves the JSONL implementation for fallback tooling (also Effect-facing)
- Session ownership and workspace are explicit in `SessionScope`
- `authenticate()` and the auth store interfaces (`UserStore`, `UserDirectory`, `AuthSessionStore`, `UserSettingsStore`)
  follow the same contract; `ready` is an Effect on every store
- `UserSettingsStore` (auth/settings*.ts) is the one place the LLM API key lives: encrypted at rest (AES-256-GCM under a
  master key, owner-bound AAD), local files by default, database optional, with `getApiKey` the only plaintext path

### Workspace Helpers (`workspace.ts`)

Filesystem helpers rooted at an explicit workspace directory — the CLI passes `process.cwd()`, a server passes a
per-session workspace:

- `resolveWithinRoot(root, rel)` — resolves a path lexically, returning null when it escapes the root
- `resolveRealWithinRoot(root, rel)` — the symlink-safe variant used by file tools: existing components resolve through
  `realpath`, missing suffixes resolve against the deepest existing ancestor (so a new file in a new nested directory
  is allowed), and escaping or dangling symlinks are rejected
- `validateWorkspacePath(raw, roots)` / `validateWorkspacePathSync(...)` — canonicalize (symlinks resolved) and validate
  a candidate workspace directory: absolute, existing directory, and within `roots` (empty roots = allow anywhere)
- `expandMentions(text, root)` — expands `@path` mentions into `<attached_context>` blocks
- `listProjectFiles(root)` — project file listing (`git ls-files`, directory walk fallback) for file pickers
- `isGitRepo(root)` / `getGitBranch(root)` — repository metadata

These remain promise-based IO helpers (wrapped with `attempt` at Effect call sites); they are not store contracts.

## Dependencies

- `effect` (v4) — the agent runtime (streams, retries, tool execution, store contracts)
- `@libsql/client` — one libSQL client for both embedded local files and remote Turso databases

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

## Code Patterns

- Tools use `defineTool()` helper for consistent structure (async bodies, Effect interface)
- Tools have a `readonly` flag for parallel execution optimization, and an optional `resourceKey` so the agent loop can
  serialize side-effect calls that touch the same resource while running independent ones concurrently (`confinePathArg`
  attaches the resolved file path for the workspace file tools; tools without a key are exclusive)
- Sandboxed tools are marked `confined` (set by the workspace wrappers); `withApproval` skips them, so the sandbox — not
  the prompt — is the boundary and only unconfined tools (bash) ask for permission
- Prompt guidance for a tool lives on the tool (`usageHint`) and is rendered by `buildSystemPrompt`; never hardcode
  tool names or availability in prompt prose
- Use `ToolResult` with `isError` flag for error reporting; unexpected throws become `ToolError`
- `ToolResult.meta.diff` carries unified diff output from `write_file` and `edit_file` for UI rendering; the server persists it on `tool_result` entries (`ToolResultEntry.diff`) so reloaded transcripts keep the diff
- `diff.ts` generates unified diffs with a pure Myers algorithm and emits git-style headers (`diff --git` + file name) so UIs can render them with path-aware diff viewers
- `run()` is the primary entry point (a `Stream<AgentEvent>`); `runAgentLoop()` adapts it for callback consumers
- Context trimming uses heuristic token estimation (~4 chars/token)
- Workspace helpers take an explicit root directory — never rely on the process cwd
- Gate side-effecting tools with `withApproval()`; keep `defaultTools` ungated only where approvals don't apply
- Keep `display.ts`/`theme.ts`/`fonts.ts` free of Effect and `node:` imports (browser bundles import them)
