import type { LLMProvider, ProviderConfig, ProviderKind } from "#/api/types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompletionsProvider } from "./openai.ts";
import { OpenAIResponsesProvider } from "./openai-responses.ts";

export interface CreateProviderOptions extends ProviderConfig {
	provider: ProviderKind;
}

/** Builds the provider selected by `LLM_PROVIDER` (or any library caller). */
export function createProvider(options: CreateProviderOptions): LLMProvider {
	if (options.provider === "anthropic") {
		return new AnthropicProvider(options);
	}
	if (options.api === "responses") {
		return new OpenAIResponsesProvider(options);
	}
	return new OpenAICompletionsProvider(options);
}

export { AnthropicProvider } from "./anthropic.ts";
export { OpenAICompletionsProvider } from "./openai.ts";
export { OpenAIResponsesProvider } from "./openai-responses.ts";
