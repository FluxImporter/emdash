import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { RecordRow } from "../../src/engine/types.js";
import type { ApplyResult } from "../../src/plugin/schema-apply.js";
import { TYPES_CSV, TYPES_CSV_STORED, TYPES_JSON, typesTemplate } from "../fixtures/field-types.js";
import { Client } from "./client.js";

const client = new Client(inject("baseUrl"), inject("token"));
const COLLECTION = "it_types";

async function importText(body: string, filename: string, template: object, dryRun = false) {
	const { uploadId } = await client.upload(body, filename);
	const job = await client.plugin("jobs/create", { uploadId, template, dryRun, batchSize: 10 });
	return client.runToEnd(job.id);
}

const byKey = async () =>
	new Map((await client.listAll(COLLECTION)).map((e) => [e.data.flux_source_id as string, e.data]));

describe("M4a field types end to end", () => {
	let timezone: string | undefined;

	beforeAll(async () => {
		const settings = await client.api<{ timezone?: string }>("GET", "/_emdash/api/settings");
		timezone = settings.timezone;
		await client.api("POST", "/_emdash/api/settings", { timezone: "Europe/Chisinau" });
	});

	afterAll(async () => {
		await client.api("POST", "/_emdash/api/settings", { timezone: timezone ?? "UTC" });
	});

	it("creates the fields from a template with schema/apply, leaving a conflicting field alone", async () => {
		await client.createCollection(COLLECTION);
		// schema/apply never creates a required field, and EmDash refuses to make an existing field
		// required without a content migration: an editor creates this one in the admin.
		await client.api("POST", `/_emdash/api/schema/collections/${COLLECTION}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			validation: { maxLength: 40 },
		});
		const integer = await client.plugin<ApplyResult>("schema/apply", {
			collection: COLLECTION,
			fields: [{ slug: "stock", type: "integer" }],
		});
		expect(integer.changes).toEqual([{ field: "stock", action: "create", type: "integer" }]);

		const template = typesTemplate(COLLECTION);
		const dry = await client.plugin<ApplyResult>("schema/apply", { template, dryRun: true });
		expect(dry.applied).toEqual([]);
		expect(await client.fieldSlugs(COLLECTION)).toEqual(["title", "stock"]);

		const applied = await client.plugin<ApplyResult>("schema/apply", { template });
		// A number mapping can fill an integer field, so template mode may plan "stock" as
		// unchanged or as a conflict; either way it is left alone.
		expect(applied.changes.find((c) => c.field === "stock")?.action).toMatch(
			/^(unchanged|conflict)$/,
		);
		expect(applied.changes.filter((c) => c.field !== "stock")).toEqual([
			{ field: "title", action: "unchanged", type: "string" },
			{ field: "code", action: "create", type: "string" },
			{ field: "price", action: "create", type: "number" },
			{ field: "featured", action: "create", type: "boolean" },
			{ field: "stage", action: "create", type: "select", options: ["live", "draft", "hidden"] },
			{
				field: "colours",
				action: "create",
				type: "multiSelect",
				options: ["red", "green", "blue"],
			},
			{ field: "released", action: "create", type: "datetime" },
			{ field: "sold_on", action: "create", type: "datetime" },
			{ field: "launch_day", action: "create", type: "string" },
			{ field: "specs", action: "create", type: "json" },
			{ field: "legacy", action: "create", type: "slug" },
		]);
		expect(applied.applied).toHaveLength(10);
		expect(applied.error).toBeNull();
		const fields = await client.fields(COLLECTION);
		expect(fields.find((f) => f.slug === "stock")?.type).toBe("integer");
		// The conflict case, in explicit fields mode, where types must match exactly.
		const conflict = await client.plugin<ApplyResult>("schema/apply", {
			collection: COLLECTION,
			fields: [{ slug: "stock", type: "string" }],
		});
		expect(conflict.changes).toEqual([
			{
				field: "stock",
				action: "conflict",
				type: "string",
				message: 'Field "stock" is "integer"; requested "string"',
			},
		]);
		expect(conflict.applied).toEqual([]);
		expect(fields.find((f) => f.slug === "stage")?.validation).toEqual({
			options: ["live", "draft", "hidden"],
		});

		// Rules schema/apply never sets, set through the admin API as an editor would.
		await client.updateField(COLLECTION, "code", { validation: { pattern: "^[A-Z]{3}-\\d+$" } });
		await client.updateField(COLLECTION, "price", { validation: { min: 0, max: 100000 } });

		const again = await client.plugin<ApplyResult>("schema/apply", { template });
		expect(again.applied).toEqual([]);
		expect(again.changes.filter((c) => c.action !== "unchanged").map((c) => c.field)).toEqual([
			"stock",
		]);
	});

	it("imports CSV text into every type, reads it back exactly, and re-runs as unchanged", async () => {
		const template = typesTemplate(COLLECTION);
		const done = await importText(TYPES_CSV, "types.csv", template);
		expect(done).toMatchObject({
			status: "completed",
			siteTimezone: "Europe/Chisinau",
			counters: { created: 3, failed: 0 },
			targetFields: {
				title: { type: "string", required: true, maxLength: 40 },
				stock: { type: "integer", required: false },
				price: { type: "number", required: false, min: 0, max: 100000 },
				stage: { type: "select", required: false, options: ["live", "draft", "hidden"] },
			},
		});
		const stored = await byKey();
		for (const [key, expected] of Object.entries(TYPES_CSV_STORED)) {
			expect(stored.get(key), key).toMatchObject(expected);
		}
		const rerun = await importText(TYPES_CSV, "types.csv", template);
		expect(rerun.counters).toMatchObject({ created: 0, updated: 0, unchanged: 3, failed: 0 });
	});

	it("imports typed JSON values, and re-runs as unchanged", async () => {
		const template = typesTemplate(COLLECTION, "json");
		const done = await importText(TYPES_JSON, "types.json", template);
		expect(done.counters).toMatchObject({ created: 2, failed: 0 });
		const stored = await byKey();
		expect(stored.get("J1")).toMatchObject({
			price: 1500.25,
			stock: 7,
			featured: 1,
			stage: "live",
			colours: ["green", "red"],
			released: "2025-05-05T05:00:00.000Z",
			sold_on: "2025-05-05T08:00:00.000Z",
			launch_day: "2025-05-05",
			specs: { d: { x: 1 }, tags: ["oak", "ash"] },
			legacy: "shelf-big",
		});
		expect(stored.get("J2")).toMatchObject({ featured: 0, specs: { note: "parsed" } });
		expect(stored.get("J2")?.colours ?? null).toBeNull();
		const rerun = await importText(TYPES_JSON, "types.json", template);
		expect(rerun.counters).toMatchObject({ unchanged: 2, updated: 0, failed: 0 });
	});

	it("reports invalid_option, invalid_integer, required and a DST gap in a dry run without writing", async () => {
		const before = (await client.listAll(COLLECTION)).length;
		const csv = [
			"sku,Name,Code,Price,Stock,Featured,Stage,Colours,Released,SoldAt,Launch,Specs,Handle",
			"D1,Desk,ABC-1,1,1,ja,Archived,red,01.01.2025 10:00,0,2025-01-01,,d1",
			"D2,Desk,ABC-1,1,2.5,ja,live,red|pink,01.01.2025 10:00,0,2025-01-01,,d2",
			"D3,,ABC-1,1,1,ja,live,,29.03.2026 03:30,0,2025-01-01,,d3",
			"D4,Desk,abc,-1,1,vielleicht,live,,01.01.2025 10:00,0,2025-01-01,{,d4",
			"",
		].join("\n");
		const done = await importText(csv, "bad.csv", typesTemplate(COLLECTION), true);
		expect(done.counters).toMatchObject({ failed: 4, created: 0 });
		const rows = await client.records(done.id, "failed");
		const codes = (row: RecordRow | undefined) => row?.errors?.map((e) => [e.field, e.code]);
		expect(rows.map(codes)).toEqual([
			[["stage", "invalid_option"]],
			[
				["stock", "invalid_integer"],
				["colours", "invalid_option"],
			],
			[
				["title", "required"],
				["released", "invalid_date"],
			],
			[
				["code", "pattern_mismatch"],
				["price", "out_of_range"],
				["featured", "invalid_boolean"],
				["specs", "invalid_json"],
			],
		]);
		expect((await client.listAll(COLLECTION)).length).toBe(before);
	});

	it("adds a select option with schema/apply and then imports a value that uses it", async () => {
		const request = {
			collection: COLLECTION,
			fields: [{ slug: "stage", type: "select", options: ["archived"] }],
		};
		const refused = await client.plugin<ApplyResult>("schema/apply", request);
		expect(refused.changes).toEqual([
			{
				field: "stage",
				action: "conflict",
				type: "select",
				message: 'Field "stage" lacks the options "archived"; set addOptions to add them',
			},
		]);
		const added = await client.plugin<ApplyResult>("schema/apply", {
			...request,
			addOptions: true,
		});
		expect(added).toMatchObject({
			changes: [{ field: "stage", action: "add_options", options: ["archived"] }],
			applied: ["stage"],
		});
		const csv = [
			"sku,Name,Code,Price,Stock,Featured,Stage,Colours,Released,SoldAt,Launch,Specs,Handle",
			"A1,Archive box,ABC-7,5,1,nein,ARCHIVED,,01.01.2025 10:00,0,2025-01-01,,a1",
			"",
		].join("\n");
		const done = await importText(csv, "archived.csv", typesTemplate(COLLECTION));
		expect(done.counters).toMatchObject({ created: 1, failed: 0 });
		expect((await byKey()).get("A1")).toMatchObject({
			stage: "archived",
			released: "2025-01-01T08:00:00.000Z",
		});
	});
});
