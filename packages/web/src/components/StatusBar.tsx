interface StatusBarProps {
	branch: string | null;
	tokens: number;
	cost: number;
	userName?: string;
	cwd: string;
}

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function StatusBar({ branch, tokens, cost, userName, cwd }: StatusBarProps) {
	return (
		<div class="status-bar">
			<span class="status-branch" title={cwd}>{branch ?? "no branch"}</span>
			<span class="sep">•</span>
			<span>{formatTokens(tokens)} tokens</span>
			<span class="sep">•</span>
			<span>${cost.toFixed(4)}</span>
			<span class="spacer" />
			{userName && <span class="status-user">{userName}</span>}
		</div>
	);
}
