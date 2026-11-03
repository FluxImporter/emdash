import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
	{ slug: "sku", type: "string", translatable: false },
	{ slug: "flux_source_id", type: "string", translatable: false },
];
const english = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "Name", type: "text" } },
};
const french = (rules: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	fields: { title: { from: "Nom", type: "text" } },
	rules,
	...extra,
});

async function run(
	deps: Deps,
	template: unknown,
	csv: string,
): Promise<{ job: Job; rows: RecordRow[] }> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, csv);
	const created = await createJob(deps, {
		uploadId: upload,
		template,
		schemaFields,
		linkSchema: { targets: { products: schemaFields } },
	});
	let job = created;
	for (let i = 0; i < 100 && (job.status === "created" || job.status === "running"); i++) {
		job = await runBatch(deps, created.id, "driver");
	}
	const page = await deps.records.query({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
	return { job, rows: page.items.map((i) => i.data) };
}

describe("write modes on linked records (M5b, M4e)", () => {
	it("skips a linked record without an entry in update mode, before the source lookup", async () => {
		const { deps } = makeDeps();
		await run(deps, english, "id,Name\nE1,Desk\n");
		deps.content.calls.length = 0;
		const { rows } = await run(
			deps,
			french({ mode: "update" }),
			"id,en_id,Nom\nF1,E1,Bureau\nF2,E9,Lampe\n",
		);
		expect(rows.map((r) => [r.status, r.warnings?.map((w) => w.code)])).toEqual([
			["unchanged", ["not_found"]],
			["unchanged", ["not_found"]],
		]);
		// Neither the source nor its translations were read.
		expect(deps.content.calls).toEqual([]);
	});

	it("creates a translation in create mode, then skips it as existing", async () => {
		const { deps } = makeDeps();
		deps.lookups.addByline("alex", "Alex", "fr");
		const credited = french({ mode: "create" }, { bylines: { from: "Auteurs" } });
		await run(deps, english, "id,Name\nE1,Desk\n");
		const first = await run(deps, credited, "id,en_id,Nom,Auteurs\nF1,E1,Bureau,alex\n");
		expect(first.job.counters).toMatchObject({ created: 1 });
		deps.content.calls.length = 0;
		deps.lookups.calls.length = 0;
		const second = await run(deps, credited, "id,en_id,Nom,Auteurs\nF1,E1,Table,alex\n");
		expect(second.rows[0]).toMatchObject({ status: "unchanged", warnings: [{ code: "exists" }] });
		expect(deps.content.calls.some((c) => c.startsWith("translations:"))).toBe(false);
		// The skip came before the bylines and the source were looked up.
		expect(deps.lookups.calls.filter((c) => c.startsWith("find:"))).toEqual([]);
		expect(deps.lookups.calls.filter((c) => c.startsWith("bylines:"))).toEqual([]);
	});

	it("keeps a translation's shared mappings and the unlisted ones out of the write", async () => {
		const { deps } = makeDeps();
		deps.content.sharedFields.add("sku");
		const fields = { title: { from: "Name", type: "text" }, sku: { from: "SKU", type: "text" } };
		await run(deps, { ...english, fields }, "id,Name,SKU\nE1,Desk,S1\n");
		const priced = (rules: Record<string, unknown>) =>
			french(rules, {
				fields: {
					title: { from: "Nom", type: "text" },
					price: { from: "Prix", type: "number" },
					sku: { from: "SKU", type: "text" },
				},
			});
		const header = "id,en_id,Nom,Prix,SKU\n";
		const created = await run(deps, priced({}), `${header}F1,E1,Bureau,1,S2\n`);
		expect(created.rows[0]).toMatchObject({ status: "created" });
		const { rows } = await run(
			deps,
			priced({ updateFields: ["title"] }),
			`${header}F1,E1,Table,2,S3\n`,
		);
		expect(rows[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "title", after: "Table" }],
		});
		expect(rows[0]?.changes).toHaveLength(1);
		const fr = [...deps.content.entries.values()].find((e) => e.locale === "fr");
		expect(fr?.data).toMatchObject({ title: "Table", price: 1, sku: "S1" });
	});

	it("updates an existing translation in update mode as an upsert would", async () => {
		const { deps } = makeDeps();
		await run(deps, english, "id,Name\nE1,Desk\n");
		await run(deps, french({}), "id,en_id,Nom\nF1,E1,Bureau\n");
		const { rows } = await run(deps, french({ mode: "update" }), "id,en_id,Nom\nF1,E1,Table\n");
		expect(rows[0]).toMatchObject({
			status: "updated",
			changes: [{ field: "title", after: "Table" }],
		});
	});
});
