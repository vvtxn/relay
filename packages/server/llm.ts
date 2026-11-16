/**
 * Resolution of a user's stored LLM selection into a concrete provider.
 *
 * Presets live in `@vvtxn/relay/core/llm-presets.ts`; this module adds the
 * server-side pieces: config defaults, provider construction, and validation
 * for the one free-form field (a custom base URL).
 */

import { createProvider } from "@vvtxn/relay/api/providers/index.ts";
import type { LLMProvider, ProviderKind } from "@vvtxn/relay/api/types.ts";
import type { UserLlmRecord } from "@vvtxn/relay/core/auth/settings.ts";
import {
	availableLlmPresets,
	CUSTOM_PRESET_ID,
	DEFAULT_PRESET_ID,
	defaultPreset,
	getLlmPreset,
	type LlmDefaults,
	type LlmPreset,
	type LlmSelection,
	type ResolvedLlm,
	resolveLlmSelection,
} from "@vvtxn/relay/core/llm-presets.ts";
import type { ServerConfig } from "./config.ts";
import { isLoopbackHost } from "./config.ts";

/** Server-wide fallbacks for the `default` preset. */
export function llmDefaults(config: ServerConfig): LlmDefaults {
	return {
		provider: config.provider,
		baseURL: config.baseURL,
		model: config.model,
		contextTokens: config.maxTokens,
	};
}

export function resolveSelection(config: ServerConfig, selection: LlmSelection): ResolvedLlm {
	return resolveLlmSelection(selection, llmDefaults(config));
}

/** The provider plus the model/context a run should use. */
export interface RunLlm {
	provider: LLMProvider | null;
	model: string;
	contextTokens: number;
	preset: string;
	label: string;
}

/**
 * Builds the provider for one run. A stored key is only used for the preset it
 * was entered for; switching providers requires entering a new key.
 */
export function createRunLlm(config: ServerConfig, record: UserLlmRecord): RunLlm {
	const resolved = resolveSelection(config, record.settings);
	const keyMatches = record.apiKey !== null && (record.keyPreset ?? DEFAULT_PRESET_ID) === resolved.preset;
	return {
		provider: keyMatches
			? createProvider({
					provider: resolved.provider,
					apiKey: record.apiKey ?? "",
					baseURL: resolved.baseURL,
					headers: resolved.headers,
					...(resolved.sessionHeader ? { sessionHeader: resolved.sessionHeader } : {}),
				})
			: null,
		model: resolved.model,
		contextTokens: resolved.contextTokens,
		preset: resolved.preset,
		label: resolved.label,
	};
}

/** Presets offered by the settings UI, including the server default and custom. */
export function settingsPresets(config: ServerConfig): LlmPreset[] {
	const defaults = llmDefaults(config);
	return [
		defaultPreset(defaults),
		...availableLlmPresets(),
		...(canUseCustomEndpoint(config)
			? [
					{
						id: CUSTOM_PRESET_ID,
						label: "Custom endpoint",
						provider: defaults.provider,
						baseURL: defaults.baseURL,
						auth: "api-key",
						models: [],
						hint: "Any OpenAI-compatible chat-completions or Anthropic Messages endpoint.",
					} satisfies LlmPreset,
				]
			: []),
	];
}

/** Custom endpoints are a local-mode feature unless an admin opts in. */
export function canUseCustomEndpoint(config: ServerConfig): boolean {
	return config.flavor === "local" || config.allowCustomLlm;
}

export interface CustomEndpoint {
	provider: ProviderKind;
	baseURL: string;
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** Returns an error message, or null when the custom endpoint is usable. */
export function validateCustomEndpoint(
	config: ServerConfig,
	provider: ProviderKind | null,
	baseURL: string | null,
	model: string | null,
): string | null {
	if (!canUseCustomEndpoint(config)) return "Custom endpoints are disabled on this server";
	if (provider !== "openai" && provider !== "anthropic") return "Custom endpoint needs provider openai or anthropic";
	if (!baseURL) return "Custom endpoint needs a base URL";
	let url: URL;
	try {
		url = new URL(baseURL);
	} catch {
		return "Base URL must be an absolute URL";
	}
	const loopback = isLoopbackHost(url.hostname);
	// Plain http is a local-development convenience only. A cloud deployment
	// that opts into custom endpoints still requires https.
	const allowHttp = config.flavor === "local" && loopback;
	if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp)) {
		return "Base URL must use https (http is only allowed for local loopback hosts)";
	}
	if (url.username || url.password) return "Base URL must not include credentials";
	if (url.search || url.hash) return "Base URL must not include a query string or fragment";
	if (url.pathname.length > 200) return "Base URL path is too long";
	if (model !== null && !MODEL_PATTERN.test(model)) return "Model id contains unsupported characters";
	return null;
}

/** Validates a model id from any preset. */
export function validateModelId(model: string | null): string | null {
	if (model === null || model.length === 0) return "Model id is required";
	if (model.length > 200) return "Model id is too long";
	if (!MODEL_PATTERN.test(model)) return "Model id contains unsupported characters";
	return null;
}

/** Looks up preset metadata, including the server-default and custom pseudo-presets. */
export function presetInfo(config: ServerConfig, presetId: string): LlmPreset | undefined {
	if (presetId === CUSTOM_PRESET_ID) return settingsPresets(config).find((preset) => preset.id === CUSTOM_PRESET_ID);
	return getLlmPreset(presetId);
}
