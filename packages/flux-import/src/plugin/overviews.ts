/**
 * The read tools' views (M6d spec "The deferred read tools", Rulings 38, 39, 65): what an agent
 * may see of URL sources and schedules. Every field is copied by name, so a field added to a row
 * later never reaches a tool without a change here.
 */
import { hostOf } from "../sources/net.js";
import {
	listSchedules,
	type PauseReason,
	type RunEntry,
	type ScheduleDeps,
	type ScheduleMissing,
	type ScheduleView,
} from "./schedules.js";
import type { Page } from "./service.js";
import { listSources, type SourceDeps, type SourceRow } from "./sources.js";

/** Runs per schedule in `list_schedules`: the newest, as runs are stored newest first (P11). */
export const RUNS_SHOWN = 5;

export interface SourceSummary {
	id: string;
	name: string;
	/** The URL's host only: no scheme, port, path, query or fragment (a URL can carry a secret). */
	host: string;
	/** A credential is set; never its name or value. */
	credential: boolean;
	lastFetch?: { at: string; status: number; bytes: number };
	/** The code only, never the message. */
	lastError?: { at: string; code: string };
	createdAt: string;
	updatedAt: string;
}

function hostOfUrl(url: string): string {
	try {
		return hostOf(new URL(url));
	} catch {
		return "";
	}
}

export function sourceSummary(row: SourceRow): SourceSummary {
	return {
		id: row.id,
		name: row.name,
		host: hostOfUrl(row.url),
		credential: row.credential !== undefined,
		...(row.lastFetch === undefined
			? {}
			: {
					lastFetch: {
						at: row.lastFetch.at,
						status: row.lastFetch.status,
						bytes: row.lastFetch.bytes,
					},
				}),
		...(row.lastError === undefined
			? {}
			: { lastError: { at: row.lastError.at, code: row.lastError.code } }),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** `sources/overview`: `sources/list`'s pages (50, newest first) as summaries. */
export async function sourcesOverview(
	deps: Pick<SourceDeps, "sources">,
	cursor?: string,
): Promise<Page<SourceSummary>> {
	const rows = await listSources(deps, cursor);
	return { ...rows, items: rows.items.map(sourceSummary) };
}

export interface ScheduleSummary {
	id: string;
	name: string;
	templateId: string;
	templateRevision: number;
	sourceId: string;
	cron: string;
	enabled: boolean;
	publish: boolean;
	batchSize: number;
	budgetMs: number;
	missing?: ScheduleMissing;
	/** The reason is a code (M6b Ruling 47). */
	pause?: { reason: PauseReason; at: string; jobId?: string };
	/** A due mark is set. */
	due: boolean;
	/** The job a launch claim names, while a launch holds it. */
	runningJobId?: string;
	lastLaunch?: { at: string; outcome: string; jobId?: string; errorCode?: string };
	/** The newest `RUNS_SHOWN` runs; `rolledBack.by` is a job ID. */
	runs: RunEntry[];
	runCount: number;
	launchFailures: number;
	nextRunAt: string | null;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

const runOf = (r: RunEntry): RunEntry => ({
	jobId: r.jobId,
	at: r.at,
	outcome: r.outcome,
	counters: { ...r.counters },
	...(r.rolledBack === undefined
		? {}
		: { rolledBack: { by: r.rolledBack.by, at: r.rolledBack.at } }),
});

/** No `armedBy`, `createdBy`, `updatedBy`, `sourcePin`, `current.claimedAt` or `due.force`. */
export function scheduleSummary(view: ScheduleView): ScheduleSummary {
	const { pause, lastLaunch } = view;
	return {
		id: view.id,
		name: view.name,
		templateId: view.templateId,
		templateRevision: view.templateRevision,
		sourceId: view.sourceId,
		cron: view.cron,
		enabled: view.enabled,
		publish: view.publish,
		batchSize: view.batchSize,
		budgetMs: view.budgetMs,
		...(view.missing === undefined ? {} : { missing: view.missing }),
		...(pause === undefined
			? {}
			: {
					pause: {
						reason: pause.reason,
						at: pause.at,
						...(pause.jobId === undefined ? {} : { jobId: pause.jobId }),
					},
				}),
		due: view.due !== undefined,
		...(view.current === undefined ? {} : { runningJobId: view.current.jobId }),
		...(lastLaunch === undefined
			? {}
			: {
					lastLaunch: {
						at: lastLaunch.at,
						outcome: lastLaunch.outcome,
						...(lastLaunch.jobId === undefined ? {} : { jobId: lastLaunch.jobId }),
						...(lastLaunch.errorCode === undefined ? {} : { errorCode: lastLaunch.errorCode }),
					},
				}),
		runs: view.runs.slice(0, RUNS_SHOWN).map(runOf),
		runCount: view.runs.length,
		launchFailures: view.launchFailures,
		nextRunAt: view.nextRunAt,
		revision: view.revision,
		createdAt: view.createdAt,
		updatedAt: view.updatedAt,
	};
}

/**
 * `schedules/overview`: one page like `listSchedules` (`MAX_SCHEDULES`, so normally every
 * schedule and no cursor), one `ctx.cron.list()`, and no reconciliation: a read tool writes no
 * cron task (spec Ruling 39).
 */
export async function schedulesOverview(
	deps: Pick<ScheduleDeps, "schedules" | "cron">,
	cursor?: string,
): Promise<Page<ScheduleSummary>> {
	const views = await listSchedules(deps, cursor);
	return { ...views, items: views.items.map(scheduleSummary) };
}
