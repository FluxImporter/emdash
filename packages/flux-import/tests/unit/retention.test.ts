import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { createJob } from "../../src/engine/jobs.js";
import { purgeExpired } from "../../src/plugin/retention.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
const schemaFields = [{ slug: "title", type: "string" }];
const DAY = 24 * 60 * 60 * 1000;

class Purger {
	cutoffs: Date[] = [];
	keeps: ReadonlySet<string>[] = [];
	async purgeBefore(cutoff: Date, keep: ReadonlySet<string> = new Set()) {
		this.cutoffs.push(cutoff);
		this.keeps.push(keep);
		return 2;
	}
}

describe("purgeExpired", () => {
	it("deletes jobs older than the retention period with their records, and keeps links", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\nB,2\n");
		const old = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, old.id, "driver");
		clock.t += 31 * DAY;
		const recent = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, recent.id, "driver");

		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 30);
		expect(result).toEqual({ jobs: 1, records: 2, uploads: 2 });
		expect(await deps.jobs.get(old.id)).toBeNull();
		expect(await deps.jobs.get(recent.id)).not.toBeNull();
		expect((await deps.records.query({ where: { jobId: old.id } })).items).toEqual([]);
		expect((await deps.records.query({ where: { jobId: recent.id } })).items).toHaveLength(2);
		expect(deps.links.rows.size).toBe(2);
		expect(purger.cutoffs[0]!.getTime()).toBe(clock.t - 30 * DAY);
		expect(purger.keeps[0]!.has("u1")).toBe(true);
	});

	it("leaves a job with a live lease for the next run", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await deps.jobs.put(job.id, {
			...job,
			status: "running",
			lease: { holder: "h", expiresAt: clock.t + 60_000 },
		});
		clock.t += 1;
		const purger = new Purger();
		const result = await purgeExpired(deps, purger, 0);
		expect(purger.keeps[0]).toEqual(new Set(["u1"]));
		expect(result.jobs).toBe(0);
		expect(await deps.jobs.get(job.id)).not.toBeNull();
	});

	it("stops deleting a job's records when a round deletes nothing", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", "sku,Name\nA,1\n");
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields });
		await runBatch(deps, job.id, "driver");
		clock.t += 1;
		deps.records.deleteMany = async () => 0;
		let queries = 0;
		const query = deps.records.query.bind(deps.records);
		deps.records.query = (opts) => {
			if (++queries > 5) throw new Error("deleteRecords did not stop");
			return query(opts);
		};
		expect(await purgeExpired(deps, new Purger(), 0)).toMatchObject({ jobs: 1, records: 0 });
		expect(queries).toBe(1);
	});

	it("pages through more records than one query returns", async () => {
		const { deps, clock } = makeDeps();
		let body = "sku,Name\n";
		for (let i = 0; i < 250; i++) body += `S${i},N\n`;
		deps.source.add("u1", body);
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields, batchSize: 500 });
		await runBatch(deps, job.id, "driver");
		clock.t += 1;
		expect(await purgeExpired(deps, new Purger(), 0)).toMatchObject({ jobs: 1, records: 250 });
		expect(deps.records.rows.size).toBe(0);
	});
});
