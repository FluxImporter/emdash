import { Banner, Button, Input, Loader, Select } from "@cloudflare/kumo";
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

/** A URL's host and path: its query may hold a key, so it is never shown. */
export function hostAndPath(text: string): string {
	try {
		const url = new URL(text);
		return `${url.host}${url.pathname}`;
	} catch {
		return "";
	}
}

/** `sources/create`'s form of an address (`URL.href`), or null when it is not one. */
function hrefOf(text: string): string | null {
	try {
		return new URL(text).href;
	} catch {
		return null;
	}
}

/**
 * A name clash (Fact D7: `sources/create` answers CONFLICT on the name alone). The saved source
 * is offered only when it fetches the address typed; otherwise another name is asked for.
 */
function TakenOffer({
	name,
	href,
	credential,
	busy,
	run,
	pick,
}: TabProps & { name: string; href: string | null; credential: string | null }) {
	const t = useT();
	const sources = useAllSources();
	if (sources.isPending) return <Loader aria-label={t(M.loadingSources)} />;
	const row = sources.data?.find((s) => s.name === name);
	if (row === undefined) {
		return <Banner variant="alert" description={t(M.nameTakenGone, { name })} />;
	}
	if (row.url !== href) {
		const address = hostAndPath(row.url);
		return <Banner variant="alert" description={t(M.nameTakenOther, { name, address })} />;
	}
	// Its credential's name only, when it is not the one chosen here (never a value).
	const saved = row.credential ?? null;
	let uses: string | null = null;
	if (saved !== credential) {
		uses = saved === null ? t(M.takenNoCredential) : t(M.takenCredential, { credential: saved });
	}
	return (
		<Banner
			variant="alert"
			description={
				<div>
					<p>{t(M.nameTaken, { name })}</p>
					{uses === null ? null : <p>{uses}</p>}
				</div>
			}
			action={
				<Button
					variant="secondary"
					disabled={busy}
					onClick={() =>
						run(async () => {
							const { uploadId } = await api.fetchSource({ id: row.id });
							await pick({ kind: "saved", uploadId, label: row.name }, formatOfUrl(row.url));
						})
					}
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
	const [taken, setTaken] = useState<{
		name: string;
		href: string | null;
		credential: string | null;
	} | null>(null);
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
					setTaken({ name: input.name, href: hrefOf(input.url), credential });
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
						setTaken(null);
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
						setTaken(null);
					}}
				/>
				<Select
					label={t(M.credential)}
					value={credential}
					loading={credentials.isPending}
					onValueChange={(v: unknown) => {
						setCredential(typeof v === "string" ? v : null);
						setTaken(null);
					}}
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
			{taken === null ? null : <TakenOffer {...props} {...taken} />}
		</div>
	);
}
