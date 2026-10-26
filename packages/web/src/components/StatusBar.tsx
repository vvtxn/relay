import { Show } from "solid-js";
import type { BoxSummary } from "@vvtxn/client/protocol.ts";
import { streamState } from "#/state/session.ts";

function boxLabel(box: BoxSummary): string {
	return `${box.image.replace(/^localhost\//, "")} · ${box.state}`;
}

export function StatusBar(props: {
	branch: string | null;
	box?: BoxSummary | undefined;
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	canSignOut: boolean;
	onSignOut: () => void;
}) {
	return (
		<header class="status-bar">
			<div class="status-left">
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
				<Show when={props.box}>
					{(box) => (
						<>
							<div class="status-stat" title={`${box().image} (${box().state})`}>
								<span class="status-stat-key">box</span>
								<span class="status-stat-value">{boxLabel(box())}</span>
							</div>
							<span class="status-sep" />
						</>
					)}
				</Show>
				<div class="status-stat">
					<span class="status-stat-key">cost</span>
					<span class="status-stat-value">${streamState().cost.toFixed(2)}</span>
				</div>
				<Show when={props.canSignOut}>
					<span class="status-sep" />
					<button type="button" class="status-action" onClick={props.onSignOut}>
						sign out
					</button>
				</Show>
			</div>
		</header>
	);
}
