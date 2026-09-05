# AGENTS.md - Core

Core agent logic: agent loop, runner, tool execution, context management, sessions, and display utilities.

## Architecture

```
core/
├── index.ts              # Internal barrel re-exports (see packages/relay/mod.ts for public API)
├── agent.ts              # Agent loop (async generator yielding AgentEvents)
├── runner.ts             # runAgentLoop() convenience wrapper with callbacks
├── display.ts            # Display utilities: UIToolCall, parseDiffLines, tool arg/output formatting
├── paths.ts              # relayDir(), homeDir() helpers
├── context.ts            # Context trimming (token estimation, turn-based truncation)
├── database.ts           # Shared Turso client factory + env credentials (used by session and user stores)
├── system-prompt.ts      # Re-exports the default system prompt (raw .md import)
├── system-prompt.md      # Default system prompt for coding agents (shared across clients)
├── workspace.ts          # Workspace-rooted fs helpers: expandMentions, listProjectFiles, git metadata
├── tools/                # Tool system
│   ├── index.ts          # Tool exports, defaultTools registry, createWorkspaceTools
│   ├── types.ts          # Tool, ToolRegistry, ToolResult types; defineTool helper
│   ├── approval.ts       # withApproval wrapper (gate tool execution on user decision)
│   ├── bash.ts           # Shell command execution (createBashTool factory, optional cwd)
│   ├── read.ts           # File reading
│   ├── write.ts          # File writing
│   ├── edit.ts           # File editing (find-and-replace)
│   ├── diff.ts           # Unified diff generation via git diff
│   └── grep.ts           # Text search (ripgrep-style)
├── sessions/             # Session persistence
│   ├── index.ts          # Public exports
│   ├── manager.ts        # Session CRUD (create, list, load, save, delete)
│   ├── paths.ts          # Session storage paths (~/.relay/sessions/)
│   └── types.ts          # Session types
└── tests/
    ├── agent.test.ts     # Agent loop tests
    ├── approval.test.ts  # Tool approval wrapper tests
    ├── bash.test.ts      # Bash tool tests
    ├── context.test.ts     # Context trimming tests
    ├── edit.test.ts        # Edit tool tests
    ├── read.test.ts        # Read tool tests
    ├── runner.test.ts      # Runner callback tests
    ├── session.test.ts   # Session management tests
    ├── workspace.test.ts   # Workspace helper tests
    ├── workspace-tools.test.ts # Workspace-rooted tool tests
    └── write.test.ts       # Write tool tests
```

## Key Concepts

### Agent Loop (`agent.ts`)

The `run()` async generator:

1. Receive user input as messages
2. Build context (system prompt + history + tools)
3. Stream LLM response via `provider.stream()`
4. Parse response for tool calls
5. Execute tools: read-only tools in parallel, side-effect tools sequentially
6. Yield `AgentEvent`s for the UI to consume
7. Repeat until assistant responds without tool calls

Features: self-reflection every 12 rounds, loop detection (repeated tool calls), automatic retries with exponential
backoff.

### Agent Runner (`runner.ts`)

The `runAgentLoop()` function wraps `run()` with a callback interface, accumulating tool call args across deltas:

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

All callbacks return `void | Promise<void>` and the runner awaits each one, ensuring async work (e.g. session writes)
completes in order.

Optional callbacks `onToolCallStart(id, name)` and `onToolCallArgsDelta(id, args)` stream tool call progress as it
arrives (e.g. for progressive UI indicators); without them, only `onToolCallEnd` fires with the accumulated args.

### AgentEvent Types

```typescript
type AgentEvent =
	| { type: "text_delta"; content: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; args: string }
	| { type: "tool_call_end"; id: string }
	| { type: "tool_result"; id: string; result: ToolResult }
	| { type: "message_complete"; usage?: Usage; generationId?: string }
	| { type: "turn_complete"; assistantMessage: Message; toolResults: Message[] }
	| { type: "error"; error: Error };
```

### Display Utilities (`display.ts`)

Shared across all clients:

- `UIToolCall` — Display-ready tool call with summarized args and formatted output
- `createUIToolCall()` — Creates a UIToolCall from tool name and JSON args
- `summarizeToolArgs()` — Converts JSON args to human-readable summary (path, pattern, command, etc.)
- `getToolDisplayName()` — Maps internal tool names to display labels (e.g. `read_file` → "read")
- `getToolDisplayOutput()` — Formats tool output as concise summaries for display
- `parseDiffLines()` — Parses unified diff into structured `DiffLine[]` (without color assignment)

### Tool System

Tools are defined using `defineTool()`:

```typescript
interface Tool {
	definition: ToolDefinition;
	readonly?: boolean;
	execute(input: unknown): Promise<ToolResult>;
}
```

Built-in tools (`defaultTools`): `bash` (Run), `read_file` (Read), `write_file` (Write), `edit_file` (Edit), `grep`
(Grep)

`createWorkspaceTools(root)` returns the built-in tools rooted at a workspace directory: file tools resolve their `path`
argument against `root` via `resolveWithinRoot` (escapes are rejected with an error result), and bash runs with `root`
as its cwd. Note bash is not truly confined — shell commands can still use absolute paths.

`withApproval(tools, handler)` wraps each tool's `execute` so calls are gated on an approval decision. Readonly tools
skip approval by default (`skipReadonly: false` to change). Denials return an `isError` ToolResult, so the agent loop
needs no changes and the model can react. Handlers waiting on user input should race against the run's AbortSignal.

### Context Management

`trimContext()` in `context.ts` trims messages to fit a token budget:

1. Group messages into turns (system, user, assistant+tool results)
2. If over budget: summarize old tool results (preview first 3 lines)
3. If still over: drop oldest droppable turns (preserving recent turns)

### Session Management

`sessions/` provides storage-neutral conversation contracts and adapters:

- `DatabaseSessionStore` stores shared sessions and ordered messages in the database
- `FileSessionStore` preserves the JSONL implementation for local tests and fallback tooling
- Session ownership and workspace are explicit in `SessionScope`

### Workspace Helpers (`workspace.ts`)

Filesystem helpers rooted at an explicit workspace directory — the CLI passes `Deno.cwd()`, a server passes a
per-session workspace:

- `resolveWithinRoot(root, rel)` — resolves a path, returning null when it escapes the root
- `expandMentions(text, root)` — expands `@path` mentions into `<attached_context>` blocks
- `listProjectFiles(root)` — project file listing (`git ls-files`, directory walk fallback) for file pickers
- `isGitRepo(root)` / `getGitBranch(root)` — repository metadata

## Dependencies

- `@/api` - Internal: LLM provider types and calls (within same `packages/relay` package)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task test` — run the test suite

If any command fails, fix the issues and re-run until all pass cleanly.

## Code Patterns

- Tools use `defineTool()` helper for consistent structure
- Tools have a `readonly` flag for parallel execution optimization
- Use `ToolResult` with `isError` flag for error reporting
- `ToolResult.meta.diff` carries unified diff output from `write_file` and `edit_file` for UI rendering
- `diff.ts` uses `git diff --no-index --no-ext-diff` on temp files to bypass user-configured external diff tools
- Agent loop is an async generator for streaming updates
- `runAgentLoop()` is the recommended entry point for all clients; `run()` for custom event handling
- Context trimming uses heuristic token estimation (~4 chars/token)
- Workspace helpers take an explicit root directory — never rely on the process cwd
- Gate side-effecting tools with `withApproval()`; keep `defaultTools` ungated only where approvals don't apply
