import { Meter } from "@cloudflare/kumo";
import { type ChangeEvent, useId, useState } from "react";
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
			<label htmlFor={inputId} className="block font-medium">
				{t(M.chooseFile)}
			</label>
			<input
				id={inputId}
				type="file"
				accept={ACCEPT}
				disabled={busy}
				aria-describedby={hintId}
				onChange={onChange}
				className="block text-sm"
			/>
			<p id={hintId} className="text-sm text-kumo-subtle">
				{t(M.fileTypes)}
			</p>
			{progress === null ? null : (
				<Meter label={t(M.uploading, { name: progress.name })} value={progress.percent} />
			)}
		</div>
	);
}
