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
import { foreignLockQuery, isEntryLocked, isPostgres } from "../../src/emdash/locks.js";

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
