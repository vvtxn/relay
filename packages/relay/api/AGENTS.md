# AGENTS.md - API

LLM provider integrations and API abstractions. Uses OpenAI-compatible `/v1/chat/completions` format.

## Architecture

```
api/
├── index.ts              # Public exports
├── types.ts              # Shared types (Message, CompletionRequest, LLMProvider, etc.)
├── errors.ts             # ProviderError + retryability classification
├── providers/
│   └── completions.ts    # OpenAI-compatible completions provider (works with any compatible API)
├── streaming/
│   └── stream.ts         # SSE stream parser (parseSSEStream)
```

## Key Concepts

### Provider Interface

All LLM providers implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
	complete(request: CompletionRequest): Promise<CompletionResponse>;
	stream(request: CompletionRequest): Stream.Stream<StreamChunk, ProviderError>;
}
```

### Errors (`errors.ts`)

Failures are normalized to a tagged `ProviderError` **where they occur**, and retryability is classified there:
HTTP 429/5xx (`isRetryableStatus`), timeouts, and transport failures are retryable; aborts and unreadable response
bodies are not. The agent loop retries on `ProviderError.retryable` alone — never by matching error messages.
`toProviderError()` normalizes unknown thrown values at the boundaries.

### CompletionsProvider

The single provider implementation (`providers/completions.ts`):

- Works with any OpenAI-compatible API (OpenRouter, open-source models, KimiK2, etc.)
- Configured via `ProviderConfig` (`apiKey`, `baseURL`, `defaultModel`)
- Normalizes base URLs (strips trailing slashes, `/chat/completions` suffix)
- `stream()` returns `Stream<StreamChunk, ProviderError>`: the fetch/SSE parsing stays promise-based behind a single
  `Stream.fromAsyncIterable` bridge, and every failure is classified into a `ProviderError`
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

`parseSSEStream()` parses standard OpenAI SSE format (`data: {json}\n\n`, `data: [DONE]`); it throws a non-retryable
`ProviderError` when the response body is unreadable, and the provider maps iteration/transport failures with
`toProviderError()`.

## Dependencies

- `effect` (v4) — streams and the typed `ProviderError` channel
- No internal dependencies (leaf package)
- External: fetch-based HTTP client (no SDKs)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

If any command fails, fix the issues and re-run until all pass cleanly.

## Code Patterns

- Providers are stateless; configuration passed at construction
- Stream responses as `Stream<StreamChunk, ProviderError>`; classify retryability at the failure source
- Normalize provider-specific errors to common error types
- All types use OpenAI-compatible snake_case naming (`tool_calls`, `tool_call_id`, `finish_reason`)
