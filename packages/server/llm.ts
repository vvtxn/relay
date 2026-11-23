/**
 * Resolution of a user's stored LLM selection into a concrete provider.
 *
 * Presets live in `@vvtxn/relay/core/llm-presets.ts`; this module adds the
 * server-side pieces: config defaults, provider construction, and validation
 * for the one free-form field (a custom base URL).
 */

import { createProvider } from "@vvtxn/relay/api/providers/index.ts";
import type { LLMProvider, ProviderKind } from "@vvtxn/relay/api/types.ts";
import type { LlmCredential } from "@vvtxn/relay/core/auth/settings.ts";
import {
	availableLlmPresets,
	CUSTOM_PRESET_ID,
	DEFAULT_PRESET_ID,
	defaultPreset,
	getLlmPreset,
	type LlmDefaults,
	type LlmModelSelection,
	type LlmPreset,
	type LlmSelection,
	type ResolvedLlm,
	resolveLlmSelection,
	resolveModelSelection,
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
	// Custom selections are validated when they are saved. If custom endpoints
	// are disabled later (or the selection moves to a server that never allowed
	// them), fall back to the server default instead of running the stored URL.
	const effective =
		selection.preset === CUSTOM_PRESET_ID && !canUseCustomEndpoint(config)
			? { ...selection, preset: DEFAULT_PRESET_ID, provider: null, baseURL: null }
			: selection;
	return resolveLlmSelection(effective, llmDefaults(config));
}

/** The provider plus the model/context a run should use. */
export interface RunLlm {
	provider: LLMProvider | null;
	model: string;
	modelLabel: string;
	contextTokens: number;
	preset: string;
	label: string;
}

/** Selection plus the credential that pays for it. */
export interface RunLlmInput {
	selection: LlmSelection;
	credential: LlmCredential | null;
}

/** Resolves a per-thread model override against the server defaults. */
export function resolveOverride(config: ServerConfig, override: LlmModelSelection): ResolvedLlm {
	return resolveModelSelection(override, llmDefaults(config));
}

/**
 * Builds the provider for one run. The credential must belong to the resolved
 * preset; callers fetch it by preset id, so a key is never sent to a different
 * host.
 */
export function createRunLlm(config: ServerConfig, input: RunLlmInput): RunLlm {
	const resolved = resolveSelection(config, input.selection);
	const credential = input.credential;
	return {
		provider: credential
			? createProvider({
					provider: resolved.provider,
					api: resolved.api,
					apiKey: credential.kind === "api-key" ? credential.apiKey : credential.accessToken,
					authStyle: resolved.authStyle,
					baseURL: resolved.baseURL,
					headers: {
						...resolved.headers,
						...(credential.kind === "oauth" && credential.accountId
							? { "chatgpt-account-id": credential.accountId }
							: {}),
					},
					...(resolved.sessionHeader ? { sessionHeader: resolved.sessionHeader } : {}),
				})
			: null,
		model: resolved.model,
		modelLabel: resolved.modelLabel,
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

/**
 * Returns an error message, or null when the custom endpoint is usable. A
 * model id is required — without one a run would silently substitute the
 * server-default model, which a custom endpoint does not serve.
 */
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
	return validateModelId(model);
}

/** Validates a model id from any preset. */
export function validateModelId(model: string | null): string | null {
	if (model === null || model.length === 0) return "Model id is required";
	if (model.length > 200) return "Model id is too long";
	if (!MODEL_PATTERN.test(model)) return "Model id contains unsupported characters";
	return null;
}

/**
 * Validates a model id chosen for a preset. Presets without
 * `allowAnyModel: false` accept any well-formed id; plan-scoped presets only
 * accept ids from their curated list, so a Go key is never aimed at a model the
 * plan does not cover.
 */
export function validatePresetModel(preset: LlmPreset, model: string | null): string | null {
	if (model === null) return null;
	const error = validateModelId(model);
	if (error) return error;
	if (preset.allowAnyModel === false && !preset.models.some((entry) => entry.id === model)) {
		return `Model "${model}" is not part of the ${preset.label} plan. Pick one of the listed models.`;
	}
	return null;
}

/** Looks up preset metadata, including the server-default and custom pseudo-presets. */
export function presetInfo(config: ServerConfig, presetId: string): LlmPreset | undefined {
	if (presetId === CUSTOM_PRESET_ID) return settingsPresets(config).find((preset) => preset.id === CUSTOM_PRESET_ID);
	return getLlmPreset(presetId);
}
