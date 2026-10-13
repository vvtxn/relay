import { Cause, Effect, Option, Result } from "effect";

/**
 * Wraps a promise as an Effect, normalizing thrown values to `Error`.
 * The bridge for leaf IO (fs, fetch) that stays promise-based internally.
 */
export function attempt<A>(f: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({
		try: f,
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

/** Best-effort human-readable message for a failing cause. */
export function causeMessage(cause: Cause.Cause<unknown>): string {
	const failure = Cause.findErrorOption(cause);
	if (Option.isSome(failure)) {
		return failure.value instanceof Error ? failure.value.message : String(failure.value);
	}
	const defect = Cause.findDefect(cause);
	if (Result.isSuccess(defect)) {
		return defect.success instanceof Error ? defect.success.message : String(defect.success);
	}
	return Cause.pretty(cause);
}
