import { Effect, Fiber, ManagedRuntime } from "effect";
import { Api, appLayer, type ApiShape, type RelayError, type SessionStream } from "@vvtxn/client/services.ts";
import { client } from "./client.ts";

/** Long-lived runtime; the web app's single Effect environment. */
export const runtime = ManagedRuntime.make(appLayer(client));

/** Run an effect that needs the Relay {@link Api} service. */
export function runApi<A>(f: (api: ApiShape) => Effect.Effect<A, RelayError>): Promise<A> {
	return runtime.runPromise(Effect.flatMap(Api, f));
}

/** Fork an effect onto the runtime, returning its fiber for interruption. */
export function fork<A, E>(effect: Effect.Effect<A, E, Api | SessionStream>): Fiber.Fiber<A, E> {
	return runtime.runFork(effect);
}

/** Interrupt a fiber previously returned by {@link fork}. */
export function interrupt(fiber: Fiber.Fiber<unknown, unknown>): void {
	void runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {});
}
