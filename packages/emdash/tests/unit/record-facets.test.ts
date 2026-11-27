import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/engine/batch.js";
import { facetOf } from "../../src/engine/counters.js";
import { createJob, transitionJob } from "../../src/engine/jobs.js";
import { ContentWriteError } from "../../src/engine/ports.js";
import type { SchemaField } from "../../src/engine/template.js";
import type { Job, RecordRow } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import { recordPage } from "../../src/plugin/service.js";
import { MemoryKv, makeDeps } from "./fakes.js";

type Deps = ReturnType<typeof makeDeps>["deps"];

const schemaFields: SchemaField[] = [
	{ slug: "title", type: "string" },
	{ slug: "body", type: "portableText" },
	{ slug: "flux_source_id", type: "string" },
];
const template = {
	version: 1,
	source: { format: "json", records: "posts" },
	collection: "posts",
	locale: "en",
	key: { from: "id" },
	fields: {
		title: { from: "title", type: "text" },
		body: { from: "html", type: "portableText", format: "html" },
	},
};
type Post = { id: string; title: string; html: string };
const plain = (id: string, title = id): Post => ({ id, title, html: "<p>x</p>" });
// A <table> converts with a warning (`unknown_markup`).
const warned = (id: string, title = id): Post => ({
	id,
	title,
	html: "<table><tr><td>t</td></tr></table>",
});

/** The fakes, with the records collection checking its queries against the declared indexes. */
function setup() {
	const { deps } = makeDeps();
	const records = new MemoryKv<RecordRow>(STORAGE.records.indexes);
	return { ...deps, records } satisfies Deps;
}

async function run(deps: Deps, posts: Post[], dryRun: boolean): Promise<Job> {
	const upload = `u${deps.source.uploads.size + 1}`;
	deps.source.add(upload, JSON.stringify({ posts }));
	const job = await createJob(deps, { uploadId: upload, template, schemaFields, dryRun });
	return toEnd(deps, job.id);
}

async function toEnd(deps: Deps, id: string): Promise<Job> {
	for (let i = 0; i < 1000; i++) {
		const job = await runBatch(deps, id, "driver");
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

const keys = async (deps: Deps, id: string, facet: "change" | "warning") =>
	(await recordPage(deps, { id, facet })).items.map((r) => r.sourceKey);

describe("facetOf", () => {
	it("marks the rows that change an entry, those with warnings, and both", () => {
		const w = [{ code: "x", message: "y" }];
		expect(facetOf({ status: "planned", action: "create" })).toBe("change");
		expect(facetOf({ status: "planned", action: "trash", warnings: w })).toBe("change+warning");
		expect(facetOf({ status: "planned", action: "unchanged" })).toBeUndefined();
		expect(facetOf({ status: "planned", action: "unchanged", warnings: w })).toBe("warning");
		expect(facetOf({ status: "updated", action: "update" })).toBe("change");
		expect(facetOf({ status: "removed", action: "unpublish" })).toBe("change");
		expect(facetOf({ status: "failed", warnings: w })).toBe("warning");
		expect(facetOf({ status: "writing", action: "create", warnings: [] })).toBeUndefined();
	});
});

describe("record facets and the warned count", () => {
	it("lets a dry run's rows be paged by change and by warning, and counts the warned ones", async () => {
		const deps = setup();
		const job = await run(deps, [plain("a"), warned("b"), plain("c"), warned("d")], true);
		expect(job.status).toBe("completed");
		expect(job.warned).toBe(2);
		expect(await keys(deps, job.id, "change")).toEqual(["a", "b", "c", "d"]);
		expect(await keys(deps, job.id, "warning")).toEqual(["b", "d"]);
	});

	it("leaves a planned unchanged row out of the changes, so they match the counters", async () => {
		const deps = setup();
		await run(deps, [plain("a"), plain("b"), warned("c")], false);
		const dry = await run(deps, [plain("a"), plain("b", "B2"), warned("c")], true);
		expect(dry.counters).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
		expect(await keys(deps, dry.id, "change")).toEqual(["b"]);
		expect(await keys(deps, dry.id, "warning")).toEqual(["c"]);
		expect(dry.warned).toBe(1);
	});

	it("does not count a retried record's warnings twice", async () => {
		const deps = setup();
		let fail = true;
		deps.content.failWrite = () => {
			if (!fail) return null;
			fail = false;
			return new ContentWriteError("validation", "rejected once");
		};
		const first = await run(deps, [warned("a"), plain("b")], false);
		expect(first.counters).toMatchObject({ created: 1, failed: 1 });
		expect(first.warned).toBe(1);
		await transitionJob(deps, first.id, "retry");
		const retried = await toEnd(deps, first.id);
		expect(retried.counters).toMatchObject({ created: 2, failed: 0 });
		expect(retried.warned).toBe(1);
		expect(await keys(deps, first.id, "warning")).toEqual(["a"]);
	});
});
