import { Box, Text } from "../components.tsx";
import { space } from "@/tui/spacing.ts";
import { theme } from "@/tui/theme.ts";
import type { useApprovalPrompt } from "../hooks/approval.ts";

export interface ApprovalPromptProps {
	approval: ReturnType<typeof useApprovalPrompt>;
	width?: number;
}

export function ApprovalPrompt(props: ApprovalPromptProps) {
	const { approval, width = 72 } = props;
	const pending = approval.pending.value;

	// Absolute so a closed prompt stays out of the parent's flex flow (see
	// CommandPalette).
	if (!pending) return <Box position="absolute" />;

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
				<Text bold color={theme.warning}>
					Approval required
				</Text>
				<Box flexDirection="row" gap={space.inline}>
					<Text bold color={theme.text}>
						{pending.toolName}
					</Text>
					<Text color={theme.textMuted}>{pending.summary}</Text>
				</Box>
				<Box flexDirection="row" gap={space.gutter}>
					<Box flexDirection="row" gap={space.inline}>
						<Text bold color={theme.success}>
							y
						</Text>
						<Text color={theme.textDim}>allow once</Text>
					</Box>
					<Box flexDirection="row" gap={space.inline}>
						<Text bold color={theme.accent}>
							a
						</Text>
						<Text color={theme.textDim}>always allow</Text>
					</Box>
					<Box flexDirection="row" gap={space.inline}>
						<Text bold color={theme.error}>
							n
						</Text>
						<Text color={theme.textDim}>deny</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}
