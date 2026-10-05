import { run } from "@/tui/render/index.ts";
import { Box, Text, TextInput } from "@/tui/render/components.tsx";
import { useSignal } from "@/tui/render/hooks/signals.ts";
import { useTextInput, type VimMode } from "@/tui/render/hooks/text-input.ts";
import { theme } from "@/tui/theme.ts";

function App() {
	const input = useSignal("");
	const cursor = useSignal(0);
	const mode = useSignal<VimMode>("NORMAL");
	const submitted = useSignal<string[]>([]);

	const handleSubmit = (value: string) => {
		if (!value.trim()) return;
		submitted.value = [...submitted.value, value];
		input.value = "";
		cursor.value = 0;
	};

	useTextInput({
		value: input,
		cursorPosition: cursor,
		mode,
		focused: true,
		onSubmit: handleSubmit,
	});

	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			<Box flexDirection="row" gap={1}>
				<Text bold color="white">Mode:</Text>
				<Text bold color={mode.value === "INSERT" ? "green" : "cyan"}>
					{mode.value}
				</Text>
			</Box>

			<Box bgColor={theme.surface} padding={1} flexDirection="column">
				<TextInput
					value={input.value}
					cursorPosition={cursor.value}
					focused
					width={60}
					placeholder="Type something..."
					placeholderColor="gray"
				/>
			</Box>

			<Box flexDirection="row" gap={1}>
				<Text color="gray">Value:</Text>
				<Text color="white">"{input.value}"</Text>
				<Text color="gray">Cursor:</Text>
				<Text color="yellow">{cursor.value}</Text>
				<Text color="gray">Length:</Text>
				<Text color="yellow">{input.value.length}</Text>
			</Box>

			{submitted.value.length > 0 && (
				<Box bgColor={theme.surface} padding={1} flexDirection="column" gap={0}>
					<Text color={theme.textDim} bold>Submitted</Text>
					{submitted.value.map((val, i) => (
						<Box flexDirection="row" gap={1}>
							<Text color="gray">{i + 1}.</Text>
							<Text color="white">{val}</Text>
						</Box>
					))}
				</Box>
			)}

			<Box bgColor={theme.surface} padding={1} flexDirection="column" gap={1}>
				<Text color={theme.textDim} bold>Keybindings</Text>
				<Box flexDirection="column">
					<Text bold color="green">INSERT mode:</Text>
					<Text color="gray">Type text • Backspace • Ctrl+W (word delete) • Ctrl+U (delete to start)</Text>
					<Text color="gray">Ctrl+K (delete to end) • Esc (to NORMAL)</Text>
				</Box>
				<Box flexDirection="column">
					<Text bold color="cyan">NORMAL mode:</Text>
					<Text color="gray">h/l (move) • w/b/e (word motion) • 0/$ (line start/end)</Text>
					<Text color="gray">i/a/I/A (enter insert) • x (delete char) • D (delete to end)</Text>
					<Text color="gray">C (change to end) • ~ (toggle case)</Text>
				</Box>
			</Box>

			<Text color="gray" italic>Enter to submit • Ctrl+C to exit</Text>
		</Box>
	);
}

run(() => <App />);
