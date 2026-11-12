import { describe, expect, it } from "vitest";
import { transitionJob } from "../../src/engine/jobs.js";
import { applyTemplate, compileTemplate, templateSchema } from "../../src/engine/template.js";
import type { Job, LinkRow } from "../../src/engine/types.js";
import {
	type Deps,
	entryOf,
	importRows,
	type Row,
	records,
	runToEnd,
	setup,
	start,
} from "./rollback-fixture.js";

const desk: Row = { sku: "A1", name: "Desk", price: 10 };

describe("the key of a record that fails later (M5c, Ruling 24)", () => {
	const compiled = () => {
		const t = templateSchema.parse({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { price: { from: "Price", type: "number" } },
		});
		const c = compileTemplate(t);
		if (!c.ok) throw new Error(c.problems.join("; "));
		return c.compiled;
	};

	it("returns the key with a later mapping's error", async () => {
		expect(await applyTemplate(compiled(), { sku: " A1 ", Price: "n/a" })).toMatchObject({
			ok: false,
			key: "A1",
			errors: [{ field: "price" }],
		});
	});

	it("returns no key when the key itself fails", async () => {
		for (const sku of [undefined, "", "  ", { a: 1 }, "x".repeat(10_000)]) {
			const result = await applyTemplate(compiled(), { sku, Price: "n/a" });
			expect(result.ok).toBe(false);
			expect(result, JSON.stringify(sku)).not.toHaveProperty("key");
		}
	});

	it("saves the key on the failed row", async () => {
		const { deps } = setup();
		const job = await importRows(deps, [{ ...desk, price: "n/a" as never }]);
		expect((await records(deps, job.id))[0]).toMatchObject({ status: "failed", sourceKey: "A1" });
		expect(job).not.toHaveProperty("unkeyed");
	});
});

describe("unkeyed (M5c, Rulings 24 and 25)", () => {
	it("counts reader errors, filter errors and key errors, not failures after the key", async () => {
		const { deps } = setup();
		const body =
			"sku,Name,Price,Featured,Img,Related,Tags,Authors\n" +
			"A1,Desk,10,,,,,\n" + // fine
			",NoKey,1,,,,,\n" + // missing_key
			"B2,Lamp,n/a,,,,,\n" + // fails after its key
			"C3,Short\n"; // column_count: a reader error
		const job = await start(deps, body);
		const done = await runToEnd(deps, job.id);
		expect(done.unkeyed).toBe(2);
		// A retry pass meets the same rows again: they were counted on the first pass.
		await transitionJob(deps, job.id, "retry");
		expect((await runToEnd(deps, job.id)).unkeyed).toBe(2);
		const rows = await records(deps, job.id);
		expect(rows.map((r) => [r.status, r.sourceKey])).toEqual([
			["created", "A1"],
			["failed", null],
			["failed", "B2"],
			["failed", null],
		]);
	});

	it("counts the rows of a batch whose job save was lost again", async () => {
		const { deps } = setup();
		const body =
			"sku,Name,Price,Featured,Img,Related,Tags,Authors\nA1,Desk,10,,,,,\n,NoKey,1,,,,,\n";
		const job = await start(deps, body);
		const done = await runToEnd(deps, job.id);
		expect(done.unkeyed).toBe(1);
		// The rows stay saved, the job as it was before the batch: the rerun meets them again.
		const stored = (await deps.jobs.get(job.id)) as Job;
		const { unkeyed: _lost, ...before } = stored;
		await deps.jobs.put(job.id, {
			...before,
			status: "running",
			cursor: job.cursor,
			counters: job.counters,
		});
		const again = await runToEnd(deps, job.id);
		expect(again.counters).toMatchObject({ created: 1, failed: 1 });
		expect(again.unkeyed).toBe(1);
	});

	it("counts a filter error as unkeyed and a filtered record not at all", async () => {
		const { deps } = setup();
		const body =
			"sku,Name,Price,Featured,Img,Related,Tags,Authors\nA1,Desk,10,,,,,\nB2,Lamp,5,,,,,\n";
		const filtered = await runToEnd(
			deps,
			(
				await start(deps, body, {
					extra: { source: { format: "csv", filter: "$number(Price) > 6" } },
				})
			).id,
		);
		expect(filtered.counters.filtered).toBe(1);
		expect(filtered).not.toHaveProperty("unkeyed");
		// A CSV value is text, so comparing it with a number fails every record (filter_error).
		const broken = await runToEnd(
			deps,
			(await start(deps, body, { extra: { source: { format: "csv", filter: "Price > 6" } } })).id,
		);
		expect(broken.unkeyed).toBe(2);
		expect(broken.counters.failed).toBe(2);
		const codes = (await records(deps, broken.id)).map((r) => r.errors?.[0]?.code);
		expect(codes).toEqual(["filter_error", "filter_error"]);
	});

	it("counts blank CSV lines not at all", async () => {
		const { deps } = setup();
		const body =
			"sku,Name,Price,Featured,Img,Related,Tags,Authors\nA1,Desk,10,,,,,\n\n\nB2,Lamp,5,,,,,\n";
		const job = await runToEnd(deps, (await start(deps, body)).id);
		expect(job.counters.created).toBe(2);
		expect(job).not.toHaveProperty("unkeyed");
	});
});

