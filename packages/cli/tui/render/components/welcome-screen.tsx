import { Box, Text } from "../components.tsx";
import { theme } from "@/tui/theme.ts";
import { config } from "@/agent/config.ts";

// Spaces use \u00A0 (non-breaking space) so wrapText doesn't collapse them
const LOGO = [
	{ text: "██████╗ ███████╗██╗      █████╗ ██╗   ██╗", color: theme.brand },
	{ text: "██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝", color: theme.heading1 },
	{ text: "██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ", color: theme.info },
	{ text: "██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ", color: theme.accent },
	{ text: "██║  ██║███████╗███████╗██║  ██║   ██║   ", color: theme.success },
	{ text: "╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ", color: theme.warning },
].map(({ text, color }) => ({ text: text.replace(/ /g, "\u00A0"), color }));

export interface WelcomeScreenProps {
	version: string;
	subtitle?: string;
	hints?: string;
	userName?: string;
}

export function WelcomeScreen(
	{ version, subtitle = "Type a message to get started", hints, userName }: WelcomeScreenProps,
) {
	return (
		<Box flex flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
			<Box flexDirection="column">
				{LOGO.map(({ text, color }) => <Text key={text} color={color} bold>{text}</Text>)}
			</Box>
			<Box flexDirection="column" alignItems="center" gap={1}>
				<Text color={theme.textMuted}>v{version}</Text>
				<Text color={theme.textDim}>{config.model.split("/").pop()}</Text>
				{userName && <Text color={theme.textDim}>signed in as {userName}</Text>}
				<Text color={theme.textDim} italic>{subtitle}</Text>
				{hints && <Text color={theme.textDim} italic>{hints}</Text>}
			</Box>
		</Box>
	);
}
