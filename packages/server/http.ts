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

export async function readJsonBody<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new BadRequestError("Invalid JSON body");
	}
}

export class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadRequestError";
	}
}

export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}
