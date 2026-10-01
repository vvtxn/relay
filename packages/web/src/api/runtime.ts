import { Effect, Fiber, ManagedRuntime } from "effect";
import { Api, type ApiShape, AppLayer, type RelayError, type SessionStream } from "./services.ts";

/** Long-lived runtime; the web app's single Effect environment. */
export const runtime = ManagedRuntime.make(AppLayer);

/** Run an effect that needs the Relay {@link Api} service. */
export function runApi<A>(f: (api: ApiShape) => Effect.Effect<A, RelayError>): Promise<A> {
	return runtime.runPromise(Effect.flatMap(Api, f));
}

/** Fork an effect onto the runtime, returning its fiber for interruption. */
export function fork<A, E>(effect: Effect.Effect<A, E, Api | SessionStream>): Fiber.RuntimeFiber<A, E> {
	return runtime.runFork(effect);
}

/** Interrupt a fiber previously returned by {@link fork}. */
export function interrupt(fiber: Fiber.RuntimeFiber<unknown, unknown>): void {
	void runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {});
}
