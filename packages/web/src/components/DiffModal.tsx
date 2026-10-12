import { createEffect, Show } from "solid-js";
import { getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import { closeDiffPreview, diffPreview } from "#/state/diff-preview.ts";
import { DiffBlock } from "./DiffBlock.tsx";

/**
 * Scrollable review of one edit/write diff. A native `<dialog>` opened with
 * `showModal()`: it renders in the top layer above the app, inerts what is
 * behind it, and closes on Escape, the Close button, or a backdrop click. The
 * diff only mounts while the modal is open.
 */
export function DiffModal() {
	let dialog: HTMLDialogElement | undefined;
	let pressedOnBackdrop = false;

	createEffect(() => {
		const current = diffPreview();
		if (!dialog) return;
		if (current && !dialog.open) dialog.showModal();
		else if (!current && dialog.open) dialog.close();
	});

	return (
		<dialog
			ref={dialog}
			class="diff-modal"
			aria-labelledby="diff-modal-title"
			onPointerDown={(event) => {
				pressedOnBackdrop = event.target === dialog;
			}}
			onClick={(event) => {
				// A text selection released outside the panel must not dismiss the modal.
				if (pressedOnBackdrop && event.target === dialog) closeDiffPreview();
			}}
			onClose={closeDiffPreview}
		>
			<Show when={diffPreview()}>
				{(preview) => (
					<div class="diff-modal-panel">
						<header class="diff-modal-head">
							<span class="diff-modal-title" id="diff-modal-title">
								<span class="diff-modal-name">{getToolDisplayName(preview().name)}</span>
								<span class="diff-modal-path" title={preview().path}>
									{preview().path}
								</span>
							</span>
							<button type="button" class="btn ghost" onClick={closeDiffPreview}>
								Close
							</button>
						</header>
						<div class="diff-modal-body" tabIndex={0}>
							<DiffBlock diff={preview().diff} />
						</div>
					</div>
				)}
			</Show>
		</dialog>
	);
}
