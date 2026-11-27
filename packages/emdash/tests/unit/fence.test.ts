import type { Database } from "emdash";
import {
	type CompiledQuery,
	type DatabaseConnection,
	type Driver,
	Kysely,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import { readFence } from "../../src/emdash/fence.js";

/** A database whose every query is answered by `answer` (rows, or a thrown error). */
function fakeDb(answer: (sql: string, n: number) => unknown[]) {
	const queries: CompiledQuery[] = [];
	const connection: DatabaseConnection = {
		executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
			queries.push(query);
			return { rows: answer(query.sql, queries.length) as R[] };
		},
		streamQuery: () => {
			throw new Error("not used");
		},
	};
	const driver: Driver = {
		init: async () => {},
		acquireConnection: async () => connection,
		beginTransaction: async () => {},
		commitTransaction: async () => {},
		rollbackTransaction: async () => {},
		releaseConnection: async () => {},
		destroy: async () => {},
	};
	const db = new Kysely<Database>({
		dialect: {
			createAdapter: () => new SqliteAdapter(),
			createDriver: () => driver,
			createIntrospector: (k) => new SqliteIntrospector(k),
			createQueryCompiler: () => new SqliteQueryCompiler(),
		},
	});
	return { db, queries };
}

const none = { media_state: null, import_id: null, export_id: null };
const missing = (table: string) => new Error(`no such table: ${table}`);

describe('readFence (spec "Site fence", Fact V4)', () => {
	it.each([
		["clear", none],
		["import", { ...none, import_id: "op1" }],
		["export", { ...none, export_id: "op2" }],
		["media", { ...none, media_state: "activating" }],
		["clear", { ...none, media_state: "done" }],
	] as const)("reads %s from EmDash's single query", async (fence, row) => {
		const { db } = fakeDb(() => [row]);
		expect(await readFence(db)).toBe(fence);
	});

	it("runs EmDash's readSiteWriteFence query, with no parameters", async () => {
		const { db, queries } = fakeDb(() => [none]);
		await readFence(db);
		expect(queries).toHaveLength(1);
		const sql = queries[0]?.sql ?? "";
		expect(sql).toContain("WHERE task_key = 'incremental_capture'");
		expect(sql).toContain("state IN ('running', 'verifying')");
		expect(sql).toContain(
			"OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL)",
		);
		expect(sql).toContain("WHERE kind = 'export' AND state = 'running'");
		expect(queries[0]?.parameters).toEqual([]);
	});

	it("falls back to the media fence alone when the transfer table is missing", async () => {
		const transfer = missing("_emdash_transfer_operations");
		const activating = fakeDb((_sql, n) => {
			if (n === 1) throw transfer;
			return [{ state: "activating" }];
		});
		expect(await readFence(activating.db)).toBe("media");
		const quiet = fakeDb((_sql, n) => {
			if (n === 1) throw transfer;
			return [];
		});
		expect(await readFence(quiet.db)).toBe("clear");
		const fresh = fakeDb((_sql, n) => {
			throw n === 1 ? transfer : missing("_emdash_media_usage_activation");
		});
		expect(await readFence(fresh.db)).toBe("clear");
		// The media read failing for another reason is fenced, as EmDash's own fallback.
		const broken = fakeDb((_sql, n) => {
			throw n === 1 ? transfer : new Error("disk I/O error");
		});
		expect(await readFence(broken.db)).toBe("error");
	});

	it("counts a read error as fenced, and reads PostgreSQL's missing relation as missing", async () => {
		const broken = fakeDb(() => {
			throw new Error("disk I/O error");
		});
		expect(await readFence(broken.db)).toBe("error");
		const postgres = fakeDb((_sql, n) => {
			if (n === 1) throw new Error('relation "_emdash_transfer_operations" does not exist');
			return [];
		});
		expect(await readFence(postgres.db)).toBe("clear");
		// EmDash compares in lower case, so MySQL's capitalised wording is a missing table too.
		const mysql = fakeDb((_sql, n) => {
			if (n === 1) throw new Error("Table 'site._emdash_transfer_operations' doesn't exist");
			return [];
		});
		expect(await readFence(mysql.db)).toBe("clear");
		// A missing column is not a missing table: fenced.
		const column = fakeDb(() => {
			throw new Error('column "mutation_started_at" does not exist');
		});
		expect(await readFence(column.db)).toBe("error");
	});
});
