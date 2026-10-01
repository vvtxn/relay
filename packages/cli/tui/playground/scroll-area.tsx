import { run } from "@/tui/render/index.ts";
import { Box, ScrollArea, Text } from "@/tui/render/components.tsx";

const COLORS = ["white", "cyan", "yellow", "green", "magenta", "red", "blue"] as const;

const PHRASES = [
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
	"Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
	"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	"Duis aute irure dolor in reprehenderit in voluptate velit esse.",
	"Excepteur sint occaecat cupidatat non proident, sunt in culpa.",
	"Curabitur pretium tincidunt lacus sed auctor cursus nisi.",
	"Vestibulum ante ipsum primis in faucibus orci luctus et ultrices.",
	"Nulla facilisi. Etiam non diam ante. Aenean lacinia bibendum nulla.",
];

function App() {
	const lines = Array.from({ length: 50 }, (_, i) => ({
		text: `Line ${i + 1}: ${PHRASES[i % PHRASES.length] ?? ""}`,
		color: COLORS[i % COLORS.length] ?? "white",
		bold: i % 10 === 0,
		italic: i % 7 === 0,
	}));

	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			<Box border="single" borderLabel="Scrollable Content" flexDirection="column">
				<ScrollArea flex flexDirection="column" height={20} scrollbar focused>
					{lines.map((line, i) => (
						<Text key={i} color={line.color} bold={line.bold} italic={line.italic}>
							{line.text}
						</Text>
					))}
				</ScrollArea>
			</Box>
			<Text color="gray" italic>
				Up/Down to scroll • PageUp/PageDown for page scroll • Ctrl+C to exit
			</Text>
		</Box>
	);
}

run(() => <App />);
