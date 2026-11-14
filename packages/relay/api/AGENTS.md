# AGENTS.md - API

Provider-neutral LLM abstractions with adapters for OpenAI-compatible `/chat/completions` APIs and the Anthropic
Messages API.

## Architecture

```
api/
├── index.ts               # Public exports
├── types.ts               # Neutral contract: Message, ToolCall, Usage, LLMStreamEvent, LLMProvider
├── errors.ts              # ProviderError + retryability classification
├── http.ts                # postJson(): fetch timeout + ProviderError mapping shared by adapters
├── providers/
│   ├── index.ts           # createProvider({ provider, apiKey, baseURL })
│   ├── openai.ts          # OpenAICompletionsProvider (wire format lives here)
│   └── anthropic.ts       # AnthropicProvider (wire format lives here)
└── streaming/
    ├── sse.ts             # Generic event:/data: SSE reader (CRLF, comments, multi-line data)
    ├── openai.ts          # OpenAI chunks -> LLMStreamEvent
    └── anthropic.ts       # Anthropic events -> LLMStreamEvent
```

## Key Concepts

### Neutral provider interface

The core only sees the types in `types.ts`:

```typescript
interface LLMProvider {
	complete(request: CompletionRequest): Promise<CompletionResult>;
	stream(request: CompletionRequest): Stream.Stream<LLMStreamEvent, ProviderError>;
}
```

Messages are provider-neutral camelCase:

```typescript
interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	toolCalls?: ToolCall[]; // { id, name, arguments } with JSON text arguments
	toolCallId?: string;    // tool results
	name?: string;          // tool results
}
```

The stream is a flat sequence:

```typescript
type LLMStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_call_start"; index: number; id: string; name: string }
	| { type: "tool_call_args_delta"; index: number; args: string }
	| { type: "finish"; id: string; reason: FinishReason; usage?: Usage };
```

`Usage` is `{ inputTokens, outputTokens, totalTokens, cost? }`.

Each adapter owns its wire types and translates at the boundary. OpenAI snake_case (`tool_calls`, `tool_call_id`,
`finish_reason`, `max_tokens`) and Anthropic content blocks never leak into the core or persisted sessions.

### Providers

- `OpenAICompletionsProvider` — works with any OpenAI-compatible API (OpenRouter, open-source models, Kimi, etc.).
  Normalizes base URLs (strips `/chat/completions`), maps neutral stop reasons/usage, and keeps `getGenerationStats()`
  for OpenRouter cost lookups.
- `AnthropicProvider` — speaks the Messages API (`/messages`, `x-api-key`, `anthropic-version: 2023-06-01`). Extracts
  system messages to the top-level `system`, maps assistant tool calls to `tool_use`, groups consecutive tool results
  into one `tool_result` user message, synthesizes missing results, and sanitizes tool ids. Anthropic `input_tokens`
  excludes cached tokens, so `inputTokens` sums input + cache read + cache write.
- `createProvider()` picks the adapter for `LLM_PROVIDER` (`openai` or `anthropic`).

### Streaming

`parseSSE()` in `streaming/sse.ts` is wire-format agnostic. The adapters interpret the event names/data:

- OpenAI: `data: {json}` frames ending in `data: [DONE]`; malformed frames are skipped.
- Anthropic: named `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`, `error`, and
  `ping` events. Thinking/signature blocks are ignored for now. A tool block with no `input_json_delta` gets `{}` so
  no-argument tools still produce valid JSON.

### Errors (`errors.ts`)

Failures are normalized to a tagged `ProviderError` **where they occur**, and retryability is classified there:
HTTP 429/5xx (`isRetryableStatus`), timeouts, transport failures, and transient Anthropic stream errors
(`overloaded_error`, `rate_limit_error`, `api_error`) are retryable; aborts, unreadable bodies, and validation errors
are not. The agent loop retries on `ProviderError.retryable` alone — never by matching error messages.
`toProviderError()` normalizes unknown thrown values at the boundaries.

## Dependencies

- `effect` (v4) — streams and the typed `ProviderError` channel
- No internal dependencies (leaf package)
- External: fetch-based HTTP client (no SDKs)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

## Code Patterns

- Providers are stateless; configuration passed at construction
- Keep wire types private to each adapter; the core only uses `types.ts`
- Stream responses as `Stream<LLMStreamEvent, ProviderError>`; classify retryability at the failure source
- Normalize provider-specific errors to `ProviderError`
- New providers implement `LLMProvider`, translate their request/stream, and get registered in `providers/index.ts`
