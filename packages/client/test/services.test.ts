// Tests for the shared Effect service layer over RelayClient.

import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RelayApiError, type RelayClient } from "../client.ts";
import type { ServerEvent } from "../protocol.ts";
import { Api, ApiLive, isUnauthorized, RelayError, SessionStream, SessionStreamLive } from "../services.ts";

function fakeClient(methods: Record<string, unknown>): RelayClient {
	return methods as unknown as RelayClient;
}

describe("client service layer", () => {
	it("passes successful REST results through", async () => {
		const client = fakeClient({ health: async () => ({ status: "ok", version: "9.9.9", flavor: "local" }) });
		const health = await Effect.runPromise(
			Effect.gen(function* () {
				const api = yield* Api;
				return yield* api.health();
			}).pipe(Effect.provide(ApiLive(client))),
		);
		expect(health).toEqual({ status: "ok", version: "9.9.9", flavor: "local" });
	});

	it("maps RelayApiError to a tagged RelayError with status", async () => {
		const client = fakeClient({
			me: async () => {
				throw new RelayApiError(401, "Unauthorized");
			},
		});
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const api = yield* Api;
				return yield* Effect.flip(api.me());
			}).pipe(Effect.provide(ApiLive(client))),
		);
		expect(error).toBeInstanceOf(RelayError);
		expect(error.message).toBe("Unauthorized");
		expect(error.status).toBe(401);
		expect(isUnauthorized(error)).toBe(true);
	});

	it("maps transport failures without a status", async () => {
		const client = fakeClient({
			getConfig: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const api = yield* Api;
				return yield* Effect.flip(api.getConfig());
			}).pipe(Effect.provide(ApiLive(client))),
		);
		expect(error).toBeInstanceOf(RelayError);
		expect(error.message).toBe("fetch failed");
		expect(error.status).toBeUndefined();
		expect(isUnauthorized(error)).toBe(false);
	});

	it("streams events from the client subscription", async () => {
		const client = fakeClient({
			subscribe: () =>
				(async function* () {
					yield { type: "text_delta", content: "a" } satisfies ServerEvent;
					yield { type: "run_finished", reason: "completed" } satisfies ServerEvent;
				})(),
		});
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = yield* SessionStream;
				return yield* Stream.runCollect(stream.events("s1", new AbortController().signal));
			}).pipe(Effect.provide(SessionStreamLive.pipe(Layer.provide(ApiLive(client))))),
		);
		expect(Array.from(events).map((event) => event.type)).toEqual(["text_delta", "run_finished"]);
	});
});
