import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "flux_source_id", type: "string", translatable: false },
];
const english = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "id" },
	fields: { title: { from: "Name", type: "text" } },
};
const french = (rules: Record<string, unknown>) => ({
	version: 1,
	collection: "products",
	locale: "fr",
	key: { from: "id" },
	translationOf: { from: "en_id", locale: "en" },
	fields: { title: { from: "Nom", type: "text" } },
	rules,
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
		await run(deps, english, "id,Name\nE1,Desk\n");
		const first = await run(deps, french({ mode: "create" }), "id,en_id,Nom\nF1,E1,Bureau\n");
		expect(first.job.counters).toMatchObject({ created: 1 });
		deps.content.calls.length = 0;
		const second = await run(deps, french({ mode: "create" }), "id,en_id,Nom\nF1,E1,Table\n");
		expect(second.rows[0]).toMatchObject({ status: "unchanged", warnings: [{ code: "exists" }] });
		expect(deps.content.calls.some((c) => c.startsWith("translations:"))).toBe(false);
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
