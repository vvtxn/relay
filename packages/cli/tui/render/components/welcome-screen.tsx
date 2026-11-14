import { Box, Text } from "../components.tsx";
import { theme } from "#/tui/theme.ts";

// Monochrome brand mark — silver primary, no multicolor decoration.
// Spaces use \u00A0 (non-breaking space) so wrapText doesn't collapse them
const LOGO = [
	"██████╗ ███████╗██╗      █████╗ ██╗   ██╗",
	"██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝",
	"██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ",
	"██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ",
	"██║  ██║███████╗███████╗██║  ██║   ██║   ",
	"╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ",
].map((text) => text.replace(/ /g, "\u00A0"));

export interface WelcomeScreenProps {
	subtitle?: string | undefined;
	hints?: string | undefined;
}

export function WelcomeScreen({ subtitle = "Type a message to get started", hints }: WelcomeScreenProps) {
	return (
		<Box flex flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
			<Box flexDirection="column">
				{LOGO.map((text) => (
					<Text key={text} color={theme.brand} bold>
						{text}
					</Text>
				))}
			</Box>
			<Box flexDirection="column" alignItems="center" gap={1}>
				<Text color={theme.textDim} italic>
					{subtitle}
				</Text>
				{hints && (
					<Text color={theme.textDim} italic>
						{hints}
					</Text>
				)}
			</Box>
		</Box>
	);
}
