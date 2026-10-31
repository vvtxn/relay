import { Data } from "effect";

/** Failure from box provisioning, lifecycle, or command execution. */
export class BoxError extends Data.TaggedError("BoxError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function toBoxError(error: unknown, fallback = "Box operation failed"): BoxError {
	if (error instanceof BoxError) return error;
	const message = error instanceof Error && error.message ? error.message : String(error);
	return new BoxError({ message: message || fallback, cause: error });
}
