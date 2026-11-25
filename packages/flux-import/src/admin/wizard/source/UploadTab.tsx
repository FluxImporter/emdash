import { Button, Meter } from "@cloudflare/kumo";
import { type ChangeEvent, useId, useRef, useState } from "react";
import { api } from "../../api.js";
import { ERROR_MESSAGES } from "../../errors.js";
import { useT } from "../../i18n.js";
import { UploadSimpleIcon } from "../../ui/icons.js";
import { useWizard } from "../context.js";
import { M } from "./messages.js";
import { ACCEPT, formatOf } from "./SourceSettings.js";
import type { TabProps } from "./SourceStep.js";

/** Upload file: the trusted upload route, with its progress (spec "1. Source"). */
export function UploadTab({ busy, run, pick, fail }: TabProps) {
	const t = useT();
	const inputId = useId();
	const hintId = useId();
	const { state } = useWizard();
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
		<div className="flex flex-col items-start gap-2">
			{/*
			 * The browser's own file control has no button look in the admin's themes, so a Kumo button
			 * opens it, as the admin's WordPress importer does. The input stays, out of sight and of the
			 * tab order, for its label and its files; the button is the one control keyboards and screen
			 * readers reach.
			 */}
			<label htmlFor={inputId} className="sr-only">
				{t(M.chooseFile)}
			</label>
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
			<Button
				variant="secondary"
				icon={<UploadSimpleIcon aria-hidden="true" />}
				disabled={busy}
				aria-describedby={hintId}
				onClick={() => input.current?.click()}
			>
				{t(state.source?.kind === "upload" ? M.chooseAnother : M.chooseFile)}
			</Button>
			<p id={hintId} className="text-sm text-kumo-default">
				{t(M.fileTypes)}
			</p>
			{progress === null ? null : (
				<div className="w-full">
					<Meter label={t(M.uploading, { name: progress.name })} value={progress.percent} />
				</div>
			)}
		</div>
	);
}
