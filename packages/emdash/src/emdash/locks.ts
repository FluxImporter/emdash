import type { Database } from "emdash";
import { type Kysely, PostgresAdapter, sql } from "kysely";

export type EmDashDb = Kysely<Database>;

/**
 * Same detection as EmDash's own (src/database/dialect-helpers.ts). EmDash 1.6 also checks the
 * class name, because Vite can load a second copy of kysely (Hyperdrive under `astro dev`), and
 * then `instanceof` fails for the other copy's adapter.
 */
export function isPostgres(db: EmDashDb): boolean {
	const adapter = db.getExecutor().adapter;
	return adapter instanceof PostgresAdapter || adapter.constructor.name === "PostgresAdapter";
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

/**
 * EmDash's co-editing rooms (`EmDashRuntime.rooms`, EmDash 1.5 `coEditing: true`): null where
 * co-editing is off or the host can't run rooms.
 */
export type RoomReader = { isOpen(roomId: string): Promise<boolean> } | null | undefined;

/**
 * Whether a co-editing room holds the entry. People editing in a room take no edit lock, and a
 * write from outside merges into the open editors (EmDash 1.5, #4695), so the importer treats an
 * open room as a lock. A room is open while it has connections or unused join tokens, and for
 * 10 s after its last connection closes (src/rooms/room.ts:222-228); the check cannot tell who
 * is in it. The room ID is `roomId` (src/rooms/types.ts:25-27), which EmDash does not export. On
 * Node.js `isOpen` looks up the process's own rooms and, failing that, another process's claim
 * with one query (src/rooms/node/registry.ts:115-118); on Cloudflare it is one call to the
 * entry's Durable Object (`@emdash-cms/cloudflare` src/rooms/host.ts:20).
 */
export async function isRoomOpen(
	rooms: RoomReader,
	collection: string,
	entryId: string,
): Promise<boolean> {
	return rooms != null && (await rooms.isOpen(`${collection}:${entryId}`));
}

/** An entry someone else is editing: a live lease (`isEntryLocked`) or an open room. */
export async function isEntryHeld(
	db: EmDashDb,
	rooms: RoomReader,
	collection: string,
	entryId: string,
	userId: string,
): Promise<boolean> {
	return (
		(await isEntryLocked(db, collection, entryId, userId)) ||
		(await isRoomOpen(rooms, collection, entryId))
	);
}
