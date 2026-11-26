# AGENTS.md - Core

Core agent logic: agent loop, runner, tool execution, context management, sessions, and display utilities.

## Architecture

```
core/
├── index.ts              # Internal barrel re-exports (see packages/relay/mod.ts for public API)
├── agent.ts              # Agent loop (Stream of AgentEvents)
├── runner.ts             # runAgentLoop(): callback adapter over the event stream
├── display.ts            # Display utilities: UIMessage, UIToolCall, parseDiff/diffStats, tool-call summaries
├── diff-view.ts          # prettyDiff(): shared diff rows + theme-token color contract for TUI and web
├── theme.ts              # Graphite/Silver design tokens (incl. per-tool accents) shared by terminal + web clients
├── fonts.ts              # Shared font identity: web faces, CSS stack, terminal install files
├── assets/fonts/         # Bundled font files + license (see its README for the swap procedure)
├── paths.ts              # relayDir(), homeDir() helpers
├── context.ts            # Context trimming (token estimation, turn-based truncation)
├── llm-presets.ts        # Browser-pure provider presets, model lists, auth styles, and selection resolution
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
│   ├── secret.ts         # AES-GCM SecretCipher, master-key parsing/generation, owner-bound AAD
│   └── service.ts        # authenticate(): provider + user store → AuthenticatedUser
├── prompts.ts            # buildSystemPrompt(): compact identity, rules, workspace/safety context
├── system-prompt.ts      # SYSTEM_PROMPT default; re-exports the builder
├── workspace.ts          # Workspace-rooted fs helpers: expandMentions, listProjectFiles, git metadata
├── workspace-token.ts    # URL-safe workspace path tokens shared by the web routes and CLI deep links
├── tools/                # Tool system
│   ├── index.ts          # Tool exports, defaultTools registry, createWorkspaceTools
│   ├── types.ts          # Tool, ToolRegistry, ToolResult, ToolError types; defineTool helper
│   ├── delegate.ts       # createDelegateTool: read-only subagent factory over the agent loop
│   ├── bash.ts           # Shell command execution (createBashTool factory, optional cwd, scrubbed env)
│   ├── read.ts           # File reading (line-range offset/limit)
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
once the retry budget is exhausted — or any other failure surfaces — an `error` event is emitted and the stream completes.
Consumers render errors in-band. Features: a convergence nudge every 8 rounds, repeated-call loop detection, and
empty-response retry. An assistant turn with no text and no tool calls is treated as a retryable provider failure
instead of a blank completion that ends the run. There is no default tool-round cap: a run continues until the model
stops calling tools. Callers may pass `maxToolRounds` to impose an explicit safety cap (the loop then emits system notes
when 10 and 3 rounds remain).

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
- `isPendingToolCall()` / `toolCallStat()` — Pending check and concise per-call result stat (`12 matches in 3 files`,
  `40 lines`, `+4 −2`, `running…`) shared by the CLI and web views
- `abbreviateHome()` / `expandHome()` — Replace a home-directory prefix with `~` for display and back
- `parseDiff()` — Parses unified diffs into files → hunks → lines with line numbers; handles git headers, multiple
  hunks/files, no-newline markers, and header-looking content lines
- `diffStats()` — Added/removed line counts from a diff's hunk bodies (never file headers)
- `prettyDiff()` (in `diff-view.ts`) — Flattens `parseDiff()` into client-agnostic rows (file sections, hunk headers,
  line-number gutter, add/remove/context lines). Compact mode keeps changed lines only; context mode keeps every line;
  multi-file patches get per-file `+N −M` headers. Change prefixes are data, never text — clients never print `+`/`-`.
- `diffRowToken()` / `formatDiffGutter()` — The shared presentation contract: each row maps to a `Theme` token name and
  the gutter formatter, so the TUI (ANSI) and web (`--relay-*` CSS variables) render identical structure and semantics.

### Tool System

Tools are defined using `defineTool()`:

```typescript
interface Tool {
	definition: ToolDefinition;
	readonly?: boolean;
	resourceKey?(input: unknown): string | undefined;
	execute(input: unknown): Effect.Effect<ToolResult, ToolError>;
}
```

`defineTool` keeps authoring promise-based (`execute: (input) => Promise<ToolResult>`) and lifts the body into the
Effect-based interface: an unexpected throw becomes a typed `ToolError`. Built-in tools (`defaultTools`): `bash` (Run),
`read_file` (Read), `write_file` (Write), `edit_file` (Edit), `grep` (Grep). The model-facing mechanics and tool-choice
guidance live in each tool's schema `description`.

`createWorkspaceTools(root)` returns the built-in tools rooted at a workspace directory: file tools resolve their `path`
argument against `root` (escapes are rejected with an error result, and paths whose parent directories do not exist yet
resolve against their deepest existing ancestor), `write_file` creates missing parent directories, and bash runs with
`root` as its cwd and a scrubbed environment (`scrubbedAgentEnv`, no `*_TOKEN`/`*_SECRET`/`RELAY_SECRET_KEY*` — see
`env.ts`), so `env` in a command cannot hand the model server credentials. Note bash is not truly confined — shell
commands can still use absolute paths. Wrapped file tools get a `resourceKey` of their canonical path, so concurrent
calls to the same file are serialized by the agent loop while calls to different files overlap; bash stays exclusive
(no key). `read_file` accepts 1-based `offset` and a line `limit` for large files; a normal range is not marked
truncated, only output that exceeds the 10k character cap.

`createDelegateTool(options)` builds the `delegate` tool: each call runs a fresh, isolated `run()` with the given
(typically read-only) tool registry — no conversation history and the parent abort signal. A subagent has no round cap
unless the caller passes `maxToolRounds`. The subagent's system prompt defaults to
`buildSystemPrompt({ mode: "subagent" })` and can be overridden wholesale via `systemPrompt`. The final report returns
as a `ToolResult`, and subagent cost is aggregated into `meta.cost` so the server can roll it into the session total.
The tool is `readonly`, so calls run in the parallel readonly phase; an internal semaphore caps concurrent subagent
loops (`maxConcurrency`, default 3). The server wires one per run with `read_file` + `grep`.

### System Prompt Composition (`prompts.ts`)

`buildSystemPrompt({ mode, box, host, extraInstructions })` builds a deliberately small prompt:

- `mode: "main"` (default) renders an identity, a few operating rules (hypothesis-driven investigation, stop once
  actionable, batch independent calls, read before editing, use dedicated file tools, stay concise), optional
  workspace context (durable clone + isolated box), and a one-line safety policy.
- `mode: "subagent"` renders a single focused read-only investigator instruction.
- Tool mechanics and tool-choice guidance live in each tool's schema `description`; the prompt does not list tools or
  duplicate their guidance.
- `extraInstructions` is appended verbatim at the end.

`SYSTEM_PROMPT` in `system-prompt.ts` is the shared default: `buildSystemPrompt({ mode: "main" })`. The server builds
the prompt per run with its box/host context.

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
- `FileSessionStore` preserves the JSONL implementation for fallback tooling (also Effect-facing).
- Session headers carry an optional sticky `model` (`{ preset, model, contextTokens? }`) next to tokens/cost, so a
  thread's model switch survives a server restart. A `model_change` transcript entry records each switch; it is skipped
  when converting entries to provider messages and rendered as a system notice by clients.
- Session ownership and workspace are explicit in `SessionScope`.
- `authenticate()` and the auth store interfaces (`UserStore`, `UserDirectory`, `AuthSessionStore`, `UserSettingsStore`)
  follow the same contract; `ready` is an Effect on every store.
- `UserSettingsStore` (auth/settings*.ts) owns the default selection plus **per-preset credentials**: API keys or
  OAuth tokens, encrypted at rest (AES-256-GCM under a master key, owner-bound AAD), local files by default, database
  optional. `getCredential(userId, preset)` is the plaintext path; status reads expose only masked hints/expiry.
  Writes go through a per-user serializer (`createKeyedSerializer`), because both backends rewrite the whole selection
  and credential map on every save (concurrent token refreshes must not lose each other).

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
- There is no per-tool permission wrapper. The box is the execution boundary; host mode (`RELAY_BOX=0`) is
  explicitly unsandboxed, and the agent asks before actions that leave the box via prompt policy
- Keep the system prompt small: identity, a few operating rules, workspace/safety context, and `extraInstructions`.
  Tool mechanics and tool-choice guidance belong in the tool schema `description`.
- There is no default tool-round cap; long-running agents rely on context trimming, the 8-round convergence nudge, and
  loop detection instead of an arbitrary round limit. `maxToolRounds` remains available as an explicit opt-in cap.
- Use `ToolResult` with `isError` flag for error reporting; unexpected throws become `ToolError`
- `ToolResult.meta.diff` carries unified diff output from `write_file` and `edit_file` for UI rendering; the server persists it on `tool_result` entries (`ToolResultEntry.diff`) so reloaded transcripts keep the diff
- `diff.ts` generates unified diffs with a pure Myers algorithm and emits git-style headers (`diff --git` + file name) so UIs can render them with path-aware diff viewers
- `run()` is the primary entry point (a `Stream<AgentEvent>`); `runAgentLoop()` adapts it for callback consumers
- Context trimming uses heuristic token estimation (~4 chars/token)
- Workspace helpers take an explicit root directory — never rely on the process cwd
- Keep `display.ts`/`theme.ts`/`fonts.ts` free of Effect and `node:` imports (browser bundles import them)
