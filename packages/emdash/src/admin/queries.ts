import {
	type InfiniteData,
	skipToken,
	type UseInfiniteQueryResult,
	type UseQueryResult,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { Fence } from "../emdash/fence.js";
import type { JobStatus } from "../engine/types.js";
import type { CredentialInfo } from "../plugin/credentials.js";
import type { ScheduleView } from "../plugin/schedules.js";
import type { JobSummariesPage, Page } from "../plugin/service.js";
import type { SourceRow } from "../plugin/sources.js";
import type { JobListItem } from "../plugin/summaries.js";
import type { SavedTemplate, TemplateSummary } from "../plugin/templates.js";
import { api } from "./api.js";
import { isRetryable } from "./api-error.js";
import type { SchemaField, SiteInfo } from "./types.js";

/** The admin's reads, through the host's `QueryClient` (Fact V8). Every key starts with `fluximporter`. */
export const queryKeys = {
	site: ["fluximporter", "site"],
	fields: (collection: string | null) => ["fluximporter", "fields", collection],
	credentials: ["fluximporter", "credentials"],
	sources: ["fluximporter", "sources"],
	templates: (collection?: string) => ["fluximporter", "templates", collection ?? null],
	/** Every `templates` key, whatever its collection: what a template save makes stale. */
	allTemplates: ["fluximporter", "templates"],
	/**
	 * One saved template with its body. Outside `allTemplates`: a save invalidates it by its own
	 * key, and every read of it asks again (`staleTime: 0`).
	 */
	template: (id: string | null) => ["fluximporter", "template", id],
	/** The Jobs tab's pages of real imports, every status filter's: what a job change makes stale. */
	jobs: ["fluximporter", "jobs"],
	/** The pages of one status (null: all), under `jobs`. */
	jobPages: (status: JobStatus | null) => ["fluximporter", "jobs", status ?? "all"],
	/** The first page of dry runs. */
	dryRuns: ["fluximporter", "dry-runs"],
	schedules: ["fluximporter", "schedules"],
	fence: ["fluximporter", "fence"],
} as const;

/** Plan Ruling 15: a list that holds unfinished work refetches this often, in a visible tab. */
export const JOB_POLL_MS = 5000;
export const SCHEDULE_POLL_MS = 5000;
export const SCHEDULE_IDLE_MS = 60_000;

/** Every 5 s while a loaded job is `created` or `running`; otherwise never. */
export function jobPollInterval(
	data: { pages: readonly Page<JobListItem>[] } | undefined,
): number | false {
	const live = data?.pages.some((page) =>
		page.items.some((i) => i.status === "created" || i.status === "running"),
	);
	return live ? JOB_POLL_MS : false;
}

/** Every 5 s while a schedule is `due` or `current`, else every 60 s. */
export function schedulePollInterval(rows: readonly ScheduleView[] | undefined): number {
	return rows?.some((s) => s.due !== undefined || s.current !== undefined)
		? SCHEDULE_POLL_MS
		: SCHEDULE_IDLE_MS;
}

/**
 * The host's `QueryClient` retries every failure once (preflight F19). Only an offline error, a
 * 429 or a 5xx is retried here, once: a 403 is final, so the access probe answers at once.
 */
const retry = (failureCount: number, error: Error) => isRetryable(error) && failureCount < 1;

/**
 * The host's `QueryClient` keeps data fresh for 60 s (`staleTime: 60_000`, @emdash-cms/admin). The
 * home's lists change from its other tabs (Run now, a cancel, a rollback), so each is read again
 * whenever a tab shows it.
 */
const ALWAYS_STALE = 0;

/**
 * Every item of a paged list, following `cursor` while `hasMore`. `read` passes React Query's
 * signal on, so an unmount aborts the walk instead of reading every remaining page.
 */
async function allPages<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await read(cursor);
		items.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return items;
}

export function useSite(): UseQueryResult<SiteInfo> {
	return useQuery({ queryKey: queryKeys.site, queryFn: () => api.site(), retry });
}

/** A collection's fields; no request while `collection` is null. */
export function useFields(collection: string | null): UseQueryResult<SchemaField[]> {
	return useQuery({
		queryKey: queryKeys.fields(collection),
		queryFn: collection === null ? skipToken : () => api.collection(collection),
		retry,
	});
}

