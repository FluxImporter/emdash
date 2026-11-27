import type { Database } from "emdash";
import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import { NO_USER } from "../../src/emdash/content.js";
import {
	foreignLockQuery,
	isEntryHeld,
	isEntryLocked,
	isPostgres,
	isRoomOpen,
} from "../../src/emdash/locks.js";

function dummyDb(dialect: "sqlite" | "postgres"): Kysely<Database> {
	return new Kysely<Database>({
		dialect:
			dialect === "postgres"
				? {
						createAdapter: () => new PostgresAdapter(),
						createDriver: () => new DummyDriver(),
						createIntrospector: (db) => new PostgresIntrospector(db),
						createQueryCompiler: () => new PostgresQueryCompiler(),
					}
				: {
						createAdapter: () => new SqliteAdapter(),
						createDriver: () => new DummyDriver(),
						createIntrospector: (db) => new SqliteIntrospector(db),
						createQueryCompiler: () => new SqliteQueryCompiler(),
					},
	});
}

describe("foreignLockQuery", () => {
	it("compares with the sentinel user, which owns no lease (spec Ruling 5)", () => {
		const { parameters } = foreignLockQuery(dummyDb("sqlite"), "products", "e1", NO_USER).compile();
		expect(parameters).toEqual(["products", "e1", "", 0, 1]);
	});

	it("compares expiry to the SQLite clock and excludes the importing user", () => {
		const db = dummyDb("sqlite");
		expect(isPostgres(db)).toBe(false);
		const { sql, parameters } = foreignLockQuery(db, "products", "e1", "u1").compile();
		expect(sql).toContain(
			`"_emdash_entry_locks"."expires_at" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		);
		expect(sql).toContain(`inner join "_emdash_collections"`);
		expect(sql).toContain(`"_emdash_entry_locks"."user_id" != ?`);
		expect(sql).toContain(`"_emdash_collections"."edit_locking" != ?`);
		expect(parameters).toEqual(["products", "e1", "u1", 0, 1]);
	});

	it("uses the Postgres clock form on Postgres", () => {
		const db = dummyDb("postgres");
		expect(isPostgres(db)).toBe(true);
		const { sql } = foreignLockQuery(db, "products", "e1", "u1").compile();
		expect(sql).toContain(`"_emdash_entry_locks"."expires_at"::timestamptz > clock_timestamp()`);
	});

	it("reports unlocked when no row comes back", async () => {
		expect(await isEntryLocked(dummyDb("sqlite"), "products", "e1", "u1")).toBe(false);
	});
});

describe("co-editing rooms (EmDash 1.5)", () => {
	const rooms = (open: string[]) => {
		const asked: string[] = [];
		return {
			asked,
			reader: {
				isOpen: async (id: string) => {
					asked.push(id);
					return open.includes(id);
				},
			},
		};
	};

	it("asks for the room by EmDash's room ID, collection and entry ID", async () => {
		const r = rooms(["products:e1"]);
		expect(await isRoomOpen(r.reader, "products", "e1")).toBe(true);
		expect(await isRoomOpen(r.reader, "products", "e2")).toBe(false);
		expect(r.asked).toEqual(["products:e1", "products:e2"]);
	});

	it("finds no room where co-editing is off", async () => {
		expect(await isRoomOpen(null, "products", "e1")).toBe(false);
	});

	it("holds an entry with an open room, whoever is in it, though no lease is live", async () => {
		const db = dummyDb("sqlite");
		const r = rooms(["products:e1"]);
		expect(await isEntryHeld(db, r.reader, "products", "e1", "u1")).toBe(true);
		expect(await isEntryHeld(db, r.reader, "products", "e2", "u1")).toBe(false);
		expect(await isEntryHeld(db, null, "products", "e1", "u1")).toBe(false);
	});
});
