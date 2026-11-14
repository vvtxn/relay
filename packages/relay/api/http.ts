import { isRetryableStatus, ProviderError, toProviderError } from "./errors.ts";

/** 90s max for the entire HTTP request (connection + headers). */
export const FETCH_TIMEOUT_MS = 90_000;

export interface PostJsonOptions {
	headers: Record<string, string>;
	body: unknown;
	/** Model name used in error messages. */
	model: string;
	signal?: AbortSignal;
}

/**
 * POSTs a JSON body and classifies failures into `ProviderError`.
 *
 * The request URL is deliberately omitted from error messages: it leaks server
 * internals when errors are forwarded to clients, and the caller already knows
 * the configured base URL.
 */
export async function postJson(url: string, options: PostJsonOptions): Promise<Response> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Fetch timeout: no response from API for ${FETCH_TIMEOUT_MS / 1000}s`)),
			FETCH_TIMEOUT_MS,
		);
	});

	try {
		const response = await Promise.race([
			fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...options.headers,
				},
				body: JSON.stringify(options.body),
				signal: options.signal ?? null,
			}),
			timeout,
		]);

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new ProviderError({
				message: `API error ${response.status}: ${extractErrorMessage(text) || response.statusText} (model: ${options.model})`,
				status: response.status,
				retryable: isRetryableStatus(response.status),
			});
		}

		return response;
	} catch (error) {
		throw toProviderError(error);
	} finally {
		clearTimeout(timer!);
	}
}

/** Parses a provider JSON response, normalizing malformed bodies into `ProviderError`. */
export async function parseJson<T>(response: Response): Promise<T> {
	try {
		return (await response.json()) as T;
	} catch (error) {
		throw toProviderError(error);
	}
}

/** Prefer a provider's structured error message over raw JSON/HTML bodies. */
function extractErrorMessage(text: string): string {
	if (!text) return "";
	try {
		const body = JSON.parse(text) as {
			error?: { message?: unknown } | string;
			message?: unknown;
		};
		if (typeof body.error === "string") return body.error;
		if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
			return body.error.message;
		}
		if (typeof body.message === "string") return body.message;
	} catch {
		// Not JSON; fall back to the raw text.
	}
	return text;
}
