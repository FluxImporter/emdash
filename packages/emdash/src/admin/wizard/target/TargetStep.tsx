import { Banner, Button, Checkbox, Empty, Loader, Select, Text } from "@cloudflare/kumo";
import { type ReactElement, useState } from "react";
import { describeError } from "../../errors.js";
import { useT } from "../../i18n.js";
import { M as SHARED } from "../../messages.js";
import { useFields, useSite } from "../../queries.js";
import type { SiteInfo } from "../../types.js";
import { useWizard } from "../context.js";
import { SUMMARY } from "../messages.js";
import { StepHeader } from "../StepHeader.js";
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

/** The step's own choices, before they reach the draft. */
interface Choice {
	collection: string | null;
	locale: string | null;
	translates: boolean;
	original: string | null;
}

/**
 * What `choice` amounts to on `site`: the locale (the default until one is picked), the original
 * entries' locale when offered and when it applies, the saved locales the site no longer has, and
 * whether the choice is complete enough for the draft.
 */
function resolve(site: SiteInfo | undefined, choice: Choice) {
	const chosenLocale = choice.locale ?? site?.defaultLocale ?? null;
	// Only a record in a locale other than the default can translate one (null: not offered).
	const originalOf =
		site !== undefined && chosenLocale !== null && chosenLocale !== site.defaultLocale
			? originalLocale(site, chosenLocale, choice.original)
			: null;
	const translationLocale = choice.translates ? originalOf : null;
	// A saved locale (from a template or a revisit) the site no longer has blocks Next.
	const staleLocale =
		site !== undefined && chosenLocale !== null && !site.locales.includes(chosenLocale)
			? chosenLocale
			: null;
	const staleTranslation =
		site !== undefined && translationLocale !== null && !site.locales.includes(translationLocale)
			? translationLocale
			: null;
	const complete =
		site !== undefined &&
		choice.collection !== null &&
		chosenLocale !== null &&
		staleLocale === null &&
		(translationLocale === null ||
			(staleTranslation === null && translationLocale !== chosenLocale));
	return { chosenLocale, originalOf, translationLocale, staleLocale, staleTranslation, complete };
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
	const [choice, setChoice] = useState<Choice>(() => ({
		collection: state.target?.collection ?? null,
		locale: state.target?.locale ?? null,
		translates: (state.target?.translationLocale ?? null) !== null,
		original: state.target?.translationLocale ?? null,
	}));
	const { collection, translates } = choice;
	const fields = useFields(collection);

	const info = site.data;
	const { chosenLocale, originalOf, translationLocale, staleLocale, staleTranslation, complete } =
		resolve(info, choice);
	const canNext = complete && !fields.isError;
	const stale = staleLocale ?? staleTranslation;
	const staleSentence = stale === null ? null : t(M.staleLocale, { locale: stale });
	const hasCollections = (info?.collections.length ?? 0) > 0;
	const mapped = Object.keys(state.rows).length > 0 || state.newFields.length > 0;
	// A different collection would clear the mapping, so while there is one it waits for Next
	// (re-picking the draft's collection undoes it), and this says so meanwhile.
	const held = state.target !== null && mapped ? state.target.collection : null;
	const changesCollection = held !== null && collection !== held;

	/**
	 * A user's change, sent to the draft at once when complete (final review 6), so leaving by the
	 * step bar keeps it: never on mount, so a revisit rewrites no saved target. The collection is
	 * held back as above; the locales still go, to the draft's collection.
	 */
	const change = (patch: Partial<Choice>) => {
		const next = { ...choice, ...patch };
		setChoice(next);
		const r = resolve(info, next);
		if (!r.complete || next.collection === null || r.chosenLocale === null) return;
		dispatch({
			type: "targetChosen",
			collection: held ?? next.collection,
			locale: r.chosenLocale,
			translationLocale: r.translationLocale,
		});
	};

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
					onValueChange={chosen((value) => change({ collection: value }))}
					items={info.collections.map((c) => ({
						value: c.slug,
						label: c.hidden ? t(M.hiddenCollection, { label: c.label }) : c.label,
					}))}
					{...(changesCollection ? { description: t(M.clearsMapping) } : {})}
				/>
				{fields.isError ? (
					<ReadError error={fields.error} onRetry={() => void fields.refetch()} />
				) : null}
				{info.locales.length > 1 || staleLocale !== null ? (
					<Select
						label={t(M.locale)}
						value={chosenLocale}
						onValueChange={chosen((value) => change({ locale: value }))}
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
							onCheckedChange={(checked: boolean) => change({ translates: checked })}
						/>
						{translates ? (
							<>
								<Select
									aria-label={t(M.translationLocale)}
									value={originalOf}
									onValueChange={chosen((value) => change({ original: value }))}
									items={info.locales
										.filter((l) => l !== chosenLocale)
										.map((l) => ({ value: l, label: l }))}
									{...(staleTranslation === null
										? {}
										: { error: t(M.staleLocale, { locale: staleTranslation }) })}
								/>
								<p className="text-sm text-kumo-default">{t(M.translationHint)}</p>
							</>
						) : null}
					</div>
				) : null}
			</div>
		);
	}

	let reason: string | undefined;
	if (info !== undefined && hasCollections && collection === null) reason = t(M.chooseCollection);
	else if (staleSentence !== null) reason = staleSentence;
	return (
		<div className="flex flex-col gap-5">
			<StepHeader
				summary={t(SUMMARY.target)}
				next={{ canNext, ...(reason === undefined ? {} : { reason }), onNext: next }}
			/>
			<div className="max-w-xl">{body}</div>
		</div>
	);
}
