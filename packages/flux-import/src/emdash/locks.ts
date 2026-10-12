import type { Database } from "emdash";
import { type Kysely, PostgresAdapter, sql } from "kysely";

export type EmDashDb = Kysely<Database>;

/** Same detection as EmDash's own `isPostgres` (src/database/dialect-helpers.ts:33-46). */
export function isPostgres(db: EmDashDb): boolean {
	return db.getExecutor().adapter instanceof PostgresAdapter;
}

/**
 * A live lease on the entry, held by anyone but `userId`, on a collection with edit locking on.
 *
 * EmDash has no public lock API, so this reads the internal `_emdash_entry_locks` table the way
 * `EntryLockRepository.findEnforceable` does (src/database/repositories/entry-locks.ts:112-122,
 * :230-235): `expires_at` is compared to the database clock in the dialect's own form. The lock
 * table has no locale column; entry IDs are per-locale rows, so the entry ID scopes the locale.
 * An integration test pins this query because the table is internal.
 */
export function foreignLockQuery(
	db: EmDashDb,
	collection: string,
	entryId: string,
	userId: string,
) {
	const expiresAt = sql.ref("_emdash_entry_locks.expires_at");
	const live = isPostgres(db)
		? sql<boolean>`${expiresAt}::timestamptz > clock_timestamp()`
		: sql<boolean>`${expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	return db
		.selectFrom("_emdash_entry_locks")
		.innerJoin("_emdash_collections", "_emdash_collections.slug", "_emdash_entry_locks.collection")
		.select("_emdash_entry_locks.user_id")
		.where("_emdash_entry_locks.collection", "=", collection)
		.where("_emdash_entry_locks.entry_id", "=", entryId)
		.where("_emdash_entry_locks.user_id", "!=", userId)
		.where("_emdash_collections.edit_locking", "!=", 0)
		.where(live)
		.limit(1);
}

export async function isEntryLocked(
	db: EmDashDb,
	collection: string,
	entryId: string,
	userId: string,
): Promise<boolean> {
	return (await foreignLockQuery(db, collection, entryId, userId).executeTakeFirst()) !== undefined;
}
