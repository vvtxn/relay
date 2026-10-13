import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SetApiKeyRequest, SettingsResponse, StatusResponse } from "@vvtxn/client/protocol.ts";
import type { StoreError } from "@vvtxn/relay/core/effect.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, json, readJsonBody } from "./http.ts";

/** Longest accepted API key; real keys are far shorter. */
const MAX_API_KEY_LENGTH = 512;

/** Last 4 characters only — enough to recognize a key without leaking it. */
function hintFor(apiKey: string): string {
	return apiKey.length <= 4 ? "•" : apiKey.slice(-4);
}

/**
 * Per-user settings. The API key is never echoed back; clients receive only
 * whether one is set plus a masked hint.
 */
export function handleGetSettings(
	services: RequestServices,
): Effect.Effect<HttpServerResponse.HttpServerResponse, StoreError> {
	return Effect.gen(function* () {
		const apiKey = yield* services.userSettings.getApiKey(services.user.id);
		return json({
			apiKey: { set: apiKey !== null, hint: apiKey !== null ? hintFor(apiKey) : null },
		} satisfies SettingsResponse);
	});
}

/** Set (with a string) or clear (with null/empty) the caller's LLM API key. */
export function handleSetApiKey(
	services: RequestServices,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const body = yield* readJsonBody<SetApiKeyRequest>(request);
		if (body.apiKey !== null && typeof body.apiKey !== "string") {
			return yield* Effect.fail(new BadRequestError("apiKey must be a string or null"));
		}
		const trimmed = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		if (trimmed.length > MAX_API_KEY_LENGTH) {
			return yield* Effect.fail(new BadRequestError(`API key must be at most ${MAX_API_KEY_LENGTH} characters`));
		}
		yield* services.userSettings.setApiKey(services.user.id, trimmed.length > 0 ? trimmed : null);
		return json({ status: "ok" } satisfies StatusResponse);
	});
}
