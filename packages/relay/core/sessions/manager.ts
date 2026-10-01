import { join } from "@std/path/join";
import { dirname } from "@std/path/dirname";
import type { Message } from "@/api/types.ts";
import { sessionDir, sessionFilePath } from "./paths.ts";
import {
	CURRENT_VERSION,
	type Entry,
	type MessageEntry,
	type Session,
	type SessionHeader,
	type SessionSummary,
	type ToolResultEntry,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type NewEntry = Omit<MessageEntry, "id" | "timestamp"> | Omit<ToolResultEntry, "id" | "timestamp">;

function newId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readSession(path: string): Promise<Session> {
	const text = await Deno.readTextFile(path);
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const headerLine = lines[0];
	if (!headerLine) throw new Error(`Session file has no header: ${path}`);
	const header = JSON.parse(headerLine) as SessionHeader;
	const entries = lines.slice(1).map((l) => JSON.parse(l) as Entry);
	return { header, entries };
}

// ---------------------------------------------------------------------------
// Entry → Message conversion
// ---------------------------------------------------------------------------

function entryToMessage(entry: Entry): Message {
	switch (entry.type) {
		case "message":
			return {
				role: entry.role,
				content: entry.content,
				...(entry.toolCalls?.length && { tool_calls: entry.toolCalls }),
			};
		case "tool_result":
			return {
				role: "tool",
				tool_call_id: entry.toolCallId,
				name: entry.toolName,
				content: entry.content,
			};
	}
}

/** Convert session entries into the Message[] format expected by the LLM provider. */
export function entriesToMessages(entries: Entry[]): Message[] {
	return entries.map(entryToMessage);
}

export { stripAttachedContext } from "@/core/display.ts";

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
	private session: Session;
	private path: string | null;
	private needsFlush: boolean;
	private headerDirty = false;
	private appendQueue = Promise.resolve();

	private constructor(session: Session, path: string | null, needsFlush = false) {
		this.session = session;
		this.path = path;
		this.needsFlush = needsFlush;
	}

	/** Start a new persistent session. File is created lazily on first append. */
	static create(cwd: string, ownerId?: string): SessionManager {
		const id = newId();
		const path = sessionFilePath(cwd, id, ownerId);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_VERSION,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		};

		SessionManager.cleanup(cwd, 10, ownerId).catch(() => {});
		return new SessionManager({ header, entries: [] }, path, true);
	}

	/** Load and continue the most recent session for this cwd. */
	static async continueRecent(cwd: string, ownerId?: string): Promise<SessionManager | null> {
		const files = await SessionManager.list(cwd, ownerId);
		if (files.length === 0) return null;
		const first = files[0];
		return first ? SessionManager.open(first) : null;
	}

	/** Load a specific session file. */
	static async open(path: string): Promise<SessionManager> {
		const session = await readSession(path);
		return new SessionManager(session, path);
	}

	/** List all session files for this cwd, most recently active first. */
	static async list(cwd: string, ownerId?: string): Promise<string[]> {
		const dir = sessionDir(cwd, ownerId);
		const files: { path: string; mtime: number }[] = [];

		try {
			for await (const entry of Deno.readDir(dir)) {
				if (entry.isFile && entry.name.endsWith(".jsonl")) {
					try {
						const path = join(dir, entry.name);
						const stat = await Deno.stat(path);
						files.push({ path, mtime: stat.mtime?.getTime() ?? 0 });
					} catch {
						// Skip files that vanish between readDir and stat
					}
				}
			}
		} catch {
			return [];
		}

		return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
	}

	/** Delete old sessions beyond the `keep` most recent. Returns count deleted. */
	static async cleanup(cwd: string, keep = 10, ownerId?: string): Promise<number> {
		const files = await SessionManager.list(cwd, ownerId);
		const toDelete = files.slice(keep);
		await Promise.all(toDelete.map((f) => Deno.remove(f)));
		return toDelete.length;
	}

	/** List session summaries (id, timestamp, first user message) for this cwd. */
	static async listSummaries(cwd: string, ownerId?: string): Promise<SessionSummary[]> {
		const files = await SessionManager.list(cwd, ownerId);
		const summaries: SessionSummary[] = [];

		for (const filePath of files) {
			try {
				const file = await Deno.open(filePath, { read: true });
				const lines: string[] = [];
				let buf = "";

				// Read only enough to get header + first user message (typically lines 1-2)
				for await (const chunk of file.readable) {
					buf += new TextDecoder().decode(chunk);
					const parts = buf.split("\n");
					for (let i = 0; i < parts.length - 1; i++) {
						const part = parts[i];
						if (part?.trim()) lines.push(part);
					}
					buf = parts[parts.length - 1] ?? "";

					// Header + first entry is enough in most cases
					if (lines.length >= 2) break;
				}
				if (buf.trim()) lines.push(buf);
				if (lines.length === 0) continue;

				const headerLine = lines[0];
				if (!headerLine) continue;
				const header = JSON.parse(headerLine) as SessionHeader;
				let firstUserMessage: string | null = null;

				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (!line) continue;
					const entry = JSON.parse(line) as Entry;
					if (entry.type === "message" && entry.role === "user" && typeof entry.content === "string") {
						firstUserMessage = entry.content;
						break;
					}
				}

				summaries.push({ id: header.id, reference: filePath, timestamp: header.timestamp, firstUserMessage });
			} catch {
				// Skip corrupt files
			}
		}

		return summaries;
	}

	getEntries(): Entry[] {
		return this.session.entries;
	}

	getHeader(): SessionHeader {
		return this.session.header;
	}

	getFilePath(): string | null {
		return this.path;
	}

	/** Get the current token count from the session header. */
	getTokens(): number {
		return this.session.header.tokens ?? 0;
	}

	/** Update the token count in the session header (persisted on next append or flush). */
	setTokens(tokens: number): void {
		this.session.header.tokens = tokens;
		this.headerDirty = true;
	}

	/** Get the current total cost from the session header. */
	getCost(): number {
		return this.session.header.cost ?? 0;
	}

	/** Update the total cost in the session header (persisted on next append or flush). */
	setCost(cost: number): void {
		this.session.header.cost = cost;
		this.headerDirty = true;
	}

	/** Flush a dirty header by rewriting the session file. */
	private async flushHeader(): Promise<void> {
		if (!this.path || !this.headerDirty) return;
		const content = await Deno.readTextFile(this.path);
		const lines = content.split("\n");
		lines[0] = JSON.stringify(this.session.header);
		await Deno.writeTextFile(this.path, lines.join("\n"));
		this.headerDirty = false;
	}

	/** Append a new entry to the session. Creates the file on first call. */
	async append(entry: NewEntry): Promise<string> {
		let id = "";
		const operation = this.appendQueue.then(async () => {
			id = newId();
			const full = { ...entry, id, timestamp: new Date().toISOString() } as Entry;
			if (this.path) {
				if (this.needsFlush) {
					await Deno.mkdir(dirname(this.path), { recursive: true });
					await Deno.writeTextFile(this.path, JSON.stringify(this.session.header) + "\n");
					this.needsFlush = false;
					this.headerDirty = false;
				} else if (this.headerDirty) await this.flushHeader();
				await Deno.writeTextFile(this.path, JSON.stringify(full) + "\n", { append: true });
			}
			this.session.entries.push(full);
		});
		this.appendQueue = operation.catch(() => {});
		await operation;
		return id;
	}

	/** Flush the header to disk. Call on session switch, quit, or idle. */
	async flush(): Promise<void> {
		await this.appendQueue;
		await this.flushHeader();
	}
}
