import { Button, Meter } from "@cloudflare/kumo";
import { type ChangeEvent, useId, useRef, useState } from "react";
import { api } from "../../api.js";
import { ERROR_MESSAGES } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M } from "./messages.js";
import { ACCEPT, formatOf } from "./SourceSettings.js";
import type { TabProps } from "./SourceStep.js";

/** Upload file: the trusted upload route, with its progress (spec "1. Source"). */
export function UploadTab({ busy, run, pick, fail }: TabProps) {
	const t = useT();
	const inputId = useId();
	const hintId = useId();
	const labelId = useId();
	const buttonId = useId();
	const input = useRef<HTMLInputElement>(null);
	const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);

	const onChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		// The same file can be chosen again, after a fix to it.
		e.target.value = "";
		if (file === undefined) return;
		const format = formatOf(file.name);
		// Refused here, before any byte is sent.
		if (format === null) {
			fail({ msg: ERROR_MESSAGES.UNSUPPORTED_SOURCE! });
			return;
		}
		run(async () => {
			setProgress({ name: file.name, percent: 0 });
			let uploadId: string;
			try {
				({ uploadId } = await api.uploadFile(file, {
					onProgress: (sent, total) =>
						setProgress({
							name: file.name,
							percent: total > 0 ? Math.round((sent / total) * 100) : 0,
						}),
				}));
			} finally {
				setProgress(null);
			}
			await pick({ kind: "upload", uploadId, label: file.name }, format);
		});
	};

	return (
		<div className="space-y-2">
			<label id={labelId} htmlFor={inputId} className="block font-medium">
				{t(M.chooseFile)}
			</label>
			{/*
			 * The browser's own file control has no button look in the admin's themes, so a Kumo button
			 * opens it, as the admin's WordPress importer does. The input stays for the label and the
			 * file; the button is the one control keyboards and screen readers reach, so the label names
			 * it too, followed by its own text.
			 */}
			<input
				ref={input}
				id={inputId}
				type="file"
				accept={ACCEPT}
				disabled={busy}
				tabIndex={-1}
				aria-hidden="true"
				onChange={onChange}
				className="sr-only"
			/>
			<div>
				<Button
					id={buttonId}
					variant="secondary"
					disabled={busy}
					aria-labelledby={`${labelId} ${buttonId}`}
					aria-describedby={hintId}
					onClick={() => input.current?.click()}
				>
					{t(M.browseFiles)}
				</Button>
			</div>
			<p id={hintId} className="text-sm text-kumo-subtle">
				{t(M.fileTypes)}
			</p>
			{progress === null ? null : (
				<Meter label={t(M.uploading, { name: progress.name })} value={progress.percent} />
			)}
		</div>
	);
}
