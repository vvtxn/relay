import { run } from "@/tui/render/index.ts";
import { ApprovalPrompt, Box, Text } from "@/tui/render/components.tsx";
import { getHookKey, hasCleanup, setCleanup, useSignal } from "@/tui/render/hooks/signals.ts";
import { type ApprovalDecision, useApprovalPrompt } from "@/tui/render/hooks/approval.ts";
import { inputManager, type KeyEvent } from "@/tui/core/input.ts";

const DEMO_TOOLS = [
	{ toolName: "Run", summary: "git status" },
	{ toolName: "Write", summary: "src/new-file.ts" },
	{ toolName: "Edit", summary: "packages/relay/core/agent.ts" },
];

function App() {
	const lastDecision = useSignal("None");
	const toolIndex = useSignal(0);
	const approval = useApprovalPrompt();

	const key = getHookKey("demo-");
	if (!hasCleanup(key)) {
		const cleanup = inputManager.onKeyGlobal((event: KeyEvent) => {
			if (event.key !== "t" || approval.pending.value) return false;
			const request = DEMO_TOOLS[toolIndex.value % DEMO_TOOLS.length];
			if (!request) return false;
			toolIndex.value++;
			void approval.ask(request).then((decision: ApprovalDecision) => {
				lastDecision.value = `${decision} (${request.toolName})`;
			});
			return true;
		});
		setCleanup(key, cleanup);
	}

	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			<Box border="single" borderLabel="Approval Prompt Demo" padding={1} flexDirection="column" gap={1}>
				<Text bold color="white">
					Press t to simulate a tool call requiring approval
				</Text>
				<Box flexDirection="row" gap={1}>
					<Text color="gray">Last decision:</Text>
					<Text color="cyan" bold>
						{lastDecision.value}
					</Text>
				</Box>
			</Box>
			<Text color="gray" italic>
				t to trigger • y/a/n to answer • Ctrl+C to exit
			</Text>
			<ApprovalPrompt approval={approval} />
		</Box>
	);
}

run(() => <App />);
