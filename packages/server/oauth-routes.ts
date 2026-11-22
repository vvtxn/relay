/**
 * Subscription sign-in routes:
 *
 * - `GET  /api/oauth/:provider/start`    → authorization URL (+ loopback listener for ChatGPT)
 * - `POST /api/oauth/:provider/complete` → exchange a pasted code (Claude)
 * - `DELETE /api/oauth/:provider`        → disconnect the stored credential
 */

import { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import type {
	OAuthCompleteRequest,
	OAuthCompleteResponse,
	OAuthStartResponse,
	SetConnectionRequest,
	SetConnectionResponse,
} from "@vvtxn/client/protocol.ts";
import { getLlmPreset } from "@vvtxn/relay/core/llm-presets.ts";
import type { RequestServices } from "./services.ts";
import { BadRequestError, json, readJsonBody } from "./http.ts";
import {
	beginOAuth,
	exchangeOAuthCode,
	oauthPresetId,
	presetForProvider,
	startChatGptLoopback,
	takePendingOAuth,
	type OAuthProvider,
} from "./oauth.ts";

function parseProvider(raw: string): OAuthProvider | null {
	if (raw === "claude" || raw === "anthropic") return "anthropic";
	if (raw === "chatgpt" || raw === "openai") return "openai";
	return null;
}

function oauthPresetError(provider: OAuthProvider): string | null {
	const preset = getLlmPreset(oauthPresetId(provider));
	if (!preset || preset.auth !== "oauth") return "This subscription is not available on this server";
	return null;
}

export function handleOAuthStart(
	services: RequestServices,
	rawProvider: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const parsed = parseProvider(rawProvider);
		if (!parsed) return yield* Effect.fail(new BadRequestError(`Unknown subscription provider "${rawProvider}"`));
		const provider = parsed;
		const presetError = oauthPresetError(provider);
		if (presetError) return yield* Effect.fail(new BadRequestError(presetError));
		const start = beginOAuth(provider, services.user.id);

		if (provider === "openai") {
			// ChatGPT's registered redirect is a loopback URL. The listener
			// completes the flow in the background; the client polls settings.
			yield* Effect.tryPromise({
				try: () =>
					startChatGptLoopback(
						stateFromUrl(start.url),
						async (code) => {
							const flow = takePendingOAuth(stateFromUrl(start.url));
							if (!flow || flow.userId !== services.user.id) {
								throw new Error("The sign-in attempt expired. Try connecting again.");
							}
							const credential = await exchangeOAuthCode(flow, code);
							await Effect.runPromise(
								services.userSettings.setCredential(
									services.user.id,
									presetForProvider(provider),
									credential,
								),
							);
							await Effect.runPromise(adoptDefaultIfUnset(services));
						},
						(message) => {
							console.error(`relay oauth: ${message}`);
						},
					),
				catch: (cause) => new BadRequestError(`Could not start the local sign-in listener: ${String(cause)}`),
			});
		}

		return json(start satisfies OAuthStartResponse);
	});
}

export function handleOAuthComplete(
	services: RequestServices,
	rawProvider: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const parsed = parseProvider(rawProvider);
		if (!parsed) return yield* Effect.fail(new BadRequestError(`Unknown subscription provider "${rawProvider}"`));
		const provider = parsed;
		const presetError = oauthPresetError(provider);
		if (presetError) return yield* Effect.fail(new BadRequestError(presetError));
		const body = yield* readJsonBody<OAuthCompleteRequest>(request);
		const raw = typeof body.code === "string" ? body.code.trim() : "";
		if (!raw) return yield* Effect.fail(new BadRequestError("A sign-in code is required"));
		const state = raw.includes("#") ? (raw.split("#")[1] ?? "") : "";
		if (!state) return yield* Effect.fail(new BadRequestError("Paste the full code including its `#state` suffix"));
		const flow = takePendingOAuth(state);
		if (!flow) return yield* Effect.fail(new BadRequestError("The sign-in attempt expired. Try again."));
		if (flow.userId !== services.user.id) {
			return yield* Effect.fail(new BadRequestError("This sign-in attempt belongs to another account"));
		}
		if (flow.provider !== provider) {
			return yield* Effect.fail(new BadRequestError("The sign-in code does not match this provider"));
		}
		const credential = yield* Effect.tryPromise({
			try: () => exchangeOAuthCode(flow, raw),
			catch: (cause) => new BadRequestError(cause instanceof Error ? cause.message : String(cause)),
		});
		yield* services.userSettings.setCredential(services.user.id, presetForProvider(provider), credential);
		yield* adoptDefaultIfUnset(services);
		return json({ status: "connected", preset: presetForProvider(provider) } satisfies OAuthCompleteResponse);
	});
}

