/**
 * Provider presets and per-user LLM selection.
 *
 * This module is browser-pure: the web settings page imports it directly, and
 * the server imports the same definitions for validation and resolution.
 *
 * Adding a provider (ChatGPT subscription, Copilot, ...) is a new entry in
 * {@link llmPresets}: the adapter (`provider` + `baseURL`), how it
 * authenticates (`auth`), any static request headers, an optional session
 * header, and an optional live catalog. The settings storage, API, and UI do
 * not need to change. Only `auth: "api-key"` is offered today; OAuth-style
 * presets can be added later without reshaping the stored selection.
 */

import type { ProviderKind } from "#/api/types.ts";

/** Server-default selection id (inherits `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL`). */
export const DEFAULT_PRESET_ID = "default";
/** User-supplied OpenAI-compatible or Anthropic endpoint. */
export const CUSTOM_PRESET_ID = "custom";

/** OpenCode Go gateway (subscription usage; requires a session header). */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
/** OpenCode Console pay-as-you-go gateway. */
export const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/inference/openai/v1";
/** OpenCode's public model catalog (also lists each model's context size). */
export const OPENCODE_CATALOG_URL = "https://opencode.ai/inference/v1/models";

/** One selectable model in a preset's picker. */
export interface LlmModelOption {
	id: string;
	label: string;
	/** Context window in tokens, when known. */
	contextTokens?: number;
}

/** How a preset authenticates. Only `api-key` is implemented; `oauth` is reserved. */
export type LlmAuthKind = "api-key" | "oauth";

/**
 * A provider preset. `provider` selects the wire adapter; everything else is
 * declared here so adding a service is a data change.
 */
export interface LlmPreset {
	id: string;
	label: string;
	/** Wire format spoken by the endpoint. */
	provider: ProviderKind;
	/** Base URL passed to the provider adapter. */
	baseURL: string;
	/** Credential model. Unsupported kinds are filtered out of the settings UI. */
	auth: LlmAuthKind;
	/** Extra static headers sent with every request. */
	headers?: Record<string, string>;
	/** Header that receives a stable conversation id (e.g. `x-opencode-session`). */
	sessionHeader?: string;
	/** Live catalog endpoint, when the provider exposes one. */
	catalog?: { url: string; kind: "opencode" | "openrouter" };
	/** Curated models: the fallback list, and the allowlist for plan-scoped presets. */
	models: readonly LlmModelOption[];
	/** Short explanation shown in Settings. */
	hint?: string;
}

/** A user's persisted, provider-independent selection. */
export interface LlmSelection {
	preset: string;
	/** Only meaningful for `custom`; presets imply their provider. */
	provider: ProviderKind | null;
	/** Only meaningful for `custom`; presets imply their base URL. */
	baseURL: string | null;
	model: string | null;
	/** Context window of the chosen model, learned from the catalog. */
	contextTokens: number | null;
}

/** Server-wide fallbacks, used by the `default` preset. */
export interface LlmDefaults {
	provider: ProviderKind;
	baseURL: string;
	model: string;
	contextTokens: number;
}

/** A selection resolved against presets and server defaults. */
export interface ResolvedLlm {
	preset: string;
	label: string;
	provider: ProviderKind;
	baseURL: string;
	model: string;
	/** Effective trim budget: the smaller of the server cap and the model window. */
	contextTokens: number;
	headers: Record<string, string>;
	sessionHeader: string | null;
}

export const DEFAULT_LLM_SELECTION: LlmSelection = {
	preset: DEFAULT_PRESET_ID,
	provider: null,
	baseURL: null,
	model: null,
	contextTokens: null,
};

/**
 * Paid OpenCode Go models. Free-tier models are deliberately omitted: they are
 * only served inside OpenCode itself and return `403` to other clients.
 */
