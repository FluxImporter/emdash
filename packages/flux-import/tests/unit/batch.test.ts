import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, runBatch } from "../../src/engine/batch.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { Job } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	slug: { from: "Name" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
};
const schemaFields = [
	{ slug: "title", type: "string" },
	{ slug: "price", type: "number" },
];

function csv(n: number, price = (i: number) => String(i)): string {
	let out = "sku,Name,Price\n";
	for (let i = 0; i < n; i++) out += `S${i},Item ${i},${price(i)}\n`;
	return out;
}

async function setup(body: string, opts: { dryRun?: boolean; batchSize?: number } = {}) {
	const { deps, clock } = makeDeps();
	deps.source.add("u1", body);
	const job = await createJob(deps, { uploadId: "u1", template, schemaFields, ...opts });
	return { deps, clock, job };
}

async function runToEnd(deps: Parameters<typeof runBatch>[0], id: string): Promise<Job> {
	for (let i = 0; i < 10_000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

describe("runBatch", () => {
	it("imports every record in batches and completes", async () => {
		const { deps, job } = await setup(csv(25), { batchSize: 10 });
		const first = await runBatch(deps, job.id, "driver");
		expect(first).toMatchObject({
			status: "running",
			cursor: { seq: 10 },
			lease: null,
			schemaReady: true,
		});
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ created: 25, failed: 0 });
		expect(deps.content.entries.size).toBe(25);
		expect(deps.content.sourceFieldEnsured).toBe(true);
		const e = [...deps.content.entries.values()][0]!;
		expect(e).toMatchObject({
			slug: "item-0",
			data: { title: "Item 0", price: 0, flux_source_id: "S0" },
		});
	});

	it("updates changed entries and leaves identical ones alone on a second run", async () => {
		const { deps, job } = await setup(csv(3));
		await runToEnd(deps, job.id);
		deps.source.add(
			"u2",
			csv(3, (i) => (i === 1 ? "99" : String(i))),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
		expect(deps.content.entries.size).toBe(3);
	});

	it("stops at the time budget between records", async () => {
		const { deps, clock, job } = await setup(csv(10));
		deps.content.afterWrite = () => {
			clock.t += 1500;
		};
		const after = await runBatch(deps, job.id, "driver");
		expect(after.cursor.seq).toBe(3); // 1500, 3000, 4500 >= 4000
	});

	it("dry-run plans without writing anything", async () => {
		const { deps, job } = await setup(csv(3), { dryRun: true });
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 3 });
		expect(deps.content.entries.size).toBe(0);
		expect(deps.content.sourceFieldEnsured).toBe(false);
		const rows = await deps.records.query({ where: { jobId: job.id } });
		expect(rows.items.every((r) => r.data.status === "planned" && r.data.action === "create")).toBe(
			true,
		);
	});

	it("logs bad records and keeps going", async () => {
		const body =
			"sku,Name,Price\nS0,Ok,1\n,No key,2\nS2,Bad price,abc\nS3,Short\nS4,Rejected,4\nS5,Ok,5\n";
		const { deps, job } = await setup(body);
		deps.content.failWrite = (data) =>
			data.flux_source_id === "S4" ? new ContentWriteError("validation", "Title too long") : null;
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ created: 2, failed: 4 });
		const rows = (
			await deps.records.query({ where: { jobId: job.id }, orderBy: { seq: "asc" } })
		).items.map((r) => r.data);
		expect(rows.map((r) => [r.status, r.errors?.[0]?.code])).toEqual([
			["created", undefined],
			["failed", "missing_key"],
			["failed", "invalid_number"],
			["failed", "column_count"],
			["failed", "validation"],
			["created", undefined],
		]);
	});

	it("skips locked entries and records rev conflicts", async () => {
		const { deps, job } = await setup(csv(2));
		await runToEnd(deps, job.id);
		const [e0, e1] = [...deps.content.entries.values()];
		deps.content.locked.add(e0!.id);
		e1!.rev = 99; // changed by an editor after our read would be a conflict; simulate a stale rev
		const realGet = deps.content.get.bind(deps.content);
		deps.content.get = async (c, l, id) => {
			const snap = await realGet(c, l, id);
			return snap && id === e1!.id ? { ...snap, rev: "1" } : snap;
		};
		deps.source.add(
			"u2",
			csv(2, () => "7"),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ locked: 1, conflict: 1, updated: 0 });
	});

	it("fails the job when the upload disappears or the CSV breaks mid-file", async () => {
		const { deps, job } = await setup(csv(2));
		deps.source.uploads.delete("u1");
		expect(await runBatch(deps, job.id, "driver")).toMatchObject({
			status: "failed",
			error: { code: "source_missing" },
		});

		const broken = await setup('sku,Name,Price\nS0,Ok,1\nS1,"open,2\n');
		const out = await runToEnd(broken.deps, broken.job.id);
		expect(out).toMatchObject({
			status: "failed",
			error: { code: "csv_syntax" },
			counters: { created: 1 },
			// The cursor stays at the end of the last good record ("sku,Name,Price\nS0,Ok,1\n").
			cursor: { offset: 23, seq: 1 },
		});
	});

	it("does nothing for paused, cancelled or completed jobs", async () => {
		const { deps, job } = await setup(csv(2));
		await deps.jobs.put(job.id, { ...job, status: "paused" });
		expect((await runBatch(deps, job.id, "driver")).status).toBe("paused");
		expect(deps.content.entries.size).toBe(0);
	});

	it("keeps a pause made during the batch", async () => {
		const { deps, job } = await setup(csv(3));
		deps.content.afterWrite = () => {
			const stored = deps.jobs.rows.get(job.id)!;
			stored.value = { ...stored.value, status: "paused" };
			stored.revision += 1000;
		};
		const after = await runBatch(deps, job.id, "driver");
		expect(after).toMatchObject({ status: "paused", lease: null, cursor: { seq: 3 } });
	});

	it("never lets two drivers process the same batch", async () => {
		const { deps, job } = await setup(csv(20), { batchSize: 5 });
		await Promise.all([
			runBatch(deps, job.id, "a"),
			runBatch(deps, job.id, "b"),
			runBatch(deps, job.id, "c"),
		]);
		const creates = deps.content.calls.filter((c) => c.startsWith("create:"));
		expect(creates.length).toBe(5);
		const done = await runToEnd(deps, job.id);
		expect(done.counters.created).toBe(20);
		expect(deps.content.entries.size).toBe(20);
	});

	it("respects a live lease held by another driver and takes over an expired one", async () => {
		const { deps, clock, job } = await setup(csv(2));
		await deps.jobs.put(job.id, {
			...job,
			status: "running",
			lease: { holder: "other", expiresAt: clock.t + 1000 },
		});
		expect((await runBatch(deps, job.id, "driver")).cursor.seq).toBe(0);
		clock.t += 1001;
		expect((await runBatch(deps, job.id, "driver")).status).toBe("completed");
	});

	it("does not duplicate entries after a crash between the content write and the record save", async () => {
		const { deps, clock, job } = await setup(csv(10), { batchSize: 10 });
		let crashOn: string | null = "e4";
		deps.content.afterWrite = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		// The lease is still held by the dead driver; wait for it to expire.
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(deps.content.entries.size).toBe(10);
		const keys = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(new Set(keys).size).toBe(10);
		expect(done.counters).toMatchObject({ created: 9, conflict: 1, unchanged: 0 });
		expect(deps.content.calls).toContain("find:S3");
		// The crash came before the written revision was saved, so the repair cannot prove the
		// draft is ours and leaves it unpublished.
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 3 } })).items[0]!.data;
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "publish_unverified" }] });
		expect(deps.content.calls).not.toContain("publish:e4");
		expect(deps.content.entries.get("e4")!.pendingPublish).toBe(true);
	});

	async function crashBeforePublish() {
		const ctx = await setup(csv(10), { batchSize: 10 });
		let crashOn: string | null = "e4";
		ctx.deps.content.beforePublish = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(ctx.deps, ctx.job.id, "first")).rejects.toThrow("process killed");
		ctx.clock.t += ctx.job.budgetMs + LEASE_GRACE_MS + 1;
		return ctx;
	}

	it("publishes the revision it wrote after a crash between the write and the publish", async () => {
		const { deps, job } = await crashBeforePublish();
		const done = await runToEnd(deps, job.id);
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ created: 10, conflict: 0 });
		expect(deps.content.calls).toContain("publish:e4");
		expect(deps.content.entries.size).toBe(10);
		const keys = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(new Set(keys).size).toBe(10);
		expect([...deps.content.entries.values()].every((e) => !e.pendingPublish)).toBe(true);
	});

	it("does not publish an editor's change while repairing a crash", async () => {
		const { deps, job } = await crashBeforePublish();
		// An editor edits a field the template does not map, so the plan still says unchanged.
		const e4 = deps.content.entries.get("e4")!;
		e4.rev++;
		e4.data = { ...e4.data, notes: "editor draft" };
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 9, conflict: 1 });
		expect(deps.content.calls).not.toContain("publish:e4");
		expect(deps.content.entries.get("e4")!.pendingPublish).toBe(true);
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 3 } })).items[0]!.data;
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "publish_unverified" }] });
	});

	it("does not let the same holder claim its own live lease", async () => {
		const { deps, clock, job } = await setup(csv(2));
		await deps.jobs.put(job.id, {
			...job,
			status: "running",
			lease: { holder: "driver", expiresAt: clock.t + 1000 },
		});
		expect((await runBatch(deps, job.id, "driver")).cursor.seq).toBe(0);
		expect(deps.content.calls.some((c) => c.startsWith("create:"))).toBe(false);
	});

	it("publishes every entry it writes by default", async () => {
		const { deps, job } = await setup(csv(3));
		await runToEnd(deps, job.id);
		expect(deps.content.calls.filter((c) => c.startsWith("publish:")).length).toBe(3);
		expect([...deps.content.entries.values()].every((e) => !e.pendingPublish)).toBe(true);
	});

	it("leaves entries as drafts when publish is false", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(3));
		const job = await createJob(deps, { uploadId: "u1", template, schemaFields, publish: false });
		const done = await runToEnd(deps, job.id);
		expect(done.counters.created).toBe(3);
		expect(deps.content.calls.some((c) => c.startsWith("publish:"))).toBe(false);
		expect([...deps.content.entries.values()].every((e) => e.pendingPublish)).toBe(true);
	});

	it("records a failed publish and never publishes someone else's draft", async () => {
		const { deps, job } = await setup(csv(2));
		deps.content.failPublish = (id) => (id === "e2" ? "conflict" : null);
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 1, conflict: 1 });
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 1 } })).items[0]!.data;
		expect(row).toMatchObject({
			status: "conflict",
			action: "create",
			errors: [{ code: "publish_conflict" }],
		});

		// An editor starts a draft on e1; a later import with identical data must not publish it.
		deps.content.failPublish = () => null;
		const e1 = deps.content.entries.get("e1")!;
		e1.pendingPublish = true;
		e1.rev++; // an editor's draft is a new revision
		deps.source.add("u2", csv(2));
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		await runToEnd(deps, second.id);
		expect(deps.content.entries.get("e1")!.pendingPublish).toBe(true);
	});

	it("does not overwrite or publish an editor's pending draft (pending_draft)", async () => {
		const { deps, job } = await setup(csv(2));
		await runToEnd(deps, job.id);
		const e1 = deps.content.entries.get("e1")!;
		e1.rev++;
		e1.pendingPublish = true;
		e1.data = { ...e1.data, title: "Editor title" };
		const callsBefore = deps.content.calls.length;
		deps.source.add(
			"u2",
			csv(2, () => "7"),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ conflict: 1, updated: 1 });
		const row = (await deps.records.query({ where: { jobId: second.id, seq: 0 } })).items[0]!.data;
		expect(row).toMatchObject({
			status: "conflict",
			errors: [{ code: "pending_draft" }],
		});
		const calls = deps.content.calls.slice(callsBefore);
		expect(calls).not.toContain("update:e1");
		expect(calls).not.toContain("publish:e1");
		expect(calls).toEqual(["update:e2", "publish:e2"]);
		expect(deps.content.entries.get("e1")).toMatchObject({
			pendingPublish: true,
			data: { title: "Editor title", price: 0 },
		});
	});

	it("publishes its own drafts from a publish: false run when re-run with identical data", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(3));
		const draftJob = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			publish: false,
		});
		await runToEnd(deps, draftJob.id);
		expect([...deps.content.entries.values()].every((e) => e.pendingPublish)).toBe(true);
		const second = await createJob(deps, { uploadId: "u1", template, schemaFields });
		const done = await runToEnd(deps, second.id);
		expect(done.counters).toMatchObject({ updated: 3, unchanged: 0, conflict: 0 });
		expect(deps.content.calls.filter((c) => c.startsWith("publish:")).length).toBe(3);
		expect([...deps.content.entries.values()].every((e) => !e.pendingPublish)).toBe(true);
		const rows = await deps.records.query({ where: { jobId: second.id } });
		expect(rows.items.every((r) => r.data.status === "updated" && r.data.action === "update")).toBe(
			true,
		);
		const link = await deps.links.get("products:en:S0");
		expect(link?.writtenRev).toBe(String(deps.content.entries.get("e1")!.rev));
	});

	it("explains conflict and locked rows from the write and the lock check", async () => {
		const { deps, job } = await setup(csv(2));
		await runToEnd(deps, job.id);
		const [e0, e1] = [...deps.content.entries.values()];
		deps.content.locked.add(e0!.id);
		const realGet = deps.content.get.bind(deps.content);
		deps.content.get = async (c, l, id) => {
			const snap = await realGet(c, l, id);
			return snap && id === e1!.id ? { ...snap, rev: "stale" } : snap;
		};
		deps.source.add(
			"u2",
			csv(2, () => "7"),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		await runToEnd(deps, second.id);
		const rows = (
			await deps.records.query({ where: { jobId: second.id }, orderBy: { seq: "asc" } })
		).items.map((r) => r.data);
		expect(rows).toMatchObject([
			{
				status: "locked",
				errors: [{ code: "locked", message: "Not imported: the entry is being edited (locked)" }],
			},
			{
				status: "conflict",
				errors: [
					{
						code: "rev_conflict",
						message: "Not imported: the entry changed since it was read; retry to re-apply",
					},
				],
			},
		]);
	});

	async function crashDuringUpdate(hook: "afterWrite" | "beforePublish") {
		const ctx = await setup(csv(3));
		await runToEnd(ctx.deps, ctx.job.id);
		ctx.deps.source.add(
			"u2",
			csv(3, (i) => (i === 1 ? "99" : String(i))),
		);
		const second = await createJob(ctx.deps, { uploadId: "u2", template, schemaFields });
		let crashOn: string | null = "e2";
		ctx.deps.content[hook] = (id: string) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(ctx.deps, second.id, "first")).rejects.toThrow("process killed");
		ctx.clock.t += ctx.job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(ctx.deps, second.id);
		const row = (await ctx.deps.records.query({ where: { jobId: second.id, seq: 1 } })).items[0]!
			.data;
		return { ...ctx, done, row };
	}

	it("leaves an update unpublished when a crash hides the written revision", async () => {
		const { deps, done, row } = await crashDuringUpdate("afterWrite");
		expect(done.status).toBe("completed");
		expect(done.counters).toMatchObject({ unchanged: 2, conflict: 1, updated: 0 });
		expect(row).toMatchObject({ status: "conflict", errors: [{ code: "publish_unverified" }] });
		expect(deps.content.entries.size).toBe(3);
		expect(deps.content.entries.get("e2")).toMatchObject({
			pendingPublish: true,
			data: { price: 99 },
		});
	});

	it("publishes an update after a crash between the write and the publish", async () => {
		const { deps, done, row } = await crashDuringUpdate("beforePublish");
		expect(done.counters).toMatchObject({ unchanged: 2, updated: 1, conflict: 0 });
		expect(row).toMatchObject({ status: "updated", action: "update" });
		expect(deps.content.entries.size).toBe(3);
		expect(deps.content.entries.get("e2")).toMatchObject({
			pendingPublish: false,
			data: { price: 99 },
		});
	});

	it("fails the job after three unexpected errors without moving the cursor", async () => {
		const { deps, clock, job } = await setup(csv(2));
		deps.content.ensureSourceIdField = async () => {
			throw new Error("database is down");
		};
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("database is down");
			const stored = (await deps.jobs.get(job.id))!;
			expect(stored).toMatchObject({
				failures: attempt,
				error: { code: "internal", message: "database is down" },
				cursor: job.cursor,
				counters: job.counters,
				status: attempt < 3 ? "running" : "failed",
			});
			if (attempt < 3) expect(stored.lease?.holder).toBe("driver");
			else expect(stored.lease).toBeNull();
			clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		}
		expect((await runBatch(deps, job.id, "driver")).status).toBe("failed");
		expect(deps.content.entries.size).toBe(0);
	});

	it("resets the failure count after a successful batch", async () => {
		const { deps, clock, job } = await setup(csv(2));
		let down = true;
		deps.content.ensureSourceIdField = async () => {
			if (down) throw new Error("database is down");
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("database is down");
		down = false;
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", failures: 0, counters: { created: 2 } });
	});

	it("fails only the record when a content lookup throws a ContentWriteError", async () => {
		const { deps, job } = await setup(csv(3));
		await runToEnd(deps, job.id);
		const realGet = deps.content.get.bind(deps.content);
		deps.content.get = async (c, l, id) => {
			if (id === "e2") throw new ContentWriteError("ambiguous_source_id", "Two entries match");
			return realGet(c, l, id);
		};
		deps.source.add(
			"u2",
			csv(3, () => "5"),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		const done = await runToEnd(deps, second.id);
		expect(done).toMatchObject({ status: "completed", counters: { updated: 2, failed: 1 } });
		const row = (await deps.records.query({ where: { jobId: second.id, seq: 1 } })).items[0]!.data;
		expect(row).toMatchObject({ status: "failed", errors: [{ code: "ambiguous_source_id" }] });
	});

	it("fails only the record when the source-id lookup is ambiguous during crash repair", async () => {
		const { deps, clock, job } = await setup(csv(5), { batchSize: 5 });
		let crashOn: string | null = "e3";
		deps.content.afterWrite = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "Two entries match");
		};
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 4, failed: 1 } });
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 2 } })).items[0]!.data;
		expect(row).toMatchObject({ status: "failed", errors: [{ code: "ambiguous_source_id" }] });
	});
});