export function handleOAuthDisconnect(
	services: RequestServices,
	rawProvider: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const provider = parseProvider(rawProvider);
		if (!provider) return yield* Effect.fail(new BadRequestError(`Unknown subscription provider "${rawProvider}"`));
		const preset = presetForProvider(provider);
		yield* services.userSettings.setCredential(services.user.id, preset, null);
		return json({ status: "connected", preset } satisfies OAuthCompleteResponse);
	});
}

/** Stores an API key for one preset without changing the default selection. */
export function handleSetConnection(
	services: RequestServices,
	presetId: string,
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const preset = getLlmPreset(presetId);
		if (!preset) return yield* Effect.fail(new BadRequestError(`Unknown connection "${presetId}"`));
		if (preset.auth !== "api-key") {
			return yield* Effect.fail(new BadRequestError(`${preset.label} uses a sign-in flow, not an API key`));
		}
		const body = yield* readJsonBody<SetConnectionRequest>(request);
		const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		if (!apiKey) return yield* Effect.fail(new BadRequestError("An API key is required"));
		if (apiKey.length > 512) return yield* Effect.fail(new BadRequestError("API key is too long"));
		yield* services.userSettings.setCredential(services.user.id, preset.id, { kind: "api-key", apiKey });
		yield* adoptDefaultIfUnset(services);
		return json({ status: "connected", preset: preset.id } satisfies SetConnectionResponse);
	});
}

/** Removes a preset's stored credential (API key or subscription tokens). */
export function handleRemoveConnection(
	services: RequestServices,
	presetId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, BadRequestError> {
	return Effect.gen(function* () {
		const preset = getLlmPreset(presetId);
		if (!preset) return yield* Effect.fail(new BadRequestError(`Unknown connection "${presetId}"`));
		yield* services.userSettings.setCredential(services.user.id, preset.id, null);
		return json({ status: "connected", preset: preset.id } satisfies SetConnectionResponse);
	});
}

function stateFromUrl(url: string): string {
	try {
		return new URL(url).searchParams.get("state") ?? "";
	} catch {
		return "";
	}
}

/**
 * First-connection convenience: when the selected default has no credential
 * yet, make the newly connected preset (and its first curated model) the
 * default. An existing, already-connected default is never overwritten.
 */
function adoptDefaultIfUnset(services: RequestServices): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const status = yield* services.userSettings.getLlmStatus(services.user.id);
		const current = yield* services.userSettings.getCredential(services.user.id, status.settings.preset);
		if (current) return;
		const connections = yield* services.userSettings.listCredentials(services.user.id);
		const available = connections.find((connection) => getLlmPreset(connection.preset) !== undefined);
		if (!available) return;
		const preset = getLlmPreset(available.preset);
		if (!preset) return;
		const first = preset.models[0];
		yield* services.userSettings.setLlm(services.user.id, {
			preset: preset.id,
			model: first?.id ?? null,
			contextTokens: first?.contextTokens ?? null,
		});
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.warn("relay settings: could not adopt the new connection as default:", cause);
			}),
		),
	);
}
