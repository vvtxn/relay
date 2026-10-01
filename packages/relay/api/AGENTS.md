# AGENTS.md - API

LLM provider integrations and API abstractions. Uses OpenAI-compatible `/v1/chat/completions` format.

## Architecture

```
api/
├── index.ts              # Public exports
├── types.ts              # Shared types (Message, CompletionRequest, LLMProvider, etc.)
├── providers/
│   └── completions.ts    # OpenAI-compatible completions provider (works with any compatible API)
├── streaming/
│   └── stream.ts         # SSE stream parser (parseSSEStream)
└── tests/
    └── stream.test.ts    # Stream parsing tests
```

## Key Concepts

### Provider Interface

All LLM providers implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
	complete(request: CompletionRequest): Promise<CompletionResponse>;
	stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
}
```

### CompletionsProvider

The single provider implementation (`providers/completions.ts`):

- Works with any OpenAI-compatible API (OpenRouter, open-source models, KimiK2, etc.)
- Configured via `ProviderConfig` (`apiKey`, `baseURL`, `defaultModel`)
- Normalizes base URLs (strips trailing slashes, `/chat/completions` suffix)
- Supports `getGenerationStats()` for OpenRouter cost tracking

### Message Types

Uses OpenAI-compatible snake_case format:

```typescript
interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}
```

### Streaming

`parseSSEStream()` parses standard OpenAI SSE format (`data: {json}\n\n`, `data: [DONE]`).

## Dependencies

- No internal dependencies (leaf package)
- External: fetch-based HTTP client (no SDKs)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task check` — strict type-check of every entrypoint
4. `deno task test` — run the test suite

If any command fails, fix the issues and re-run until all pass cleanly.

## Code Patterns

- Providers are stateless; configuration passed at construction
- Use async iterables for streaming responses
- Normalize provider-specific errors to common error types
- All types use OpenAI-compatible snake_case naming (`tool_calls`, `tool_call_id`, `finish_reason`)
