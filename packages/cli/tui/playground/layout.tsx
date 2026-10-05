import { run } from "@/tui/render/index.ts";
import { Box, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";

function App() {
	return (
		<Box flex flexDirection="column" padding={1} gap={1}>
			{/* Flex Directions */}
			<Box flexDirection="row" gap={1}>
				<Box flex bgColor={theme.surface} flexDirection="row" padding={1} gap={1}>
					<Text color="red">A</Text>
					<Text color="green">B</Text>
					<Text color="blue">C</Text>
				</Box>
				<Box flex bgColor={theme.surface} flexDirection="column" padding={1} gap={1}>
					<Text color="red">A</Text>
					<Text color="green">B</Text>
					<Text color="blue">C</Text>
				</Box>
			</Box>

			{/* Surface Elevation */}
			<Box flexDirection="row" gap={1}>
				<Box flex bgColor={theme.background} padding={1}>
					<Text color="gray">background</Text>
				</Box>
				<Box flex bgColor={theme.surface} padding={1}>
					<Text color="gray">surface</Text>
				</Box>
				<Box flex bgColor={theme.surfaceElevated} padding={1}>
					<Text color="gray">surfaceElevated</Text>
				</Box>
			</Box>

			{/* Padding & Gap */}
			<Box bgColor={theme.surface} flexDirection="row" gap={1} padding={1}>
				<Box flex bgColor={theme.surfaceElevated} flexDirection="row">
					<Text color="red">X</Text>
					<Text color="green">Y</Text>
					<Text color="blue">Z</Text>
				</Box>
				<Box flex bgColor={theme.surfaceElevated} flexDirection="row" padding={1}>
					<Text color="red">X</Text>
					<Text color="green">Y</Text>
					<Text color="blue">Z</Text>
				</Box>
				<Box flex bgColor={theme.surfaceElevated} flexDirection="row" padding={1} gap={2}>
					<Text color="red">X</Text>
					<Text color="green">Y</Text>
					<Text color="blue">Z</Text>
				</Box>
			</Box>

			{/* Justify Content */}
			<Box bgColor={theme.surface} flexDirection="column" gap={1} padding={1}>
				<Box
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					justifyContent="flex-start"
					height={3}
					padding={1}
					gap={1}
				>
					<Text>A</Text>
					<Text>B</Text>
					<Text>C</Text>
				</Box>
				<Box
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					justifyContent="center"
					height={3}
					padding={1}
					gap={1}
				>
					<Text>A</Text>
					<Text>B</Text>
					<Text>C</Text>
				</Box>
				<Box
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					justifyContent="flex-end"
					height={3}
					padding={1}
					gap={1}
				>
					<Text>A</Text>
					<Text>B</Text>
					<Text>C</Text>
				</Box>
				<Box
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					justifyContent="space-between"
					height={3}
					padding={1}
					gap={1}
				>
					<Text>A</Text>
					<Text>B</Text>
					<Text>C</Text>
				</Box>
			</Box>

			{/* Align Items */}
			<Box bgColor={theme.surface} flexDirection="row" gap={1} padding={1}>
				<Box
					flex
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					alignItems="flex-start"
					height={5}
					padding={1}
					gap={1}
				>
					<Text color="red">Top</Text>
					<Text color="green">Top</Text>
				</Box>
				<Box
					flex
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					alignItems="center"
					height={5}
					padding={1}
					gap={1}
				>
					<Text color="red">Mid</Text>
					<Text color="green">Mid</Text>
				</Box>
				<Box
					flex
					bgColor={theme.surfaceElevated}
					flexDirection="row"
					alignItems="flex-end"
					height={5}
					padding={1}
					gap={1}
				>
					<Text color="red">Bot</Text>
					<Text color="green">Bot</Text>
				</Box>
			</Box>

			{/* Absolute Positioning + Background Colors */}
			<Box bgColor={theme.surface} height={7} padding={1}>
				<Box bgColor="blue" width={20} height={3} padding={1}>
					<Text color="white" bold>Blue bg</Text>
				</Box>
				<Box bgColor="green" width={20} height={3} padding={1}>
					<Text color="black" bold>Green bg</Text>
				</Box>
				<Box position="absolute" top={1} right={2} bgColor="yellow" padding={1}>
					<Text color="black" bold>Overlay!</Text>
				</Box>
			</Box>

			{/* Footer */}
			<Box>
				<Text color="gray" italic>Press Ctrl+C to exit</Text>
			</Box>
		</Box>
	);
}

run(() => <App />);
