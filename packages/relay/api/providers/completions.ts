import { parseSSEStream } from "@/api/streaming/stream.ts";
import type { CompletionRequest, CompletionResponse, LLMProvider, ProviderConfig, StreamChunk } from "@/api/types.ts";

export interface GenerationStats {
	totalCost: number | null;
	promptTokens: number | null;
	completionTokens: number | null;
}

const FETCH_TIMEOUT_MS = 90_000; // 90s max for the entire HTTP request (connection + headers)

export class CompletionsProvider implements LLMProvider {
	private readonly apiKey: string;
	private readonly baseURL: string;

	constructor(config: ProviderConfig) {
		this.apiKey = config.apiKey;
		// Normalize: strip trailing slashes and /chat/completions if someone pastes the full endpoint URL
		this.baseURL = config.baseURL
			.replace(/\/+$/, "")
			.replace(/\/chat\/completions$/, "");
	}

	async complete(request: CompletionRequest): Promise<CompletionResponse> {
		const body = this.buildBody(request, false);
		const response = await this.fetch(body);
		return await response.json() as CompletionResponse;
	}

	async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
		const body = this.buildBody(request, true);
		const response = await this.fetch(body, request.signal);
		yield* parseSSEStream(response);
	}

	private buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
		// Normalize messages: ensure content is never null (some providers reject it)
		const messages = request.messages.map((msg) => ({
			...msg,
			content: msg.content ?? "",
		}));

		return {
			model: request.model,
			messages,
			stream,
			...(stream && { stream_options: { include_usage: true } }),
			...(request.tools && { tools: request.tools }),
			...(request.tool_choice && { tool_choice: request.tool_choice }),
			...(request.temperature !== undefined && { temperature: request.temperature }),
			max_tokens: request.max_tokens ?? 16_384,
		};
	}

	/** Fetch generation stats from OpenRouter's generation endpoint. Returns null for non-OpenRouter providers. */
	async getGenerationStats(id: string): Promise<GenerationStats | null> {
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Generation stats request timed out")), FETCH_TIMEOUT_MS);
		});
		try {
			const url = `${this.baseURL}/generation?id=${encodeURIComponent(id)}`;
			const response = await Promise.race([
				fetch(url, { headers: { "Authorization": `Bearer ${this.apiKey}` } }),
				timeout,
			]);
			if (!response.ok) return null;
			const json = await response.json();
			const data = json?.data;
			if (!data) return null;
			return {
				totalCost: typeof data.total_cost === "number" ? data.total_cost : null,
				promptTokens: typeof data.tokens_prompt === "number" ? data.tokens_prompt : null,
				completionTokens: typeof data.tokens_completion === "number" ? data.tokens_completion : null,
			};
		} catch {
			return null;
		} finally {
			clearTimeout(timer!);
		}
	}

	private async fetch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		const url = `${this.baseURL}/chat/completions`;

		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Fetch timeout: no response from API for ${FETCH_TIMEOUT_MS / 1000}s`)),
				FETCH_TIMEOUT_MS,
			);
		});

		try {
			const response = await Promise.race([
				fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(body),
					signal: signal ?? null,
				}),
				timeout,
			]);

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				// Deliberately omits the request URL: it leaks server internals when
				// errors are forwarded to clients (e.g. over HTTP/WebSocket), and the
				// caller already knows the configured baseURL.
				throw new Error(`API error ${response.status}: ${text || response.statusText} (model: ${body.model})`);
			}

			return response;
		} finally {
			clearTimeout(timer!);
		}
	}
}