/**
 * A collection's fields as the cache holds them, without asking for them: undefined until a step
 * that reads them (Target, Map, Options) has. It follows the cache, so a refetch shows here too.
 */
export function useCachedFields(collection: string | null): SchemaField[] | undefined {
	const client = useQueryClient();
	const subscribe = useCallback(
		(onChange: () => void) => client.getQueryCache().subscribe(onChange),
		[client],
	);
	return useSyncExternalStore(subscribe, () =>
		collection === null
			? undefined
			: client.getQueryData<SchemaField[]>(queryKeys.fields(collection)),
	);
}

/** The credential names and headers (never values); also the page's access probe (Ruling 17). */
export function useCredentials(): UseQueryResult<CredentialInfo[]> {
	return useQuery({ queryKey: queryKeys.credentials, queryFn: () => api.credentials(), retry });
}

/** Every saved URL source. */
export function useAllSources(): UseQueryResult<SourceRow[]> {
	return useQuery({
		queryKey: queryKeys.sources,
		queryFn: ({ signal }) =>
			allPages((cursor) => api.listSources(cursor === undefined ? {} : { cursor }, signal)),
		retry,
	});
}

/** Every saved template, or those of one collection. */
export function useAllTemplates(collection?: string): UseQueryResult<TemplateSummary[]> {
	return useQuery({
		queryKey: queryKeys.templates(collection),
		queryFn: ({ signal }) =>
			allPages((cursor) =>
				api.listTemplates(
					{
						...(collection === undefined ? {} : { collection }),
						...(cursor === undefined ? {} : { cursor }),
					},
					signal,
				),
			),
		retry,
	});
}

/**
 * The Jobs tab's real imports, of one status or all (null), a `JOB_PAGE` at a time; the next page
 * is asked for with the last one's cursor. The first page carries the list's `total`.
 */
export function useJobPages(
	status: JobStatus | null = null,
): UseInfiniteQueryResult<InfiniteData<JobSummariesPage, string | undefined>> {
	return useInfiniteQuery({
		queryKey: queryKeys.jobPages(status),
		queryFn: ({ pageParam, signal }) =>
			api.jobSummaries(
				{
					dryRun: false,
					...(status === null ? {} : { status }),
					...(pageParam === undefined ? {} : { cursor: pageParam }),
				},
				signal,
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
		refetchInterval: (query) => jobPollInterval(query.state.data),
		retry,
		staleTime: ALWAYS_STALE,
	});
}

/** The first page of dry runs: the Jobs tab shows their count and a few lines, not the history. */
export function useDryRuns(): UseQueryResult<Page<JobListItem>> {
	return useQuery({
		queryKey: queryKeys.dryRuns,
		queryFn: ({ signal }) => api.jobSummaries({ dryRun: true }, signal),
		retry,
		staleTime: ALWAYS_STALE,
	});
}

/** Every schedule (a site holds at most `MAX_SCHEDULES`, one page). */
export function useSchedules(): UseQueryResult<ScheduleView[]> {
	return useQuery({
		queryKey: queryKeys.schedules,
		queryFn: ({ signal }) =>
			allPages((cursor) => api.listSchedules(cursor === undefined ? {} : { cursor }, signal)),
		refetchInterval: (query) => schedulePollInterval(query.state.data),
		retry,
		staleTime: ALWAYS_STALE,
	});
}

/** The site fence beside the schedules; it follows the schedules' interval. */
export function useFence(): UseQueryResult<Fence> {
	const client = useQueryClient();
	return useQuery({
		queryKey: queryKeys.fence,
		queryFn: async () => (await api.fence()).fence,
		refetchInterval: () =>
			schedulePollInterval(client.getQueryData<ScheduleView[]>(queryKeys.schedules)),
		retry,
		staleTime: ALWAYS_STALE,
	});
}

/** One saved template with its body; no request while `id` is null. */
export function useTemplate(id: string | null): UseQueryResult<SavedTemplate> {
	return useQuery({
		queryKey: queryKeys.template(id),
		queryFn: id === null ? skipToken : () => api.getTemplate({ id }),
		retry,
		staleTime: ALWAYS_STALE,
	});
}
