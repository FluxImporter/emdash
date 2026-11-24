import { Banner, Button, Checkbox, Empty, Loader, Select, Text } from "@cloudflare/kumo";
import { type ReactElement, useEffect, useState } from "react";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M as SHARED } from "../../messages.js";
import { useFields, useSite } from "../../queries.js";
import type { SiteInfo } from "../../types.js";
import { useWizard } from "../context.js";
import { StepFooter } from "../StepFooter.js";
import { M } from "./messages.js";

/** A failed read as its sentence, with the route's specifics when `describeError` gives them. */
function ReadError(props: { error: unknown; onRetry(): void }) {
	const t = useT();
	const { msg, values, detail } = describeError(props.error);
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(msg, values)}
			{...(detail === undefined ? {} : { description: detail })}
			action={
				<Button variant="secondary" onClick={props.onRetry}>
					{t(SHARED.tryAgain)}
				</Button>
			}
		/>
	);
}

/** A select's change handler that keeps only a string value (every select here holds strings). */
const chosen = (set: (value: string) => void) => (value: unknown) => {
	if (typeof value === "string") set(value);
};

/**
 * The locale the originals are in: the one picked, else the default. A record never translates
 * an entry in its own locale (preflight F8), so picking the records' locale falls back too.
 */
function originalLocale(site: SiteInfo, locale: string, picked: string | null): string {
	return picked !== null && picked !== locale ? picked : site.defaultLocale;
}

/**
 * Step 2: the collection and locale the records go to, and, for a locale other than the default,
 * the locale of the entries they translate (spec "Target"). The collection's fields are read here,
 * so Map opens with them.
 */
export function TargetStep() {
	const t = useT();
	const { state, dispatch } = useWizard();
	const site = useSite();
	const [collection, setCollection] = useState(state.target?.collection ?? null);
	const [locale, setLocale] = useState(state.target?.locale ?? null);
	const [translates, setTranslates] = useState((state.target?.translationLocale ?? null) !== null);
	const [original, setOriginal] = useState(state.target?.translationLocale ?? null);
	const fields = useFields(collection);

	const info = site.data;
	const chosenLocale = locale ?? info?.defaultLocale ?? null;
	// Only a record in a locale other than the default can translate one (null: not offered).
	const originalOf =
		info !== undefined && chosenLocale !== null && chosenLocale !== info.defaultLocale
			? originalLocale(info, chosenLocale, original)
			: null;
	const translationLocale = translates ? originalOf : null;
	// A saved locale (from a template or a revisit) the site no longer has blocks Next.
	const staleLocale =
		info !== undefined && chosenLocale !== null && !info.locales.includes(chosenLocale)
			? chosenLocale
			: null;
	const staleTranslation =
		info !== undefined && translationLocale !== null && !info.locales.includes(translationLocale)
			? translationLocale
			: null;
	const complete =
		info !== undefined &&
		collection !== null &&
		chosenLocale !== null &&
		staleLocale === null &&
		(translationLocale === null ||
			(staleTranslation === null && translationLocale !== chosenLocale));
	const canNext = complete && !fields.isError;
	const stale = staleLocale ?? staleTranslation;
	const staleSentence = stale === null ? null : t(M.staleLocale, { locale: stale });
	const hasCollections = (info?.collections.length ?? 0) > 0;
	// A new collection clears the mapping as soon as it is chosen, so this warns beforehand.
	const hasMapping = state.target !== null && Object.keys(state.rows).length > 0;

	// Each complete choice goes to the draft as it is made, so leaving by the step bar keeps it
	// (final review 6). The same target again changes nothing (the reducer ignores it).
	useEffect(() => {
		if (!complete || collection === null || chosenLocale === null) return;
		dispatch({ type: "targetChosen", collection, locale: chosenLocale, translationLocale });
	}, [complete, collection, chosenLocale, translationLocale, dispatch]);

	const next = () => {
		if (collection === null || chosenLocale === null) return;
		dispatch({ type: "targetChosen", collection, locale: chosenLocale, translationLocale });
		dispatch({ type: "stepChanged", step: "map" });
	};

	let body: ReactElement;
	if (site.isError) {
		body = <ReadError error={site.error} onRetry={() => void site.refetch()} />;
	} else if (info === undefined || chosenLocale === null) {
		body = <Loader aria-label={t(M.loading)} />;
	} else if (!hasCollections) {
		body = <Empty title={t(M.noCollections)} description={t(M.noCollectionsHint)} />;
	} else {
		body = (
			<div className="space-y-4">
				<Select
					label={t(M.collection)}
					placeholder={t(M.collectionPlaceholder)}
					value={collection}
					onValueChange={chosen(setCollection)}
					items={info.collections.map((c) => ({
						value: c.slug,
						label: c.hidden ? t(M.hiddenCollection, { label: c.label }) : c.label,
					}))}
					{...(hasMapping ? { description: t(M.clearsMapping) } : {})}
				/>
				{fields.isError ? (
					<ReadError error={fields.error} onRetry={() => void fields.refetch()} />
				) : null}
				{info.locales.length > 1 || staleLocale !== null ? (
					<Select
						label={t(M.locale)}
						value={chosenLocale}
						onValueChange={chosen(setLocale)}
						items={info.locales.map((l) => ({ value: l, label: l }))}
						{...(staleLocale === null ? {} : { error: t(M.staleLocale, { locale: staleLocale }) })}
					/>
				) : (
					<Text>{t(M.onlyLocale, { locale: chosenLocale })}</Text>
				)}
				{originalOf !== null ? (
					<div className="space-y-2">
						<Checkbox
							label={t(M.translates)}
							checked={translates}
							onCheckedChange={(checked: boolean) => setTranslates(checked)}
						/>
						{translates ? (
							<>
								<Select
									aria-label={t(M.translationLocale)}
									value={originalOf}
									onValueChange={chosen(setOriginal)}
									items={info.locales
										.filter((l) => l !== chosenLocale)
										.map((l) => ({ value: l, label: l }))}
									{...(staleTranslation === null
										? {}
										: { error: t(M.staleLocale, { locale: staleTranslation }) })}
								/>
								<Text variant="secondary">{t(M.translationHint)}</Text>
							</>
						) : null}
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div>
			{body}
			<StepFooter
				canNext={canNext}
				{...(info !== undefined && hasCollections && collection === null
					? { reason: t(M.chooseCollection) }
					: staleSentence === null
						? {}
						: { reason: staleSentence })}
				onNext={next}
			/>
		</div>
	);
}
