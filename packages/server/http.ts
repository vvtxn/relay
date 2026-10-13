import { Effect, Option, Stream } from "effect";
import { Headers as HttpHeaders, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ErrorResponse } from "@vvtxn/client/protocol.ts";

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function json(data: unknown, status = 200): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.setStatus(HttpServerResponse.jsonUnsafe(data), status);
}

export function error(status: number, message: string): HttpServerResponse.HttpServerResponse {
	return json({ error: message } satisfies ErrorResponse, status);
}

/**
 * Parses the request URL. The Node adapter can expose relative URLs, so the
 * Host header supplies the origin when needed.
 */
export function requestUrl(request: HttpServerRequest.HttpServerRequest): URL {
	const host = Option.getOrUndefined(HttpHeaders.get(request.headers, "host")) ?? "localhost";
	return new URL(request.url, `http://${host}`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadRequestError";
	}
}

export class UnauthorizedError extends Error {
	constructor(message = "Unauthorized") {
		super(message);
		this.name = "UnauthorizedError";
	}
}

export class PayloadTooLargeError extends Error {
	constructor(message = "Request body too large") {
		super(message);
		this.name = "PayloadTooLargeError";
	}
}

export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

export class ForbiddenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForbiddenError";
	}
}

/** Errors the HTTP layer maps to status codes; anything else is a 500. */
export type HttpError = BadRequestError | UnauthorizedError | PayloadTooLargeError | NotFoundError | ForbiddenError;

/** Maximum accepted JSON request body (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads and parses a JSON request body, aborting as soon as the body exceeds
 * the size limit (declared or actual).
 */
export function readJsonBody<T>(
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<T, BadRequestError | PayloadTooLargeError> {
	return Effect.gen(function* () {
		const declared = Option.getOrUndefined(HttpHeaders.get(request.headers, "content-length"));
		const declaredBytes = Number(declared ?? "");
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
			return yield* Effect.fail(new PayloadTooLargeError());
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		yield* Stream.runForEach(request.stream, (chunk) =>
			Effect.suspend(() => {
				total += chunk.byteLength;
				if (total > MAX_BODY_BYTES) return Effect.fail(new PayloadTooLargeError());
				chunks.push(chunk);
				return Effect.void;
			}),
		);

		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}

		try {
			return JSON.parse(new TextDecoder().decode(merged)) as T;
		} catch {
			return yield* Effect.fail(new BadRequestError("Invalid JSON body"));
		}
	}).pipe(
		// Stream/transport failures read as a bad body; the router's mapper keeps
		// genuine server errors as 500s.
		Effect.catchTag("HttpServerError", () => Effect.fail(new BadRequestError("Invalid JSON body"))),
	);
}
