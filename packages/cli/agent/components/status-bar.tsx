import { Box, Text } from "#/tui/render/components.tsx";
import { theme } from "#/tui/theme.ts";

export function StatusBar({ totalCost, branchName }: { totalCost: number; branchName: string }) {
	return (
		<Box
			flexDirection="row"
			justifyContent="space-between"
			flexWrap="wrap"
			paddingX={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<Box flexDirection="row" gap={1}>
				<Text bold color={theme.brand}>
					Relay
				</Text>
				{branchName && <Text color={theme.textFaint}>on {branchName}</Text>}
			</Box>
			<Box flexDirection="row" gap={1}>
				<Text color={theme.textDim}>cost:</Text>
				<Text color={theme.success}>{totalCost.toFixed(2)}$</Text>
			</Box>
		</Box>
	);
}