const OPENCODE_GO_MODELS: readonly LlmModelOption[] = [
	{ id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
	{ id: "glm-5.3", label: "GLM-5.3" },
	{ id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
	{ id: "glm-5.2", label: "GLM-5.2" },
	{ id: "kimi-k3", label: "Kimi K3" },
	{ id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro" },
	{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
	{ id: "minimax-m3", label: "MiniMax M3" },
	{ id: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash" },
	{ id: "qwen3.8-max", label: "Qwen3.8 Max" },
	{ id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
	{ id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
	{ id: "qwen4-max", label: "Qwen4 Max" },
	{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
	{ id: "gpt-6-luna", label: "GPT 6 Luna" },
	{ id: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
	{ id: "gemini-4-argon", label: "Gemini 4 Argon" },
	{ id: "grok-4.7", label: "Grok 4.7" },
	{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
	{ id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash" },
	{ id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro" },
	{ id: "mimo-v2.5", label: "MiMo-V2.5" },
	{ id: "mimo-v2.5-pro", label: "MiMo-V2.5-Pro" },
	{ id: "longcat-2.0", label: "LongCat-2.0" },
	{ id: "step-5-preview", label: "Step 5 Preview" },
	{ id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
	{ id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 Contributor" },
	{ id: "hy4", label: "Hy4" },
	{ id: "hy4-preview", label: "Hy4 preview" },
	{ id: "hy3", label: "Hy3" },
];

/** Curated Console (pay-as-you-go) models; the live catalog refines this list. */
const OPENCODE_CONSOLE_MODELS: readonly LlmModelOption[] = [
	{ id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
	{ id: "glm-5.3", label: "GLM-5.3" },
	{ id: "kimi-k3", label: "Kimi K3" },
	{ id: "minimax-m3", label: "MiniMax M3" },
	{ id: "qwen3.8-max", label: "Qwen3.8 Max" },
	{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
	{ id: "claude-opus-5-5", label: "Claude Opus 5.5" },
	{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
	{ id: "gpt-6.1-sol", label: "GPT 6.1 Sol" },
	{ id: "gemini-4-argon", label: "Gemini 4 Argon" },
	{ id: "grok-4.7", label: "Grok 4.7" },
];

/** Direct Anthropic API models. */
const ANTHROPIC_MODELS: readonly LlmModelOption[] = [
	{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextTokens: 200_000 },
	{ id: "claude-opus-5-5", label: "Claude Opus 5.5", contextTokens: 200_000 },
	{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5", contextTokens: 200_000 },
	{ id: "claude-sonnet-5", label: "Claude Sonnet 5", contextTokens: 200_000 },
	{ id: "claude-opus-5", label: "Claude Opus 5", contextTokens: 200_000 },
	{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextTokens: 200_000 },
];

/**
 * Every provider Relay can talk to out of the box. Keep this list ordered by
 * usefulness: the settings page renders it in order.
 */
export const llmPresets: readonly LlmPreset[] = [
	{
		id: "opencode-go",
		label: "OpenCode Go",
		provider: "openai",
		baseURL: OPENCODE_GO_BASE_URL,
		auth: "api-key",
		sessionHeader: "x-opencode-session",
		catalog: { url: OPENCODE_CATALOG_URL, kind: "opencode" },
		models: OPENCODE_GO_MODELS,
		hint: "Uses your OpenCode Go subscription. Only the models listed in your plan draw from its allowance.",
	},
	{
		id: "opencode",
		label: "OpenCode Console",
		provider: "openai",
		baseURL: OPENCODE_CONSOLE_BASE_URL,
		auth: "api-key",
		sessionHeader: "x-opencode-session",
		catalog: { url: OPENCODE_CATALOG_URL, kind: "opencode" },
		models: OPENCODE_CONSOLE_MODELS,
		hint: "Pay-as-you-go Console balance. Free-tier models are not available outside OpenCode.",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		provider: "openai",
		baseURL: "https://openrouter.ai/api/v1",
		auth: "api-key",
		catalog: { url: "https://openrouter.ai/api/v1/models", kind: "openrouter" },
		models: [{ id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }],
		hint: "Any OpenRouter model; the picker is filled from OpenRouter's public catalog.",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		provider: "anthropic",
		baseURL: "https://api.anthropic.com/v1",
		auth: "api-key",
		models: ANTHROPIC_MODELS,
		hint: "Direct Anthropic API key.",
	},
];

const PRESET_BY_ID = new Map(llmPresets.map((preset) => [preset.id, preset]));

export function getLlmPreset(id: string): LlmPreset | undefined {
	return PRESET_BY_ID.get(id);
}

/** Presets the settings UI may offer (only API-key auth is implemented). */
export function availableLlmPresets(): readonly LlmPreset[] {
	return llmPresets.filter((preset) => preset.auth === "api-key");
}

/** The pseudo-preset representing the server's configured default. */
export function defaultPreset(defaults: LlmDefaults): LlmPreset {
	return {
		id: DEFAULT_PRESET_ID,
		label: "Server default",
		provider: defaults.provider,
		baseURL: defaults.baseURL,
		auth: "api-key",
		models: [{ id: defaults.model, label: defaults.model }],
		hint: `Uses the server's configured ${defaults.provider} endpoint and model.`,
	};
}

/** True for the OpenCode Go gateway, which requires a stable session header. */
export function isOpenCodeGoBaseURL(baseURL: string): boolean {
	try {
		const url = new URL(baseURL);
		return url.hostname === "opencode.ai" && url.pathname.startsWith("/inference/go");
	} catch {
		return false;
	}
}

/** Effective request-session header for a preset/base URL pair. */
export function sessionHeaderFor(preset: LlmPreset | undefined, baseURL: string): string | null {
	if (preset?.sessionHeader) return preset.sessionHeader;
	return isOpenCodeGoBaseURL(baseURL) ? "x-opencode-session" : null;
}

function smallestContext(serverCap: number, modelContext: number | null | undefined): number {
	if (!modelContext || modelContext <= 0) return serverCap;
	return Math.min(serverCap, modelContext);
}

/**
 * Resolves a persisted selection into the concrete provider request settings.
 * Unknown presets fall back to the server default, so a removed preset cannot
 * break an existing account.
 */
export function resolveLlmSelection(selection: LlmSelection, defaults: LlmDefaults): ResolvedLlm {
	const presetId = selection.preset || DEFAULT_PRESET_ID;

	if (presetId === CUSTOM_PRESET_ID) {
		const baseURL = selection.baseURL ?? defaults.baseURL;
		return {
			preset: CUSTOM_PRESET_ID,
			label: "Custom endpoint",
			provider: selection.provider ?? defaults.provider,
			baseURL,
			model: selection.model ?? defaults.model,
			contextTokens: smallestContext(defaults.contextTokens, selection.contextTokens),
			headers: {},
			sessionHeader: sessionHeaderFor(undefined, baseURL),
		};
	}

	const preset = presetId === DEFAULT_PRESET_ID ? undefined : getLlmPreset(presetId);
	if (!preset) {
		return {
			preset: DEFAULT_PRESET_ID,
			label: "Server default",
			provider: defaults.provider,
			baseURL: defaults.baseURL,
			model: defaults.model,
			contextTokens: defaults.contextTokens,
			headers: {},
			sessionHeader: sessionHeaderFor(undefined, defaults.baseURL),
		};
	}

	const curated = selection.model ? preset.models.find((model) => model.id === selection.model) : undefined;
	const model = selection.model ?? preset.models[0]?.id ?? defaults.model;
	return {
		preset: preset.id,
		label: preset.label,
		provider: preset.provider,
		baseURL: preset.baseURL,
		model,
		contextTokens: smallestContext(defaults.contextTokens, selection.contextTokens ?? curated?.contextTokens),
		headers: preset.headers ?? {},
		sessionHeader: sessionHeaderFor(preset, preset.baseURL),
	};
}
