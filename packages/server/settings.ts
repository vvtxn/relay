import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ProviderKind } from "@vvtxn/relay/api/types.ts";
import { CUSTOM_PRESET_ID, DEFAULT_PRESET_ID } from "@vvtxn/relay/core/llm-presets.ts";
import type { StoreError } from "@vvtxn/relay/core/effect.ts";
import type { UpdateSettingsRequest, SettingsResponse, StatusResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import type { UserLlmStatus } from "@vvtxn/relay/core/auth/settings.ts";
import { BadRequestError, json, readJsonBody } from "./http.ts";
import {
	canUseCustomEndpoint,
	llmDefaults,
	resolveSelection,
	settingsPresets,
	validateCustomEndpoint,
	validateModelId,
} from "./llm.ts";

/** Longest accepted API key; real keys are far shorter. */
const MAX_API_KEY_LENGTH = 512;
/** Sanity bounds for a catalog-reported context window. */
const MIN_CONTEXT_TOKENS = 4_096;
const MAX_CONTEXT_TOKENS = 5_000_000;

/** Per-user settings: selection, key status, and the presets this server offers. */
export function handleGetSettings(
	services: RequestServices,
): Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError> {
	return Effect.gen(function* () {
		const status = yield* services.userSettings.getLlmStatus(services.user.id);
		return json(settingsPayload(services, status));
	});
}

/**
 * Saves the caller's LLM selection and, optionally, the API key for that
 * selection. Fields not present are preserved; changing the preset clears a
 * key that belonged to the previous one.
 */
export function handleUpdateSettings(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError | StoreError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<UpdateSettingsRequest>(request);
		const current = yield* services.userSettings.getLlmStatus(services.user.id);

		const presetId =
			typeof body.preset === "string" && body.preset.length > 0 ? body.preset : current.settings.preset;
		const preset = settingsPresets(services.config).find((entry) => entry.id === presetId);
		if (!preset) return yield* Effect.fail(new BadRequestError(`Unknown preset "${presetId}"`));

		const apiKey = parseApiKey(body.apiKey);
		if (apiKey.error) return yield* Effect.fail(new BadRequestError(apiKey.error));
		const keyPatch = apiKey.value;
		const isCustom = preset.id === CUSTOM_PRESET_ID;
		const isDefault = preset.id === DEFAULT_PRESET_ID;
		const presetChanged = preset.id !== current.settings.preset;

		const provider: ProviderKind | null = isCustom
			? (body.provider ?? (presetChanged ? null : current.settings.provider))
			: null;
		const baseURL: string | null = isCustom
			? (body.baseURL ?? (presetChanged ? null : current.settings.baseURL))
			: null;
		const model: string | null = isDefault ? null : (body.model ?? (presetChanged ? null : current.settings.model));

		if (isCustom) {
			const error = validateCustomEndpoint(services.config, provider, baseURL, model);
			if (error) return yield* Effect.fail(new BadRequestError(error));
		} else if (!isDefault && model !== null) {
			const error = validateModelId(model);
			if (error) return yield* Effect.fail(new BadRequestError(error));
		}

		if (body.contextTokens !== undefined && body.contextTokens !== null) {
			const value = body.contextTokens;
			if (!Number.isInteger(value) || value < MIN_CONTEXT_TOKENS || value > MAX_CONTEXT_TOKENS) {
				return yield* Effect.fail(new BadRequestError("contextTokens is out of range"));
			}
		}
		const contextTokens = isDefault
			? null
			: body.contextTokens !== undefined
				? body.contextTokens
				: presetChanged
					? null
					: current.settings.contextTokens;

		yield* services.userSettings.setLlm(services.user.id, {
			preset: preset.id,
			provider,
			baseURL,
			model,
			contextTokens,
			...(keyPatch !== undefined ? { apiKey: keyPatch } : {}),
		});

		return json({ status: "ok" } satisfies StatusResponse);
	});
}

type ParsedApiKey = { value: string | null | undefined; error?: undefined } | { value?: undefined; error: string };

/** Normalizes the key: missing = preserve, empty/null = clear. */
function parseApiKey(value: UpdateSettingsRequest["apiKey"]): ParsedApiKey {
	if (value === undefined) return { value: undefined };
	if (value === null) return { value: null };
	if (typeof value !== "string") return { error: "apiKey must be a string or null" };
	const trimmed = value.trim();
	if (trimmed.length > MAX_API_KEY_LENGTH) {
		return { error: `API key must be at most ${MAX_API_KEY_LENGTH} characters` };
	}
	return { value: trimmed.length > 0 ? trimmed : null };
}

function settingsPayload(services: RequestServices, status: UserLlmStatus): SettingsResponse {
	const config = services.config;
	const resolved = resolveSelection(config, status.settings);
	return {
		apiKey: {
			set: status.keySet,
			hint: status.keySet ? status.hint : null,
		},
		llm: status.settings,
		defaults: llmDefaults(config),
		// The resolved values make the "what will runs use" preview trivial.
		effective: {
			preset: resolved.preset,
			label: resolved.label,
			provider: resolved.provider,
			model: resolved.model,
			contextTokens: resolved.contextTokens,
		},
		presets: settingsPresets(config).map((preset) => ({
			...preset,
			models: [...preset.models],
		})),
		canCustom: canUseCustomEndpoint(config),
	};
}
