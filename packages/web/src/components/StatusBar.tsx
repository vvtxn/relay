import { Show } from "solid-js";
import { streamState } from "@/state/session.ts";

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function TokenBar(props: { tokens: number; contextWindow: number }) {
	const ratio = () => (props.contextWindow > 0 ? Math.min(props.tokens / props.contextWindow, 1) : 0);
	const level = () => (ratio() >= 0.8 ? "high" : ratio() >= 0.5 ? "mid" : "low");

	return (
		<div class="token-track" title="Context window usage">
			<div class={`token-fill ${level()}`} style={{ width: `${ratio() * 100}%` }} />
		</div>
	);
}

export function StatusBar(props: {
	model: string;
	branch: string | null;
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	contextWindow: number;
	onSignOut: () => void;
}) {
	return (
		<header class="status-bar">
			<div class="status-left">
				<span class="status-model">{props.model.split("/").pop()}</span>
				<Show when={props.branch}>
					<span class="status-meta">on {props.branch}</span>
				</Show>
				<Show when={props.userName}>
					<span class="status-user">
						<Show when={props.avatarUrl}>
							<img class="avatar" src={props.avatarUrl} alt="" />
						</Show>
						<span class="status-meta">as {props.userName}</span>
					</span>
				</Show>
			</div>
			<div class="status-right">
				<div class="status-stat">
					<span class="status-stat-key">tokens</span>
					<TokenBar tokens={streamState().tokens} contextWindow={props.contextWindow} />
					<span class="status-stat-value">
						{formatTokens(streamState().tokens)} / {formatTokens(props.contextWindow)}
					</span>
				</div>
				<span class="status-sep" />
				<div class="status-stat">
					<span class="status-stat-key">cost</span>
					<span class="status-stat-value">${streamState().cost.toFixed(2)}</span>
				</div>
				<span class="status-sep" />
				<button type="button" class="status-action" onClick={props.onSignOut}>sign out</button>
			</div>
		</header>
	);
}
