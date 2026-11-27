import type { ScheduleView } from "../../../plugin/schedules.js";
import type { SourceRow } from "../../../plugin/sources.js";

/**
 * Schedules pinned to an edited template or source (plan Ruling 14). A schedule runs a template at
 * one revision and pins its source's URL and credential; a launch whose pin no longer matches
 * pauses the schedule (`template_changed`, `source_changed`). The edit dialogs name these schedules
 * and, after the save, update them one at a time.
 */
export type PinChange =
	| { kind: "template"; templateId: string }
	| { kind: "source"; sourceId: string };

/** A `schedules/update` body that re-pins one schedule. */
export interface PinUpdate {
	id: string;
	revision: number;
	templateId?: string;
	templateRevision?: number;
	enabled?: true;
}

/**
 * The schedules a save re-pins. A template: every schedule on it, enabled or not, since resuming
 * one re-pins only its source. A source: the enabled ones; a disabled one re-pins when resumed.
 */
export function pinnedSchedules(
	schedules: readonly ScheduleView[],
	change: PinChange,
): ScheduleView[] {
	return change.kind === "template"
		? schedules.filter((s) => s.templateId === change.templateId)
		: schedules.filter((s) => s.enabled && s.sourceId === change.sourceId);
}

/** The URL as the server stores it (`URL.href`); the text itself when it is not a URL. */
function storedUrl(text: string): string {
	try {
		return new URL(text).href;
	} catch {
		return text;
	}
}

/**
 * Whether a `sources/update` body moves the source's pin: a new URL or credential, compared as
 * `sourcePinOf` and `updateSource` do (no credential is `undefined` in the row, `null` in the edit).
 */
export function sourcePinChanged(
	row: Pick<SourceRow, "url" | "credential">,
	edit: { url?: string; credential?: string | null },
): boolean {
	const url = edit.url !== undefined && storedUrl(edit.url) !== row.url;
	const credential =
		edit.credential !== undefined && (edit.credential ?? null) !== (row.credential ?? null);
	return url || credential;
}

/**
 * The update that re-pins `s`. A template's names its new revision; a source's is `enabled: true`,
 * the only update that re-pins a source (it also clears the launch failures and re-arms the
 * schedule as the editor, `updateSchedule`).
 */
export function pinUpdate(s: ScheduleView, change: PinChange, newRevision?: number): PinUpdate {
	if (change.kind === "source") return { id: s.id, revision: s.revision, enabled: true };
	if (newRevision === undefined) throw new Error("A template's pin needs its new revision");
	return {
		id: s.id,
		revision: s.revision,
		templateId: change.templateId,
		templateRevision: newRevision,
	};
}

/**
 * Updates each schedule in turn after the save, going on past a failure (`SCHEDULE_BUSY`, a
 * schedule changed meanwhile, the network): the updated IDs, and each failure by schedule name.
 */
export async function updatePinned(
	rows: readonly ScheduleView[],
	change: PinChange,
	newRevision: number | undefined,
	update: (i: PinUpdate) => Promise<unknown>,
): Promise<{ updated: string[]; failed: { name: string; error: unknown }[] }> {
	const updated: string[] = [];
	const failed: { name: string; error: unknown }[] = [];
	for (const s of rows) {
		try {
			await update(pinUpdate(s, change, newRevision));
			updated.push(s.id);
		} catch (error) {
			failed.push({ name: s.name, error });
		}
	}
	return { updated, failed };
}
