import { Banner, Button, Input, Select } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { api } from "../../api.js";
import { ApiError } from "../../api-error.js";
import { useT } from "../../i18n.js";
import { queryKeys, useAllSources, useCredentials } from "../../queries.js";
import { M } from "./messages.js";
import { formatOfUrl } from "./SourceSettings.js";
import type { TabProps } from "./SourceStep.js";

/** `sources/create`'s longest name. */
const NAME_MAX = 100;

/** A source's default name: the URL's host and path, without a trailing `/`. */
export function nameFromUrl(text: string): string {
	try {
		const url = new URL(text.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return `${url.host}${url.pathname}`.replace(/\/+$/, "").slice(0, NAME_MAX);
	} catch {
		return "";
	}
}

/** The offer to use the saved source that already has the name (Fact D7). */
function TakenOffer({ name, busy, run, pick }: TabProps & { name: string }) {
	const t = useT();
	const sources = useAllSources();
	const row = sources.data?.find((s) => s.name === name);
	return (
		<Banner
			variant="alert"
			description={t(M.nameTaken, { name })}
			action={
				<Button
					variant="secondary"
					disabled={busy || row === undefined}
					loading={sources.isPending}
					onClick={() => {
						if (row === undefined) return;
						run(async () => {
							const { uploadId } = await api.fetchSource({ id: row.id });
							await pick({ kind: "saved", uploadId, label: row.name }, formatOfUrl(row.url));
						});
					}}
				>
					{t(M.useSaved)}
				</Button>
			}
		/>
	);
}

/**
 * From URL: `sources/create` (with an existing credential, if any), then `sources/fetch` (plan
 * Ruling 7). The source is saved under its name, derived from the URL until it is edited.
 */
export function UrlTab(props: TabProps) {
	const { busy, run, pick } = props;
	const t = useT();
	const queryClient = useQueryClient();
	const credentials = useCredentials();
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [named, setNamed] = useState(false);
	const [credential, setCredential] = useState<string | null>(null);
	const [taken, setTaken] = useState<string | null>(null);
	const ready = url.trim() !== "" && name.trim() !== "";

	const fetchUrl = () =>
		run(async () => {
			setTaken(null);
			const input = {
				name: name.trim(),
				url: url.trim(),
				...(credential === null ? {} : { credential }),
			};
			let row: Awaited<ReturnType<typeof api.createSource>>;
			try {
				row = await api.createSource(input);
			} catch (e) {
				if (e instanceof ApiError && e.code === "CONFLICT") {
					// The cached list may predate the source with this name.
					void queryClient.invalidateQueries({ queryKey: queryKeys.sources });
					setTaken(input.name);
					return;
				}
				throw e;
			}
			void queryClient.invalidateQueries({ queryKey: queryKeys.sources });
			const { uploadId } = await api.fetchSource({ id: row.id });
			await pick({ kind: "url", uploadId, label: row.name }, formatOfUrl(row.url));
		});

	const names = credentials.data?.map((c) => c.name) ?? [];
	return (
		<div className="space-y-4">
			<div className="grid gap-4 md:grid-cols-2">
				<Input
					label={t(M.address)}
					type="url"
					value={url}
					onChange={(e: ChangeEvent<HTMLInputElement>) => {
						setUrl(e.target.value);
						if (!named) setName(nameFromUrl(e.target.value));
					}}
				/>
				<Input
					label={t(M.name)}
					description={t(M.nameHint)}
					maxLength={NAME_MAX}
					value={name}
					onChange={(e: ChangeEvent<HTMLInputElement>) => {
						setName(e.target.value);
						setNamed(true);
					}}
				/>
				<Select
					label={t(M.credential)}
					value={credential}
					loading={credentials.isPending}
					onValueChange={(v: unknown) => setCredential(typeof v === "string" ? v : null)}
					items={[
						{ value: null, label: t(M.noCredential) },
						...names.map((n) => ({ value: n, label: n })),
					]}
				>
					<Select.Option value={null}>{t(M.noCredential)}</Select.Option>
					{names.map((n) => (
						<Select.Option key={n} value={n}>
							{n}
						</Select.Option>
					))}
				</Select>
			</div>
			<Button variant="primary" disabled={busy || !ready} onClick={fetchUrl}>
				{t(M.fetch)}
			</Button>
			{taken === null ? null : <TakenOffer {...props} name={taken} />}
		</div>
	);
}
