import { useCallback, useEffect } from "react";
import type { SuggestReply } from "../../../plugin/suggest.js";
import { api } from "../../api.js";
import { useWizard } from "../context.js";
import type { WizardState } from "../state.js";

/** Names each ask, so a late answer to an earlier one is dropped (see `staleAnswer`). */
let asks = 0;

/**
 * Map's suggestions (spec "Suggestions"). On entry with nothing mapped and no suggestion yet, it
 * asks `templates/suggest` once, with no `ai` flag: the route then uses the configured provider,
 * if any. `ask(overwrite)` asks again; it never rejects, a failure becomes the suggestion's error.
 */
export function useSuggestions(): {
	ask(overwrite: boolean): Promise<void>;
	status: WizardState["suggestion"]["status"];
	reply: SuggestReply | undefined;
} {
	const { state, dispatch, once } = useWizard();
	const { target, source, sourceBlock, suggestion, generation } = state;
	const collection = target?.collection ?? null;
	const locale = target?.locale ?? null;
	const uploadId = source?.uploadId ?? null;

	const ask = useCallback(
		async (overwrite: boolean) => {
			if (collection === null || locale === null || uploadId === null) return;
			asks += 1;
			const id = asks;
			dispatch({ type: "suggestionStarted", ask: id });
			try {
				const reply = await api.suggest({ collection, locale, uploadId, source: sourceBlock });
				dispatch({ type: "suggestionReceived", reply, overwriteUserRows: overwrite, ask: id });
			} catch (error) {
				dispatch({ type: "suggestionFailed", error, ask: id });
			}
		},
		[collection, locale, uploadId, sourceBlock, dispatch],
	);

	const empty = Object.keys(state.rows).length === 0;
	useEffect(() => {
		if (!empty || suggestion.status !== "idle") return;
		// Keyed by the draft's generation, so a remount before the first answer asks once.
		void once(`suggest:${generation}`, () => ask(false));
	}, [empty, suggestion.status, generation, once, ask]);

	return { ask, status: suggestion.status, reply: suggestion.reply };
}
