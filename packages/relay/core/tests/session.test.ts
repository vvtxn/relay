import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path/join";
import { FileSessionStore } from "@/core/sessions/file.ts";
import { entriesToMessages, SessionManager } from "@/core/sessions/manager.ts";
import type { Entry, MessageEntry, SessionScope } from "@/core/sessions/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempHome(
	fn: (tmpHome: string) => void | Promise<void>,
): () => Promise<void> {
	return async () => {
		const tmpHome = await Deno.makeTempDir();
		const originalHome = Deno.env.get("HOME");
		const originalUser = Deno.env.get("USER");
		Deno.env.set("HOME", tmpHome);
		Deno.env.set("USER", "testuser");
		try {
			await fn(tmpHome);
		} finally {
			if (originalHome) Deno.env.set("HOME", originalHome);
			if (originalUser) Deno.env.set("USER", originalUser);
			await Deno.remove(tmpHome, { recursive: true });
		}
	};
}

Deno.test(
	"FileSessionStore exposes the storage-neutral session contract",
	withTempHome(async () => {
		const store = new FileSessionStore();
		const scope: SessionScope = { ownerId: "testuser", cwd: "/tmp/project" };
		const session = store.create(scope);

		await session.append({ type: "message", role: "user", content: "hello" });
		const summaries = await store.listSummaries(scope);

		assertEquals(summaries.length, 1);
		assertEquals(summaries[0]!.id, session.getHeader().id);
		assertEquals(session.getEntries()[0]!.type, "message");
	}),
);

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.create - creates a session with correct header fields",
	withTempHome(() => {
		const sm = SessionManager.create("/tmp/project");
		const header = sm.getHeader();

		assertEquals(header.type, "session");
		assertEquals(header.version, 1);
		assertEquals(header.cwd, "/tmp/project");
		assertExists(header.id);
		assertExists(header.timestamp);
	}),
);

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.append - appends entries and they appear in getEntries",
	withTempHome(async () => {
		const sm = SessionManager.create("/tmp/project");

		await sm.append({ type: "message", role: "user", content: "hello" });
		await sm.append({ type: "message", role: "assistant", content: "hi" });

		const entries = sm.getEntries();
		assertEquals(entries.length, 2);
		assertEquals((entries[0] as MessageEntry).content, "hello");
		assertEquals((entries[1] as MessageEntry).content, "hi");
	}),
);

Deno.test(
	"SessionManager.append - creates the JSONL file on disk on first append",
	withTempHome(async () => {
		const sm = SessionManager.create("/tmp/project");
		const path = sm.getFilePath();
		assertExists(path);

		// File should NOT exist before first append
		let exists = false;
		try {
			await Deno.stat(path!);
			exists = true;
		} catch {
			exists = false;
		}
		assertEquals(exists, false);

		await sm.append({ type: "message", role: "user", content: "hello" });

		// File SHOULD exist after first append
		const stat = await Deno.stat(path!);
		assertEquals(stat.isFile, true);
	}),
);

Deno.test(
	"SessionManager.append - assigns id and timestamp to entries",
	withTempHome(async () => {
		const sm = SessionManager.create("/tmp/project");

		await sm.append({ type: "message", role: "user", content: "test" });

		const entry = sm.getEntries()[0]!;
		assertExists(entry.id);
		assertEquals(typeof entry.id, "string");
		assertEquals(entry.id.length > 0, true);
		assertExists(entry.timestamp);
		assertEquals(typeof entry.timestamp, "string");
	}),
);

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.open - reads a session from a JSONL file on disk",
	withTempHome(async (tmpHome: string) => {
		const dir = join(tmpHome, ".relay", "sessions", "testuser");
		await Deno.mkdir(dir, { recursive: true });

		const filePath = join(dir, "test_session.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: "abc12345",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/tmp/project",
		});
		const entry = JSON.stringify({
			type: "message",
			id: "e001",
			timestamp: "2025-01-01T00:00:01.000Z",
			role: "user",
			content: "hello from file",
		});
		await Deno.writeTextFile(filePath, header + "\n" + entry + "\n");

		const sm = await SessionManager.open(filePath);
		assertEquals(sm.getHeader().id, "abc12345");
		assertEquals(sm.getHeader().cwd, "/tmp/project");
		assertEquals(sm.getEntries().length, 1);
		assertEquals((sm.getEntries()[0] as MessageEntry).content, "hello from file");
	}),
);

