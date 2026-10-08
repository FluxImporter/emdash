import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type { Job, LinkRow, RecordRow } from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;

/**
 * Types a plugin storage collection for the engine. Plugin storage holds JSON documents and
 * returns them untyped (`emdash` `StorageCollection<unknown>`); this plugin is their only writer,
 * so the casts restore the type it stored.
 */
export function kvCollection<T>(collection: StorageCollection): KvCollection<T> {
	return {
		get: async (id) => (await collection.get(id)) as T | null,
		put: (id, data) => collection.put(id, data),
		delete: (id) => collection.delete(id),
		deleteMany: (ids) => collection.deleteMany(ids),
		getVersioned: async (id) =>
			(await collection.getVersioned(id)) as { value: T; revision: string } | null,
		compareAndSet: (id, expectedRevision, data) =>
			collection.compareAndSet(id, expectedRevision, data),
		query: async ({ where, ...rest }) => {
			const page = await collection.query({
				...rest,
				...(where ? { where: where as StorageWhere } : {}),
			});
			return page as { items: { id: string; data: T }[]; cursor?: string; hasMore: boolean };
		},
	};
}

export interface PluginCollections {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
}

/** The three collections declared in the plugin definition, typed for the engine. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links } = storage;
	if (!jobs || !records || !links) {
		throw new Error("flux-import: the jobs, records and links storage collections are missing");
	}
	return {
		jobs: kvCollection<Job>(jobs),
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
	};
}
