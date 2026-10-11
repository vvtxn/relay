/**
 * Minimal `node:http` → Fetch API adapter.
 *
 * The rest of the server is written against `Request`/`Response` (streaming
 * SSE, request aborts, JSON helpers); this module is the only place that
 * touches Node's HTTP primitives. It replaces `Deno.serve`, including the
 * behaviours the CLI supervisor depends on: streaming responses are flushed
 * incrementally, a client disconnect aborts the request signal, and bind
 * failures surface as `EADDRINUSE` errors.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface ListenOptions {
	port: number;
	hostname: string;
}

export interface RunningServer {
	/** Actual bound port (differs from the requested one only for port 0). */
	port: number;
	close(): Promise<void>;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

function headersFromIncoming(message: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.set(name, value);
		}
	}
	return headers;
}

function requestFromIncoming(message: IncomingMessage, signal: AbortSignal): Request {
	const host = message.headers.host ?? "localhost";
	const url = new URL(message.url ?? "/", `http://${host}`);
	const init: RequestInit = {
		method: message.method ?? "GET",
		headers: headersFromIncoming(message),
		signal,
	};
	if (message.method !== "GET" && message.method !== "HEAD") {
		// Stream the request body; `duplex: "half"` is required by the Fetch standard.
		init.body = Readable.toWeb(message) as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(url, init);
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
	res.statusCode = response.status;
	if (response.statusText) res.statusMessage = response.statusText;

	for (const cookie of response.headers.getSetCookie()) {
		res.appendHeader("set-cookie", cookie);
	}
	response.headers.forEach((value, name) => {
		if (name === "set-cookie") return;
		res.setHeader(name, value);
	});

	if (!response.body) {
		res.end();
		return;
	}

	// Headers first so long-lived streams (SSE) and clients get them before the
	// first body chunk.
	res.flushHeaders();

	const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	await new Promise<void>((resolve, reject) => {
		body.on("error", reject);
		res.on("error", reject);
		res.on("close", () => body.destroy());
		res.on("finish", resolve);
		body.pipe(res);
	});
}

function handleConnection(handler: FetchHandler, message: IncomingMessage, res: ServerResponse): void {
	const controller = new AbortController();
	// A client disconnect (SSE subscriber navigating away) must abort the
	// request so stream producers can clean up.
	res.on("close", () => {
		if (!res.writableFinished) controller.abort();
	});

	let request: Request;
	try {
		request = requestFromIncoming(message, controller.signal);
	} catch {
		res.statusCode = 400;
		res.end("Bad Request");
		return;
	}

	Promise.resolve()
		.then(() => handler(request))
		.then((response) => writeResponse(response, res))
		.catch((error: unknown) => {
			console.error("Unhandled request error:", error);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: "Internal server error" }));
			} else {
				res.destroy();
			}
		});
}

/** Starts the HTTP server and resolves once it is listening. */
export async function startHttpServer(options: ListenOptions, handler: FetchHandler): Promise<RunningServer> {
	const server = createServer((message, res) => handleConnection(handler, message, res));

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ port: options.port, host: options.hostname });
	});

	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// Long-lived SSE connections would otherwise keep the server open.
				server.closeAllConnections();
			});
		},
	};
}
