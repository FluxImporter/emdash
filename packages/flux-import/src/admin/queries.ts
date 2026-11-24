import { skipToken, type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { CredentialInfo } from "../plugin/credentials.js";
import type { Page } from "../plugin/service.js";
import type { SourceRow } from "../plugin/sources.js";
import type { TemplateSummary } from "../plugin/templates.js";
import { api } from "./api.js";
import { isRetryable } from "./api-error.js";
import type { SchemaField, SiteInfo } from "./types.js";

/** The admin's reads, through the host's `QueryClient` (Fact V8). Every key starts with `flux-import`. */
export const queryKeys = {
	site: ["flux-import", "site"],
	fields: (collection: string | null) => ["flux-import", "fields", collection],
	credentials: ["flux-import", "credentials"],
	sources: ["flux-import", "sources"],
	templates: (collection?: string) => ["flux-import", "templates", collection ?? null],
	/** Every `templates` key, whatever its collection: what a template save makes stale. */
	allTemplates: ["flux-import", "templates"],
} as const;

/**
 * The host's `QueryClient` retries every failure once (preflight F19). Only an offline error, a
 * 429 or a 5xx is retried here, once: a 403 is final, so the access probe answers at once.
 */
const retry = (failureCount: number, error: Error) => isRetryable(error) && failureCount < 1;

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
