import { run } from "@/tui/render/index.ts";
import { Box, Spinner, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";

function App() {
	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			<Box bgColor={theme.surface} flexDirection="row" gap={2} padding={1}>
				<Text color={theme.textDim} bold>Different Colors</Text>
				<Spinner color="red" />
				<Spinner color="green" />
				<Spinner color="blue" />
				<Spinner color="cyan" />
				<Spinner color="magenta" />
				<Spinner color="yellow" />
			</Box>

			<Box bgColor={theme.surface} flexDirection="column" gap={1} padding={1}>
				<Text color={theme.textDim} bold>Different Speeds</Text>
				<Box flexDirection="row" gap={3}>
					<Box flexDirection="row" gap={1}>
						<Spinner interval={40} />
						<Text>Fast (40ms)</Text>
					</Box>
					<Box flexDirection="row" gap={1}>
						<Spinner />
						<Text>Normal (80ms)</Text>
					</Box>
					<Box flexDirection="row" gap={1}>
						<Spinner interval={200} />
						<Text>Slow (200ms)</Text>
					</Box>
				</Box>
			</Box>

			<Box bgColor={theme.surface} flexDirection="column" gap={1} padding={1}>
				<Text color={theme.textDim} bold>Spinner with Text</Text>
				<Box flexDirection="row" gap={1}>
					<Spinner color="cyan" />
					<Text>Loading...</Text>
				</Box>
				<Box flexDirection="row" gap={1}>
					<Spinner color="magenta" />
					<Text>Processing...</Text>
				</Box>
			</Box>

			<Box bgColor={theme.surface} flexDirection="row" gap={1} padding={1}>
				<Text color={theme.textDim} bold>Nested surfaces</Text>
				<Box bgColor={theme.surfaceElevated} padding={1}>
					<Spinner color="green" />
				</Box>
			</Box>

			<Box>
				<Text color="gray" italic>
					Press Ctrl+C to exit
				</Text>
			</Box>
		</Box>
	);
}

run(() => <App />);
