import { useEffect } from "preact/hooks";
import {
	booted,
	bootError,
	bootstrap,
	branch,
	cost,
	cwd,
	draftText,
	draftToolCalls,
	errorText,
	isRunning,
	messages,
	newSession,
	openSession,
	pendingApproval,
	sessionId,
	setCwd,
	statusText,
	tokens,
	user,
} from "./state.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { Composer } from "./components/Composer.tsx";
import { ApprovalDialog } from "./components/ApprovalDialog.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

export function App() {
	useEffect(() => {
		void bootstrap();
	}, []);

	if (!booted.value) {
		return (
			<div class="app boot">
				<span class="spinner" /> Connecting to Relay server...
			</div>
		);
	}

	if (bootError.value) {
		return (
			<div class="app boot error">
				<div class="boot-error-title">Cannot reach the Relay server</div>
				<div class="boot-error-message">{bootError.value}</div>
				<div class="boot-error-hint">
					Start one with <code>deno task serve</code>, then reload.
				</div>
			</div>
		);
	}

	return (
		<div class="app">
			<Sidebar
				cwd={cwd.value}
				sessions={sessions.value}
				activeId={sessionId.value}
				user={user.value}
				onCwd={setCwd}
				onNew={() => void newSession()}
				onOpen={(id) => void openSession(id)}
			/>
			<main class="main">
				<StatusBar
					branch={branch.value}
					tokens={tokens.value}
					cost={cost.value}
					userName={user.value?.name}
					cwd={cwd.value}
				/>
				<ChatView
					messages={messages.value}
					streaming={isRunning.value}
					draftText={draftText.value}
					draftToolCalls={draftToolCalls.value}
					statusText={statusText.value}
				/>
				<ApprovalDialog approval={pendingApproval.value} />
				<Composer sessionId={sessionId.value} disabled={isRunning.value} />
			</main>
			{errorText.value && <div class="toast">{errorText.value}</div>}
		</div>
	);
}
