import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { useCallback } from "react";

/** A visible string: a catalog ID and its English text, with `{name}` placeholders only. */
export interface Msg {
	readonly id: string;
	readonly message: string;
}

export type Values = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/** Substitutes `{name}` with `values.name`; a placeholder without a value stays as it is. */
export function interpolate(message: string, values?: Values): string {
	if (!values) return message;
	return message.replace(PLACEHOLDER, (match, name: string) => {
		const value = Object.hasOwn(values, name) ? values[name] : undefined;
		return value === undefined ? match : String(value);
	});
}

/**
 * A message in the active locale (plan Ruling 2). Lingui translates only an ID its catalog holds;
 * otherwise the English is interpolated here, as production Lingui has no message compiler and
 * would return an uncompiled descriptor raw (Fact V5).
 */
export function translate(i18n: I18n, msg: Msg, values?: Values): string {
	if (Object.hasOwn(i18n.messages, msg.id)) return i18n._(msg.id, values);
	return interpolate(msg.message, values);
}

/** `translate` bound to the admin's own Lingui instance. */
export function useT(): (msg: Msg, values?: Values) => string {
	const { i18n, _ } = useLingui();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `i18n` is the same object in every locale; the provider binds a new `_` on each change, so `t` changes with the locale.
	return useCallback((msg: Msg, values?: Values) => translate(i18n, msg, values), [i18n, _]);
}

/**
 * A count's message, one English form per plural category: `one` and `other` (English needs no
 * more). A catalog holds a form for each category its language has, under `{id}.{category}`
 * ("flux-import.jobs.updated.few"); `{count}` is the count, formatted for the locale.
 */
export interface PluralMsg {
	readonly id: string;
	readonly one: string;
	readonly other: string;
}

/** The form of `msg` for `count` in the active locale, with `{count}` and any other values. */
export function translatePlural(
	i18n: I18n,
	msg: PluralMsg,
	count: number,
	values?: Values,
): string {
	const locale = i18n.locale || "en";
	const all = { ...values, count: new Intl.NumberFormat(locale).format(count) };
	const category = new Intl.PluralRules(locale).select(count);
	for (const id of [`${msg.id}.${category}`, `${msg.id}.other`]) {
		if (Object.hasOwn(i18n.messages, id)) return i18n._(id, all);
	}
	return interpolate(category === "one" ? msg.one : msg.other, all);
}

/** `translatePlural` bound to the admin's own Lingui instance. */
export function useTn(): (msg: PluralMsg, count: number, values?: Values) => string {
	const { i18n, _ } = useLingui();
	// biome-ignore lint/correctness/useExhaustiveDependencies: as useT, `_` changes with the locale.
	return useCallback(
		(msg: PluralMsg, count: number, values?: Values) => translatePlural(i18n, msg, count, values),
		[i18n, _],
	);
}
