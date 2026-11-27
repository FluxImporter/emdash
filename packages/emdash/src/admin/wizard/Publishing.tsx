import { type Msg, useT, type Values } from "../i18n.js";
import { M } from "./messages.js";
import type { Publishing } from "./state.js";

/**
 * The sentence for how the entries go live. A Schedule status with no schedule writes no
 * `publishAt`, so it publishes; a fixed date is shown as stored, read in the site's timezone.
 */
function sentenceOf(p: Publishing): { msg: Msg; values?: Values } {
	if (p.status === "draft") return { msg: M.publishingDraft };
	const s = p.schedule;
	if (p.status === "publish" || s === null) return { msg: M.publishingNow };
	switch (s.kind) {
		case "fixed":
			return { msg: M.publishingFixed, values: { when: s.at.replace("T", " ") } };
		case "feed":
			return { msg: M.publishingFeed, values: { key: s.from } };
		case "kept":
			return { msg: M.publishingKept };
	}
}

/**
 * One plain line that says whether the entries will be published, kept as drafts or scheduled
 * (final review 1): a loaded template skips Options, where the status is chosen.
 */
export function PublishingLine(props: { publishing: Publishing }) {
	const t = useT();
	const { msg, values } = sentenceOf(props.publishing);
	return <p className="text-sm">{t(msg, values)}</p>;
}