describe("retry pass", () => {
	it("publishes publish_locked drafts once unlocked and keeps still-locked records locked", async () => {
		const { deps, job } = await setup(csv(3));
		await runToEnd(deps, job.id);
		deps.content.locked.add("e1");
		deps.content.failPublish = (id) => (id === "e2" ? "locked" : null);
		deps.source.add(
			"u2",
			csv(3, () => "8"),
		);
		const second = await createJob(deps, { uploadId: "u2", template, schemaFields });
		const first = await runToEnd(deps, second.id);
		expect(first.counters).toMatchObject({ updated: 1, locked: 2 });
		const lockedRow = (await deps.records.query({ where: { jobId: second.id, seq: 1 } })).items[0]!
			.data;
		expect(lockedRow).toMatchObject({ status: "locked", errors: [{ code: "publish_locked" }] });

		deps.content.failPublish = () => null;
		await transitionJob(deps, second.id, "retry");
		const retried = await runToEnd(deps, second.id);
		expect(retried.counters).toEqual({
			created: 0,
			updated: 2,
			unchanged: 0,
			locked: 1,
			conflict: 0,
			failed: 0,
		});
		const rows = (
			await deps.records.query({ where: { jobId: second.id }, orderBy: { seq: "asc" } })
		).items.map((r) => r.data.status);
		expect(rows).toEqual(["locked", "updated", "updated"]);
		expect(deps.content.entries.get("e2")).toMatchObject({
			pendingPublish: false,
			data: { price: 8 },
		});
		expect(deps.content.entries.get("e1")).toMatchObject({ data: { price: 0 } });
	});
	it("retries failed and conflicting records only", async () => {
		const { deps, job } = await setup(csv(4));
		let flaky = true;
		deps.content.failWrite = (data) =>
			flaky && data.flux_source_id === "S2"
				? new ContentWriteError("timeout", "Upstream timeout")
				: null;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({ created: 3, failed: 1 });
		flaky = false;
		const callsBefore = deps.content.calls.length;
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried).toMatchObject({
			status: "completed",
			phase: "import",
			counters: { created: 4, failed: 0 },
		});
		expect(deps.content.calls.slice(callsBefore)).toEqual(["create:e4", "publish:e4"]);
		expect(deps.content.entries.size).toBe(4);
		const rows = await deps.records.query({ where: { jobId: job.id }, limit: 100 });
		const tally = { created: 0, updated: 0, unchanged: 0, failed: 0, locked: 0, conflict: 0 };
		for (const { data } of rows.items) tally[data.status as keyof typeof tally]++;
		expect(retried.counters).toEqual(tally);
	});

	it("recovers a record left writing by a crash mid-retry and keeps counters exact", async () => {
		const { deps, clock, job } = await setup(csv(3));
		let flaky = true;
		deps.content.failWrite = () =>
			flaky ? new ContentWriteError("timeout", "Upstream timeout") : null;
		expect((await runToEnd(deps, job.id)).counters.failed).toBe(3);
		flaky = false;
		await transitionJob(deps, job.id, "retry");
		let creates = 0;
		deps.content.beforePublish = () => {
			creates++;
			if (creates === 2) throw new Error("crash");
		};
		await expect(runBatch(deps, job.id, "driver")).rejects.toThrow("crash");
		clock.t += 10 * 60_000;
		const done = await runToEnd(deps, job.id);
		expect(done).toMatchObject({ status: "completed", phase: "import" });
		expect(done.counters).toEqual({
			created: 3,
			updated: 0,
			unchanged: 0,
			failed: 0,
			locked: 0,
			conflict: 0,
		});
		const ids = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		expect([...deps.content.entries.values()].every((e) => !e.pendingPublish)).toBe(true);
		const rows = await deps.records.query({ where: { jobId: job.id }, limit: 100 });
		expect(rows.items.filter((r) => r.data.status === "writing")).toEqual([]);
	});

	it("leaves records that fail again as failed and still completes", async () => {
		const { deps, job } = await setup("sku,Name,Price\nS0,Ok,1\nS1,Bad,abc\n");
		await runToEnd(deps, job.id);
		await transitionJob(deps, job.id, "retry");
		const retried = await runToEnd(deps, job.id);
		expect(retried).toMatchObject({ status: "completed", counters: { created: 1, failed: 1 } });
	});

	it("retries in bounded batches", async () => {
		const { deps, job } = await setup(csv(5), { batchSize: 2 });
		let flaky = true;
		deps.content.failWrite = () =>
			flaky ? new ContentWriteError("timeout", "Upstream timeout") : null;
		expect((await runToEnd(deps, job.id)).counters.failed).toBe(5);
		flaky = false;
		await transitionJob(deps, job.id, "retry");
		const first = await runBatch(deps, job.id, "driver");
		expect(first).toMatchObject({
			status: "running",
			phase: "retry",
			retryFromSeq: 2,
			counters: { created: 2, failed: 3 },
		});
		const done = await runToEnd(deps, job.id);
		expect(done.counters).toMatchObject({ created: 5, failed: 0 });
	});
});
