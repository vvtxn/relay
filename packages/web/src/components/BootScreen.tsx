function BrandMark() {
	return (
		<div class="boot-brand">
			<div class="boot-logo">RELAY</div>
			<div class="boot-tagline">coding agent</div>
		</div>
	);
}

export function BootScreen() {
	return (
		<div class="boot">
			<div class="boot-card">
				<BrandMark />
				<div class="boot-status">
					<div class="spinner" />
					<span>Connecting to the server...</span>
				</div>
			</div>
		</div>
	);
}

export function BootError(props: { message: string; onRetry?: () => void }) {
	const retry = () => {
		if (props.onRetry) props.onRetry();
		else globalThis.location.reload();
	};

	return (
		<div class="boot">
			<div class="boot-card boot-card-error">
				<BrandMark />
				<div class="boot-error-title">Can't reach Relay</div>
				<div class="boot-error-message">{props.message}</div>
				<ul class="boot-hints">
					<li>
						Start the server with <code>deno task serve</code>.
					</li>
					<li>Confirm the server is listening and the URL above is correct.</li>
					<li>If the server is remote, it must allow this browser origin.</li>
				</ul>
				<div class="boot-actions">
					<button type="button" class="btn primary" onClick={retry}>Retry</button>
				</div>
			</div>
		</div>
	);
}

export function LoginScreen(props: { onLogin: () => void }) {
	return (
		<div class="boot">
			<div class="boot-card">
				<BrandMark />
				<div class="boot-error-title">Sign in required</div>
				<div class="boot-error-message">Your session is not authenticated. Continue to sign in.</div>
				<div class="boot-actions">
					<button type="button" class="btn primary" onClick={props.onLogin}>Continue with GitHub</button>
				</div>
			</div>
		</div>
	);
}
