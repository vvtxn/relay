import { Box, Text, TextInput } from "../components.tsx";
import { theme } from "@/tui/theme.ts";
import type { CommandPaletteItem } from "../hooks/command-palette.ts";
import type { useCommandPalette } from "../hooks/command-palette.ts";

export interface CommandPaletteProps {
	palette: ReturnType<typeof useCommandPalette>;
	width?: number;
	placeholder?: string;
	borderLabel?: string;
}

export function CommandPalette(props: CommandPaletteProps) {
	const { palette, width = 60, placeholder = "Type a command...", borderLabel = "Commands" } = props;

	if (!palette.open.value) return <Box />;

	return (
		<Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
			<Box
				width={width}
				border="round"
				borderColor={theme.border}
				borderLabel={borderLabel}
				borderLabelColor={theme.borderLabel}
				bgColor={theme.surfaceElevated}
				flexDirection="column"
				padding={1}
				gap={1}
			>
				<TextInput
					value={palette.query.value}
					cursorPosition={palette.cursor.value}
					placeholder={placeholder}
					placeholderColor={theme.textDim}
					focused
					width={width - 4}
				/>
				<Box flexDirection="column">
					{palette.matches.map((item: CommandPaletteItem, i: number) => {
						const isSelected = i === palette.selectedIndex.value;
						return (
							<Box key={item.id} flexDirection="row" justifyContent="space-between" gap={1}>
								<Text color={isSelected ? theme.text : theme.textMuted} bold={isSelected}>
									{item.title}
								</Text>
								{item.description && (
									<Text color={theme.textMuted} italic>
										{item.description}
									</Text>
								)}
							</Box>
						);
					})}
					{palette.matches.length === 0 && (
						<Text color={theme.textDim} italic>
							No matching commands
						</Text>
					)}
				</Box>
			</Box>
		</Box>
	);
}
