import type { ErrorResponse } from "@vvtxn/client/protocol.ts";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function error(status: number, message: string): Response {
	return json({ error: message } satisfies ErrorResponse, status);
}

/** Maximum accepted JSON request body (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody<T>(request: Request): Promise<T> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new PayloadTooLargeError();
	}

	let text: string;
	try {
		text = await readBodyWithLimit(request, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof PayloadTooLargeError) throw error;
		throw new BadRequestError("Invalid JSON body");
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		throw new BadRequestError("Invalid JSON body");
	}
}

/** Read the body as text, aborting once it exceeds `limit` bytes. */
async function readBodyWithLimit(request: Request, limit: number): Promise<string> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new PayloadTooLargeError();
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

export class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadRequestError";
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
