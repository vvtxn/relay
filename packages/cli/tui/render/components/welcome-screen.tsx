import { Box, Text } from "../components.tsx";
import { theme } from "@/tui/theme.ts";

// Monochrome brand mark — silver primary, no multicolor decoration.
// Spaces use \u00A0 (non-breaking space) so wrapText doesn't collapse them
const LOGO = [
	{ text: "██████╗ ███████╗██╗      █████╗ ██╗   ██╗", color: theme.brand },
	{ text: "██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝", color: theme.brand },
	{ text: "██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ", color: theme.brand },
	{ text: "██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ", color: theme.brand },
	{ text: "██║  ██║███████╗███████╗██║  ██║   ██║   ", color: theme.brand },
	{ text: "╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ", color: theme.brand },
].map(({ text, color }) => ({ text: text.replace(/ /g, "\u00A0"), color }));

export interface WelcomeScreenProps {
	version: string;
	subtitle?: string;
	hints?: string;
	userName?: string;
	/** Active model identifier, when the client knows it. */
	model?: string;
}

export function WelcomeScreen(
	{ version, subtitle = "Type a message to get started", hints, userName, model }: WelcomeScreenProps,
) {
	return (
		<Box flex flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
			<Box flexDirection="column">
				{LOGO.map(({ text, color }) => <Text key={text} color={color} bold>{text}</Text>)}
			</Box>
			<Box flexDirection="column" alignItems="center" gap={1}>
				<Text color={theme.textMuted}>v{version}</Text>
				{model && <Text color={theme.textDim}>{model.split("/").pop()}</Text>}
				{userName && <Text color={theme.textDim}>signed in as {userName}</Text>}
				<Text color={theme.textDim} italic>{subtitle}</Text>
				{hints && <Text color={theme.textDim} italic>{hints}</Text>}
			</Box>
		</Box>
	);
}
