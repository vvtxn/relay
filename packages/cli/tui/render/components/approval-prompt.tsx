import { Box, Text } from "../components.tsx";
import { theme } from "@/tui/theme.ts";
import type { useApprovalPrompt } from "../hooks/approval.ts";

export interface ApprovalPromptProps {
	approval: ReturnType<typeof useApprovalPrompt>;
	width?: number;
}

export function ApprovalPrompt(props: ApprovalPromptProps) {
	const { approval, width = 72 } = props;
	const pending = approval.pending.value;

	if (!pending) return <Box />;

	return (
		<Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
			<Box
				width={width}
				border="round"
				borderColor={theme.warning}
				borderLabel="Approval required"
				borderLabelColor={theme.warning}
				bgColor={theme.surfaceElevated}
				flexDirection="column"
				padding={1}
				gap={1}
			>
				<Box flexDirection="row" gap={1}>
					<Text bold color={theme.text}>
						{pending.toolName}
					</Text>
					<Text color={theme.textMuted}>{pending.summary}</Text>
				</Box>
				<Box flexDirection="row" gap={2}>
					<Box flexDirection="row" gap={1}>
						<Text bold color={theme.success}>
							y
						</Text>
						<Text color={theme.textDim}>allow once</Text>
					</Box>
					<Box flexDirection="row" gap={1}>
						<Text bold color={theme.accent}>
							a
						</Text>
						<Text color={theme.textDim}>always allow</Text>
					</Box>
					<Box flexDirection="row" gap={1}>
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
