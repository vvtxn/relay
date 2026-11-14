import { ProviderError } from "../errors.ts";

/** One dispatched server-sent event (`event:` name plus joined `data:` lines). */
export interface SSEEvent {
	event: string | null;
	data: string;
}

/**
 * Parses a server-sent-event response body into dispatched events.
 *
 * Handles multi-line `data:` fields, comments/heartbeats, CRLF, and events
 * split across chunks. Provider adapters interpret the event names and data;
 * this module is wire-format agnostic.
 */
export async function* parseSSE(response: Response): AsyncIterable<SSEEvent> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ProviderError({ message: "Response body is not readable", retryable: false });
	}

	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | null = null;
	let dataLines: string[] = [];

	const takeEvent = (): SSEEvent | null => {
		if (eventName === null && dataLines.length === 0) return null;
		const event: SSEEvent = { event: eventName, data: dataLines.join("\n") };
		eventName = null;
		dataLines = [];
		return event;
	};

	const handleLine = (line: string): SSEEvent | null => {
		if (line === "") return takeEvent();
		if (line.startsWith(":")) return null;

		const delimiter = line.indexOf(":");
		const field = delimiter === -1 ? line : line.slice(0, delimiter);
		let value = delimiter === -1 ? "" : line.slice(delimiter + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		if (field === "event") eventName = value;
		else if (field === "data") dataLines.push(value);
		return null;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const event = handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				if (event) yield event;
			}
		}

		buffer += decoder.decode();
		if (buffer.length > 0) {
			const event = handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
			if (event) yield event;
		}

		const trailing = takeEvent();
		if (trailing) yield trailing;
	} finally {
		reader.releaseLock();
	}
}
