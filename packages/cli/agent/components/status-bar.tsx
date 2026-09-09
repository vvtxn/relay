import { Box, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";

// ---------------------------------------------------------------------------
// TokenBar
// ---------------------------------------------------------------------------

const TOKEN_BAR_WIDTH = 20;

function formatTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return String(n);
}

function TokenBar({ tokenCount, contextWindow }: { tokenCount: number; contextWindow: number }) {
	const ratio = contextWindow > 0 ? Math.min(tokenCount / contextWindow, 1) : 0;
	const filled = Math.round(ratio * TOKEN_BAR_WIDTH);
	const empty = TOKEN_BAR_WIDTH - filled;
	const color = ratio >= 0.8 ? theme.error : ratio >= 0.5 ? theme.warning : theme.success;

	return (
		<Box flexDirection="row" gap={1}>
			<Text color={theme.textDim}>tokens</Text>
			<Text color={filled > 0 ? color : theme.textDim}>
				{"█".repeat(filled)}
				{"░".repeat(empty)}
			</Text>
			<Text color={color}>{formatTokens(tokenCount)}</Text>
			<Text color={theme.textDim}>/ {formatTokens(contextWindow)}</Text>
		</Box>
	);
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export function StatusBar(
	{ tokenCount, totalCost, branchName, userName, contextWindow, model }: {
		tokenCount: number;
		totalCost: number;
		branchName: string;
		userName?: string;
		contextWindow: number;
		model: string;
	},
) {
	return (
		<Box flexDirection="row" justifyContent="space-between" padding={1}>
			<Box flexDirection="row" gap={1}>
				<Text bold color={theme.brand}>
					Relay
				</Text>
				<Text color={theme.textDim}>{model.split("/").pop()}</Text>
				{branchName && <Text color={theme.textDim}>on {branchName}</Text>}
				{userName && <Text color={theme.textDim}>as {userName}</Text>}
			</Box>
			<Box flexDirection="row" gap={1}>
				<TokenBar tokenCount={tokenCount} contextWindow={contextWindow} />
				<Box flexDirection="row" gap={1}>
					<Text color={theme.textDim}>cost:</Text>
					<Text color={theme.success}>{totalCost.toFixed(2)}$</Text>
				</Box>
			</Box>
		</Box>
	);
}
