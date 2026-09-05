import { Box, Spinner, Text } from "@/tui/render/components.tsx";
import { theme } from "@/tui/theme.ts";

/** Shown while authentication and the initial session are being resolved. */
export function BootScreen() {
	return (
		<Box flex flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
			<Box flexDirection="row" gap={1}>
				<Spinner color={theme.accent} />
				<Text color={theme.textDim}>Signing in...</Text>
			</Box>
		</Box>
	);
}

/** Shown when authentication fails so startup errors never crash before render. */
export function BootError({ message }: { message: string }) {
	return (
		<Box flex flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
			<Text color={theme.error} bold>Authentication failed</Text>
			<Text color={theme.textMuted}>{message}</Text>
			<Text color={theme.textDim} italic>
				Check DEV_AUTH_SUBJECT, TURSO_DB_URL and TURSO_DB_TOKEN, then restart with Ctrl+C.
			</Text>
		</Box>
	);
}
