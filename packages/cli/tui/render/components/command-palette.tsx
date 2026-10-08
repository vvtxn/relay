import { Box, Text, TextInput } from "../components.tsx";
import { space } from "@/tui/spacing.ts";
import { theme } from "@/tui/theme.ts";
import type { CommandPaletteItem } from "../hooks/command-palette.ts";
import type { useCommandPalette } from "../hooks/command-palette.ts";

export interface CommandPaletteProps {
	palette: ReturnType<typeof useCommandPalette>;
	width?: number;
	placeholder?: string;
	title?: string;
}

export function CommandPalette(props: CommandPaletteProps) {
	const { palette, width = 60, placeholder = "Type a command...", title = "Commands" } = props;

	// Absolute so a closed palette stays out of the parent's flex flow — an
	// in-flow empty box would consume a `gap` row and lift the composer.
	if (!palette.open.value) return <Box position="absolute" />;

	return (
		<Box
			position="absolute"
			top={0}
			left={0}
			right={0}
			bottom={0}
			bgColor={theme.background}
			justifyContent="center"
			alignItems="center"
		>
			<Box
				width={width}
				bgColor={theme.surfaceElevated}
				flexDirection="column"
				paddingX={space.overlayX}
				paddingY={space.overlayY}
				gap={space.block}
			>
				<Text bold color={theme.textDim}>{title}</Text>
				<TextInput
					value={palette.query.value}
					cursorPosition={palette.cursor.value}
					placeholder={placeholder}
					placeholderColor={theme.textDim}
					focused
					width={width - space.overlayX * 2}
				/>
				<Box flexDirection="column">
					{palette.matches.map((item: CommandPaletteItem, i: number) => {
						const isSelected = i === palette.selectedIndex.value;
						return (
							<Box key={item.id} flexDirection="row" justifyContent="space-between" gap={space.inline}>
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
