import { useEffect, useRef, useState } from "preact/hooks";
import { client } from "../api.ts";
import { cancelRun, submit } from "../state.ts";

interface ComposerProps {
	sessionId: string | null;
	disabled: boolean;
}

const MAX_FILE_HITS = 10;

export function Composer({ sessionId, disabled }: ComposerProps) {
	const [value, setValue] = useState("");
	const [mentionOpen, setMentionOpen] = useState(false);
	const [mentionStart, setMentionStart] = useState(-1);
	const [mentionQuery, setMentionQuery] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [highlight, setHighlight] = useState(0);
	const textRef = useRef<HTMLTextAreaElement>(null);

	// File cache is per-session
	useEffect(() => {
		setFiles([]);
		setMentionOpen(false);
	}, [sessionId]);

	async function openMentions(from: number): Promise<void> {
		setMentionStart(from);
		setMentionQuery("");
		setHighlight(0);
		if (sessionId && files.length === 0) {
			try {
				const response = await client.listFiles(sessionId);
				setFiles(response.files);
			} catch {
				// Picker stays empty; @mention still typed as plain text
			}
		}
		setMentionOpen(true);
	}

	function handleChange(e: Event): void {
		const target = e.target as HTMLTextAreaElement;
		const next = target.value;
		setValue(next);

		const pos = target.selectionStart ?? next.length;
		if (mentionOpen) {
			if (mentionStart >= 0 && pos > mentionStart + 1) setMentionQuery(next.slice(mentionStart + 1, pos));
			else if (pos <= mentionStart) setMentionOpen(false);
		} else if (pos > 0 && next[pos - 1] === "@") {
			void openMentions(pos - 1);
		}
	}

	const filtered = mentionOpen && mentionQuery
		? files.filter((f) => f.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, MAX_FILE_HITS)
		: mentionOpen
		? files.slice(0, MAX_FILE_HITS)
		: [];

	function pick(file: string): void {
		const insert = `@${file} `;
		const before = value.slice(0, mentionStart);
		const after = value.slice(mentionStart + 1 + mentionQuery.length);
		const next = before + insert + after;
		setValue(next);
		setMentionOpen(false);
		requestAnimationFrame(() => {
			const ta = textRef.current;
			if (ta) {
				ta.focus();
				const pos = (before + insert).length;
				ta.setSelectionRange(pos, pos);
			}
		});
	}

	function handleKey(e: KeyboardEvent): void {
		if (mentionOpen && filtered.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlight((highlight + 1) % filtered.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlight((highlight - 1 + filtered.length) % filtered.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				pick(filtered[highlight]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMentionOpen(false);
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function send(): void {
		if (!value.trim() || disabled) return;
		void submit(value);
		setValue("");
		setMentionOpen(false);
	}

	return (
		<div class="composer">
			{mentionOpen && (
				<div class="file-picker">
					{filtered.length === 0
						? <div class="file-empty">No matching files</div>
						: filtered.map((file, i) => (
							<div
								key={file}
								class={`file-item ${i === highlight ? "active" : ""}`}
								onMouseEnter={() => setHighlight(i)}
								onClick={() => pick(file)}
							>
								{file}
							</div>
						))}
				</div>
			)}
			<textarea
				ref={textRef}
				class="composer-input"
				placeholder={disabled ? "Relay is working..." : "Write a message... (@ to attach files, Enter to send)"}
				value={value}
				rows={3}
				spellcheck={false}
				onInput={handleChange}
				onKeyDown={handleKey}
			/>
			<div class="composer-bar">
				<span class="composer-hint">Enter to send • Shift+Enter for newline • @ for files</span>
				{disabled && (
					<button type="button" class="btn danger stop-btn" onClick={() => void cancelRun()}>Stop</button>
				)}
			</div>
		</div>
	);
}
