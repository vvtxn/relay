/**
 * Live model catalog for the settings picker.
 *
 * The catalog is advisory: curated lists in `llm-presets.ts` are the fallback
 * (and the allowlist for plan-scoped presets). Live metadata adds names and
 * context sizes, which the trimming budget uses.
 */

import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import { USER_AGENT } from "@vvtxn/relay/api/headers.ts";
import type { LlmModelOption } from "@vvtxn/relay/core/llm-presets.ts";
import type { ModelsResponse } from "@vvtxn/client/protocol.ts";
import { BadRequestError, json, requestUrl } from "./http.ts";
import type { RequestServices } from "./services.ts";
import { presetInfo } from "./llm.ts";

const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

interface CatalogEntry {
	at: number;
	models: LlmModelOption[];
	source: ModelsResponse["source"];
}

const cache = new Map<string, CatalogEntry>();

interface OpenCodeModel {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	limit?: { context?: unknown };
}

interface OpenRouterModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
}

export function handleListModels(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const presetId = requestUrl(request).searchParams.get("preset")?.trim() ?? "";
		if (!presetId) return yield* Effect.fail(new BadRequestError("A preset id is required"));

		const preset = presetInfo(services.config, presetId);
		if (!preset) return yield* Effect.fail(new BadRequestError(`Unknown preset "${presetId}"`));
		const catalog = preset.catalog;
		if (!catalog) {
			return json({
				preset: presetId,
				models: [...preset.models],
				source: "curated",
			} satisfies ModelsResponse);
		}

		const cached = cache.get(preset.id);
		if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
			return json({ preset: presetId, models: cached.models, source: cached.source } satisfies ModelsResponse);
		}

		const live = yield* Effect.tryPromise(() => fetchCatalog(catalog)).pipe(
			Effect.catchCause(() => Effect.succeed(null)),
		);
		const models = mergeCatalog(preset.id, preset.models, live);
		const source: ModelsResponse["source"] = live ? "live" : "curated";
		cache.set(preset.id, { at: Date.now(), models, source });
		return json({ preset: presetId, models, source } satisfies ModelsResponse);
	});
}

async function fetchCatalog(catalog: { url: string; kind: "opencode" | "openrouter" }): Promise<LlmModelOption[]> {
	const response = await fetch(catalog.url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) return [];
	const body = (await response.json()) as { data?: unknown };
	const data = Array.isArray(body.data) ? body.data : [];
	if (catalog.kind === "openrouter") return parseOpenRouter(data as OpenRouterModel[]);
	return parseOpenCode(data as OpenCodeModel[]);
}

function parseOpenCode(data: OpenCodeModel[]): LlmModelOption[] {
	const models: LlmModelOption[] = [];
	for (const model of data) {
		if (typeof model.id !== "string") continue;
		if (model.type !== undefined && model.type !== "chat") continue;
		// Free-tier models are only served inside OpenCode itself.
		if (model.id.endsWith("-free")) continue;
		const context = model.limit?.context;
		models.push({
			id: model.id,
			label: typeof model.name === "string" && model.name ? model.name : model.id,
			...(typeof context === "number" && context > 0 ? { contextTokens: context } : {}),
		});
	}
	return models;
}

function parseOpenRouter(data: OpenRouterModel[]): LlmModelOption[] {
	const models: LlmModelOption[] = [];
	for (const model of data) {
		if (typeof model.id !== "string") continue;
		const context = model.context_length;
		models.push({
			id: model.id,
			label: typeof model.name === "string" && model.name ? model.name : model.id,
			...(typeof context === "number" && context > 0 ? { contextTokens: context } : {}),
		});
	}
	return models;
}

/**
 * Plan-scoped presets keep their curated set (only those models draw from the
 * plan) but take the live name/context for each id. Open catalogs use the live
 * list and fall back to the curated entries when the fetch failed.
 */
function mergeCatalog(
	presetId: string,
	curated: readonly LlmModelOption[],
	live: LlmModelOption[] | null,
): LlmModelOption[] {
	if (!live || live.length === 0) return [...curated];
	if (curated.length === 0) return live;

	const byId = new Map(live.map((model) => [model.id, model]));
	return curated.map((model) => {
		const found = byId.get(model.id);
		if (!found) return model;
		return {
			id: model.id,
			label: found.label && found.label !== model.id ? found.label : model.label,
			...(found.contextTokens ? { contextTokens: found.contextTokens } : {}),
		};
	});
}
