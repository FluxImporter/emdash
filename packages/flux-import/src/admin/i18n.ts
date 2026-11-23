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
	// A locale change re-renders every `useLingui` consumer, which then calls this again.
	const { i18n } = useLingui();
	return useCallback((msg: Msg, values?: Values) => translate(i18n, msg, values), [i18n]);
}
