import { Data } from "effect";

/**
 * Structured provider failure. `retryable` is decided where the failure is
 * classified (HTTP status, timeout, abort, transport) so the agent loop never
 * has to pattern-match error messages.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
	readonly message: string;
	/** HTTP status when the failure came from a response. */
	readonly status?: number;
	readonly retryable: boolean;
	readonly cause?: unknown;
}> {}

/** Retry policy for HTTP failures: 429 and 5xx are transient, other 4xx are not. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/** Normalizes an unknown thrown value into a `ProviderError`. */
export function toProviderError(error: unknown): ProviderError {
	if (error instanceof ProviderError) return error;
	if (error instanceof DOMException && error.name === "AbortError") {
		return new ProviderError({ message: "Request aborted", retryable: false, cause: error });
	}
	const message = error instanceof Error ? error.message : String(error);
	// Transport-level failures (fetch failed, ECONNRESET, …) are transient.
	return new ProviderError({ message, retryable: true, cause: error });
}
