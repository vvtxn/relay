import { run } from "@/tui/render/index.ts";
import { Box, CommandPalette, Text } from "@/tui/render/components.tsx";
import { useSignal } from "@/tui/render/hooks/signals.ts";
import { type CommandPaletteItem, useCommandPalette } from "@/tui/render/hooks/command-palette.ts";
import { theme } from "@/tui/theme.ts";

const COMMANDS: CommandPaletteItem[] = [
	{ id: "new-file", title: "New File", description: "Create a new file", keywords: ["create"] },
	{ id: "open-file", title: "Open File", description: "Open an existing file", keywords: ["browse"] },
	{ id: "save", title: "Save", description: "Save the current file", keywords: ["write"] },
	{ id: "save-all", title: "Save All", description: "Save all open files" },
	{ id: "find", title: "Find", description: "Search in file", keywords: ["search"] },
	{ id: "replace", title: "Find and Replace", description: "Search and replace text" },
	{ id: "git-commit", title: "Git: Commit", description: "Commit staged changes", keywords: ["version control"] },
	{ id: "git-push", title: "Git: Push", description: "Push to remote", keywords: ["version control"] },
	{ id: "settings", title: "Settings", description: "Open settings", keywords: ["preferences", "config"] },
	{ id: "theme", title: "Change Theme", description: "Switch color theme", keywords: ["colors"] },
	{ id: "quit", title: "Quit", description: "Exit the application", keywords: ["exit", "close"] },
];

function App() {
	const lastCommand = useSignal("None");

	const palette = useCommandPalette({
		items: COMMANDS,
		onSelect: (item) => {
			lastCommand.value = item.title;
		},
	});

	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			<Box bgColor={theme.surface} padding={1} flexDirection="column" gap={1}>
				<Text bold color="white">
					Press / to open the command palette
				</Text>
				<Box flexDirection="row" gap={1}>
					<Text color="gray">Last command:</Text>
					<Text color="cyan" bold>
						{lastCommand.value}
					</Text>
				</Box>
			</Box>
			<Text color="gray" italic>
				/ to open • Up/Down to navigate • Enter to select • Esc to close • Ctrl+C to exit
			</Text>
			<CommandPalette palette={palette} />
		</Box>
	);
}

run(() => <App />);
