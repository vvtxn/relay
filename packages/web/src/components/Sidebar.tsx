import { useState } from "preact/hooks";
import type { MeResponse, SessionSummary } from "@vvtxn/client/protocol.ts";

interface SidebarProps {
	cwd: string;
	sessions: SessionSummary[];
	activeId: string | null;
	user: MeResponse | null;
	onCwd: (value: string) => void;
	onNew: () => void;
	onOpen: (id: string) => void;
}

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Sidebar({ cwd, sessions, activeId, user, onCwd, onNew, onOpen }: SidebarProps) {
	const [wsInput, setWsInput] = useState(cwd);

	function applyWorkspace(): void {
		const value = wsInput.trim();
		if (value && value !== cwd) onCwd(value);
	}

	return (
		<aside class="sidebar">
			<div class="brand">Relay</div>

			<div class="workspace">
				<input
					class="ws-input"
					value={wsInput}
					placeholder="/path/to/project"
					spellcheck={false}
					onInput={(e) => setWsInput((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					onBlur={applyWorkspace}
				/>
			</div>

			<button type="button" class="btn new-chat" onClick={onNew}>+ New chat</button>

			<div class="session-list">
				{sessions.length === 0 && <div class="session-empty">No sessions yet</div>}
				{sessions.map((session) => (
					<button
						key={session.reference}
						type="button"
						class={`session-item ${session.reference === activeId ? "active" : ""}`}
						onClick={() => onOpen(session.reference)}
					>
						<div class="session-time">{formatTimestamp(session.timestamp)}</div>
						<div class="session-preview">
							{session.firstUserMessage
								? session.firstUserMessage.length > 60
									? session.firstUserMessage.slice(0, 60) + "…"
									: session.firstUserMessage
								: "(empty session)"}
						</div>
					</button>
				))}
			</div>

			<div class="sidebar-footer">{user?.name ?? "signed out"}</div>
		</aside>
	);
}