describe("a key whose entry the import moved to Trash (M5c, Ruling 15)", () => {
	const mark = async (deps: Deps, key: string, action: "trash" | "unpublish") => {
		const id = `products:en:${key}`;
		const link = (await deps.links.get(id)) as LinkRow;
		await deps.links.put(id, {
			...link,
			missing: { jobId: "id00000042", action, at: "2026-10-07T10:00:00.000Z" },
		});
	};

	it("is a conflict, with no read and no create, also in a dry run", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await mark(deps, "A1", "trash");
		await deps.content.trash("products", entryOf(deps, "A1").id);
		deps.content.calls.length = 0;
		// With record rules the link is read early (M5b), so both paths refuse the key.
		for (const [dryRun, rules] of [
			[false, {}],
			[true, {}],
			[false, { rules: { mode: "update" } }],
			[false, { rules: { mode: "upsert" } }],
		] as const) {
			const job = await importRows(deps, [desk], { dryRun, extra: rules });
			const [row] = await records(deps, job.id);
			expect(row).toMatchObject({
				status: "conflict",
				sourceKey: "A1",
				errors: [
					{
						code: "missing_trashed",
						message:
							"Not imported: the import moved this entry to Trash because it was missing from an earlier feed (job id00000042); restore it from Trash, or roll that job back, then retry",
					},
				],
			});
		}
		expect(
			deps.content.calls.filter((c) => c.startsWith("create:") || c.startsWith("find:")),
		).toEqual([]);
	});

	it("imports as usual once the entry is restored by hand, or for an unpublish mark", async () => {
		const { deps } = setup();
		await importRows(deps, [desk, { sku: "B2", name: "Lamp", price: 5 }]);
		await mark(deps, "B2", "unpublish");
		const job = await importRows(deps, [desk, { sku: "B2", name: "Lamp", price: 6 }]);
		expect(job.counters).toMatchObject({ unchanged: 1, updated: 1, conflict: 0 });
		expect(await deps.links.get("products:en:B2")).not.toHaveProperty("missing");
		// A trash mark on an entry an editor restored from Trash: the entry is there again.
		await mark(deps, "A1", "trash");
		const restored = await importRows(deps, [
			{ ...desk, price: 11 },
			{ sku: "B2", name: "Lamp", price: 6 },
		]);
		expect(restored.counters).toMatchObject({ updated: 1, unchanged: 1, conflict: 0 });
		expect(await deps.links.get("products:en:A1")).not.toHaveProperty("missing");
	});

	it("does not refuse a key whose unpublished entry is gone", async () => {
		const { deps } = setup();
		await importRows(deps, [desk]);
		await mark(deps, "A1", "unpublish");
		deps.content.entries.delete(entryOf(deps, "A1").id);
		const job = await importRows(deps, [desk]);
		const [row] = await records(deps, job.id);
		expect(row?.errors ?? []).not.toContainEqual(
			expect.objectContaining({ code: "missing_trashed" }),
		);
		expect(job.counters).toMatchObject({ conflict: 0 });
	});
});