// ---------------------------------------------------------------------------
// entriesToMessages
// ---------------------------------------------------------------------------

Deno.test("entriesToMessages - converts message entries correctly", () => {
	const entries: Entry[] = [
		{ type: "message", id: "1", timestamp: "t1", role: "user", content: "hi" },
		{ type: "message", id: "2", timestamp: "t2", role: "assistant", content: "hello" },
	];

	const messages = entriesToMessages(entries);
	assertEquals(messages.length, 2);
	assertEquals(messages[0], { role: "user", content: "hi" });
	assertEquals(messages[1], { role: "assistant", content: "hello" });
});

Deno.test("entriesToMessages - converts tool_result entries correctly", () => {
	const entries: Entry[] = [
		{
			type: "tool_result",
			id: "1",
			timestamp: "t1",
			toolCallId: "call_abc",
			toolName: "read_file",
			content: "file contents",
		},
	];

	const messages = entriesToMessages(entries);
	assertEquals(messages.length, 1);
	assertEquals(messages[0], {
		role: "tool",
		tool_call_id: "call_abc",
		name: "read_file",
		content: "file contents",
	});
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.list - returns sessions sorted by mtime, most recent first",
	withTempHome(async (tmpHome: string) => {
		const dir = join(tmpHome, ".relay", "sessions", "testuser");
		await Deno.mkdir(dir, { recursive: true });

		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: "a",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/tmp",
		});

		const fileOld = join(dir, "old_session.jsonl");
		const fileNew = join(dir, "new_session.jsonl");

		await Deno.writeTextFile(fileOld, header + "\n");
		// Small delay so mtime differs
		await new Promise((r) => setTimeout(r, 50));
		await Deno.writeTextFile(fileNew, header + "\n");

		const files = await SessionManager.list("/tmp");
		assertEquals(files.length, 2);
		// Most recent first
		assertEquals(files[0], fileNew);
		assertEquals(files[1], fileOld);
	}),
);

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.cleanup - deletes old sessions beyond keep count",
	withTempHome(async (tmpHome: string) => {
		const dir = join(tmpHome, ".relay", "sessions", "testuser");
		await Deno.mkdir(dir, { recursive: true });

		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: "x",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/tmp",
		});

		// Create 4 session files with different mtimes
		const files: string[] = [];
		for (let i = 0; i < 4; i++) {
			const f = join(dir, `session_${i}.jsonl`);
			await Deno.writeTextFile(f, header + "\n");
			files.push(f);
			await new Promise((r) => setTimeout(r, 50));
		}

		const deleted = await SessionManager.cleanup("/tmp", 2);
		assertEquals(deleted, 2);

		// Only 2 files should remain
		const remaining = await SessionManager.list("/tmp");
		assertEquals(remaining.length, 2);
	}),
);

// ---------------------------------------------------------------------------
// listSummaries
// ---------------------------------------------------------------------------

Deno.test(
	"SessionManager.listSummaries - returns correct id, timestamp, and first user message",
	withTempHome(async (tmpHome: string) => {
		const dir = join(tmpHome, ".relay", "sessions", "testuser");
		await Deno.mkdir(dir, { recursive: true });

		const filePath = join(dir, "summary_test.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: "sum123",
			timestamp: "2025-06-15T12:00:00.000Z",
			cwd: "/tmp",
		});
		const entry = JSON.stringify({
			type: "message",
			id: "e1",
			timestamp: "2025-06-15T12:00:01.000Z",
			role: "user",
			content: "What is Deno?",
		});
		await Deno.writeTextFile(filePath, header + "\n" + entry + "\n");

		const summaries = await SessionManager.listSummaries("/tmp");
		assertEquals(summaries.length, 1);
		assertEquals(summaries[0]!.id, "sum123");
		assertEquals(summaries[0]!.timestamp, "2025-06-15T12:00:00.000Z");
		assertEquals(summaries[0]!.firstUserMessage, "What is Deno?");
		assertEquals(summaries[0]!.reference, filePath);
	}),
);
