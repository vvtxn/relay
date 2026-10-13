import { Cause, Data, Effect, Option, Result } from "effect";

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

/** Tagged failure from a storage adapter; the underlying error is kept as `cause`. */
export class StoreError extends Data.TaggedError("StoreError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Normalizes an unknown thrown value into a `StoreError`. */
export function toStoreError(error: unknown): StoreError {
	return new StoreError({
		message: error instanceof Error ? error.message : String(error),
		cause: error,
	});
}

/**
 * Wraps a promise-returning store operation as an Effect with the store error
 * channel. Storage adapters keep their promise-based bodies (fs, database
 * clients) and expose this as their public interface.
 */
export function storeEffect<A>(f: () => Promise<A>): Effect.Effect<A, StoreError> {
	return Effect.tryPromise({ try: f, catch: toStoreError });
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
