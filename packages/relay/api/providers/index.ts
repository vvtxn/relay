import type { LLMProvider, ProviderConfig, ProviderKind } from "#/api/types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompletionsProvider } from "./openai.ts";

export interface CreateProviderOptions extends ProviderConfig {
	provider: ProviderKind;
}

/** Builds the provider selected by `LLM_PROVIDER` (or any library caller). */
export function createProvider(options: CreateProviderOptions): LLMProvider {
	if (options.provider === "anthropic") {
		return new AnthropicProvider({ apiKey: options.apiKey, baseURL: options.baseURL });
	}
	return new OpenAICompletionsProvider({ apiKey: options.apiKey, baseURL: options.baseURL });
}

export { AnthropicProvider } from "./anthropic.ts";
export { OpenAICompletionsProvider } from "./openai.ts";
