# Flux Import M2b: EmDash adapters, plugin routes, integration and workerd — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the M2a engine to EmDash 1.2.0 (content, schema, locks, storage), expose it through the `flux-import` plugin routes and the streamed upload route, and prove Milestone 2 with integration tests on `sites/dev` (Node, SQLite) and `sites/dev-cf` (workerd, D1, R2).

**Architecture:** The engine stays platform-independent behind its ports (`ContentPort`, `SourcePort`, `KvCollection`). `src/emdash/` implements the ports over the runtime that `withEmDashRuntime()` hands a plugin route, one responsibility per file. `src/plugin/` holds a thin service layer (unit-tested with fakes), the route table and the plugin definition; `src/astro/` holds the trusted upload route and the `fluxImportRoutes()` integration. Integration tests drive `astro dev` over HTTP with a dev-bypass PAT.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, Zod 4.5.4, Kysely 0.29, Luxon 3, Biome 2, EmDash 1.2.0, `@emdash-cms/auth` 1.2.0, Astro 7.3, `@astrojs/node` 11; for workerd `@astrojs/cloudflare` 14, `@emdash-cms/cloudflare` 1.2.0, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (Decisions, Roadmap M2, Milestone 2 design, Verified facts). Evidence: `docs/superpowers/notes/2026-10-07-m2-verification.md` ("the report" below). Previous plan: `docs/superpowers/plans/2026-10-07-flux-import-m2a-engine-core.md`.

Paths written `src/…` or `dist/…` without a package name are relative to `sites/dev/node_modules/emdash/` (EmDash ships its sources). The code in Tasks 1 to 13 was compiled, linted and run (unit and Node integration suites green) against the installed packages while this plan was written, then removed; Task 14 (workerd) could not be run here and starts with verification steps.

## Global Constraints

- Plugin ID `flux-import`. Package exports `fluxImport()` (descriptor), `fluxImportRoutes()` (Astro integration), `createPlugin()` (native entrypoint).
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools or `command cat`, never `cat >` or `cat >>`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports.
- Never `eval` or `new Function`.
- SQL only through Kysely; raw fragments only with the `sql` template, identifiers with `sql.ref()`. Every content query filters by locale (`handleContentGet`/`handleContentList` get the template's `locale`).
- API routes `export const prerender = false`. State-changing requests from session callers need `X-EmDash-Request: 1`; Bearer PATs skip CSRF but need the `admin` scope (report, questions 5 and 6).
- All plugin routes declare `permission: "import:execute"`; the upload route checks `hasPermission(locals.user, "import:execute")`.
- Use `import.meta.env.DEV`, never `process.env.NODE_ENV`, in code that runs in the site. (`astro.config.mjs` may read `process.env` for configuration.)
- Storage only through `emdash.storage` (`runtime.storage` / `locals.emdash.storage`). Staged files use unguessable keys and never appear in unauthenticated responses.
- The source-ID field is `flux_source_id` (`string`, `indexed: true`, `translatable: false`).
- Batch size default 50, maximum 500; time budget default 4,000 ms (500 to 25,000).
- Retention default 30 days; staged uploads default limit 50 MiB (`maxSourceBytes`).
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; tasks that touch integration also pass `pnpm test:integration`.

## Review Focus

1. Importing the same file twice must report every row `unchanged` and leave each entry's `_rev` as it was (numbers and datetimes must survive EmDash's round trip) — test in Task 12 ("reports every row unchanged …").
2. An upload over `maxSourceBytes` (declared or chunked), a non-`.csv` name, or an anonymous caller must get 413/415/401 and leave nothing in storage — tests in Task 4 (`stageUpload`) and Task 12 ("uploads").
3. An `uploadId` that looks like a path or another key (`../backups/x`, a bare ULID) must be rejected by Zod and by `uploadKey()` before storage is touched — tests in Task 4 ("reject anything that could reach another storage path") and Task 9 ("validates route input with Zod").
4. Two `jobs/next` calls on the same job at the same moment must process one batch once (unique lease holders) — test in Task 12 ("concurrent drivers").
5. A record log larger than the 8 MiB raw-response cap must answer 413 `LOG_TOO_LARGE` with a hint, not a 500 — test in Task 7 ("refuses one over the raw response limit").

## Facts this plan relies on (beyond the report)

Found while writing this plan, against the installed packages; tasks cite them by number.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | Astro 7 moves `astro dev` to the background when it detects an AI agent; `--ignore-lock` keeps it in the foreground and allows several servers per project. | `node_modules/.pnpm/astro@7.3.7…/astro/dist/cli/dev/index.js:85-90` |
| F2 | `astro dev` started with Vitest's environment (`NODE_ENV=test`, `VITEST*`) answers every route with 404; without those variables it works. | observed while drafting this plan |
| F3 | `emdash/middleware` imports `virtual:emdash/*` modules (only present inside the Astro build), so it cannot be imported by `astro.config.mjs` or unit tests; `withEmDashRuntime` is loaded lazily. | `dist/astro/middleware.mjs:128-136` |
| F4 | The local storage adapter's `list()` splits the prefix into a directory and a file-name prefix, so a prefix ending in `/` lists the parent directory. Staged keys are flat: `flux-import-upload-<uploadId>.csv`. | `src/storage/local.ts:175-200` |
| F5 | Raw plugin responses must be `pluginResponse()` objects, `text/csv` is allowed, and bodies are capped at 8 MiB (`PLUGIN_ROUTE_MAX_BODY_BYTES`). Thrown `PluginRouteError(code, message, status, details)` becomes `{ success: false, error }` with that status. | `src/plugins/route-wire.ts:213-295`, `src/plugin-types.ts:211-236`, `src/plugins/routes.ts:280-318`, `@emdash-cms/plugin-types/dist/index.js:4` |
| F6 | Plugin storage rejects `where`/`orderBy` on fields not listed in any index; every field of a composite index counts. | `src/plugins/storage-query.ts:113-142` |
| F7 | Config plugins run `plugin:install` then `plugin:activate` once, when they have no `_plugin_state` row. `sites/dev/data.db` already has the row, so the retention task is also scheduled lazily by `jobs/create`. | `src/emdash-runtime.ts:1146-1182` |
| F8 | `ctx.cron.schedule()` upserts and resets `next_run_at`; schedule only when the task is missing. The Node scheduler re-reads due times at least every 60 s. | `src/plugins/cron.ts:259-287`, `src/plugins/scheduler/node.ts:26` |
| F9 | Admin `PUT /_emdash/api/admin/plugins/<id>/settings` and `ctx.settings` use the same keys (`plugin:<id>:settings:<key>`). | `src/api/handlers/plugin-settings.ts:6,35`, `src/plugins/settings.ts:238` |
| F10 | `handleContentGet` returns `{ item, _rev }` with draft data merged into `item.data`, but the live slug (no staged slug). Items carry `status`, `draftRevisionId`, `liveRevisionId`, `locale`. | `src/emdash-runtime.ts:3364-3442`, `src/database/repositories/types.ts:299-330` |
| F11 | `handleContentPublish` works on collections without revisions (sets `status`), and the trusted path never checks edit locks, so the adapter checks the lock before publishing. Policy rejections return `PUBLISH_REJECTED`. | `src/api/handlers/content.ts:2341-2470`, `src/emdash-runtime.ts:4575-4650` |
| F12 | No second user can sign in from a script: invites complete with a passkey. Tests take a lock through the REST route, then move it to a second `users` row (columns as dev-bypass inserts them). | `src/astro/routes/api/auth/invite/complete.ts:1-6`, `src/astro/routes/api/auth/dev-bypass.ts:59-69` |
| F13 | EmDash's `sqlite()` adapter runs on `node:sqlite`; tests open the same file with `node:sqlite` (`busy_timeout` set). | `src/db/sqlite.ts:11` |
| F14 | `emdash` and `@emdash-cms/auth` pin `zod` 4.5.4; plugin route `input` is typed against that copy. The two `emdash` copies differ in `@astrojs/react` (6.0.6 / 7.0.1) and `react` (19.2.4 / 19.3.0). | `sites/dev/node_modules/emdash/package.json`, `pnpm-lock.yaml:35,53` |
| F15 | R2 storage passes the upload body straight to `bucket.put`, maps a missing object to `EmDashStorageError("…", "NOT_FOUND")`, falls back to the whole object when a ranged read fails, and lists with a real prefix. Workers R2 `put()` rejects a stream of unknown length (Cloudflare Workers API), hence `FixedLengthStream`. | `@emdash-cms/cloudflare@1.2.0` `src/storage/r2.ts:55-165` (from `npm pack`) |
| F16 | `@astrojs/cloudflare@14.3.4` peers `astro ^7.2.0`, `wrangler ^4.125.0`, depends on `@cloudflare/vite-plugin`; `@emdash-cms/cloudflare@1.2.0` peers `@astrojs/cloudflare >=12`, `wrangler >=4.99`, `kysely`, `astro`, `@cloudflare/workers-types >=4` and depends on `emdash` 1.2.0. | `npm view` on 2026-10-08 |

## Rulings this plan makes

- **Upload ID is the capability.** `uploadId` = ULID + 32 hex characters; the key is derived from it (`flux-import-upload-<uploadId>.csv`, flat per F4). Nothing else stores the key. Upload IDs appear only in `import:execute` responses.
- **Staged files after a job.** The spec deletes them "when a job reaches a terminal state", but `jobs/retry` re-reads a completed job's file and a real import usually reuses a dry run's upload. A file is deleted when its job is cancelled, or completed with nothing to retry and not a dry run, and no other job still needs it (`jobs` gets an `uploadId` index for that check). Everything else is removed by retention.
- **Retention** deletes jobs older than the setting together with their records, and staged files by `lastModified`. Links are kept.
- **Capabilities** `content:read`, `content:write`, `content:publish`, `schema:read` are declared for disclosure on the admin plugins page; the writes go through the trusted runtime, not `ctx.content`.
- **`pendingPublish`** is `status !== "published" || draftRevisionId !== null` (the M2a port comment said "always false without revisions"; that would let the importer publish an editor's unpublished entry on a collection without revisions). Task 6 updates the comment.
- **Repaired links.** An entry found by the `flux_source_id` lookup is treated as an unfinished write: it is published only when the record's `writtenRev` proves the revision is the importer's, else `conflict`/`publish_unverified`.
- **`maxSourceBytes`** is an option of `fluxImportRoutes()` (the trusted route runs outside plugin context), default 50 MiB.
- **EmDash error codes** become record codes `emdash_<code>` (lower case), so none can collide with the engine's `publish_*` codes.
- **Record size** is capped at 4 MiB per CSV record (bounds memory in a 128 MB isolate).
- **`jobs/log.csv`** is a GET route with `?id=&status=`; session callers still need `X-EmDash-Request: 1` (`src/plugins/http-route-dispatch.ts:75-77`), so the M7 wizard downloads it with `fetch`.

---

### Task 1: Engine fixes (duplicate on retry, stale error, publish-off repair, missing collection)

**Files:**
- Modify: `packages/flux-import/src/engine/batch.ts` (`release`, `decide`, `finishUnchanged`, `writeRecord`, `runBatch`)
- Test: `packages/flux-import/tests/unit/batch.test.ts`

**Interfaces:**
- Consumes: M2a engine (`runBatch(deps, jobId, holder)`, `transitionJob`, `ContentWriteError`, `FakeContent.findBySourceId`, `MemoryKv`).
- Produces: unchanged signatures. New behaviour later tasks rely on: (a) whenever a record already has a row from this job and no entry resolves, `decide` calls `ContentPort.findBySourceId` before creating; (b) `release` clears a stored error with code `internal` after a successful batch; (c) `writeRecord` saves `writtenRev` on the `writing` row before the link, for every job; a publish-off repair whose entry is still at `writtenRev` writes it to the link; (d) `ContentPort.ensureSourceIdField` throwing `ContentWriteError("collection_missing", …)` fails the job with error code `collection_missing` (Task 5 throws it).

The bug: if `findBySourceId` throws `ContentWriteError` during crash repair, the `writing` row is saved `failed`; a retry skips the lookup (it was gated on `existing.status === "writing"`), finds no link and creates a duplicate.

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/batch.test.ts`:

Replace the assertion at the end of "resets the failure count after a successful batch":
```ts
		expect(done).toMatchObject({ status: "completed", failures: 0, counters: { created: 2 } });
```
with:
```ts
		expect(done).toMatchObject({
			status: "completed",
			failures: 0,
			error: null,
			counters: { created: 2 },
		});
```

In "retries failed and conflicting records only", replace:
```ts
		expect(deps.content.calls.slice(callsBefore)).toEqual(["create:e4", "publish:e4"]);
```
with:
```ts
		// The earlier failed row makes the retry look the source key up before creating.
		expect(deps.content.calls.slice(callsBefore)).toEqual(["find:S2", "create:e4", "publish:e4"]);
```

Append inside `describe("runBatch", …)`, after "fails only the record when the source-id lookup is ambiguous during crash repair":
```ts
	it("finds a crashed entry on retry after an ambiguous lookup instead of creating a duplicate", async () => {
		const { deps, clock, job } = await setup(csv(5), { batchSize: 5 });
		let crashOn: string | null = "e3";
		deps.content.afterWrite = (id) => {
			if (id === crashOn) {
				crashOn = null;
				throw new Error("process killed");
			}
		};
		await expect(runBatch(deps, job.id, "first")).rejects.toThrow("process killed");
		const realFind = deps.content.findBySourceId.bind(deps.content);
		let ambiguous = true;
		deps.content.findBySourceId = async (c, l, sourceId) => {
			if (ambiguous) throw new ContentWriteError("ambiguous_source_id", "Two entries match");
			return realFind(c, l, sourceId);
		};
		clock.t += job.budgetMs + LEASE_GRACE_MS + 1;
		expect((await runToEnd(deps, job.id)).counters).toMatchObject({ created: 4, failed: 1 });

		ambiguous = false;
		await transitionJob(deps, job.id, "retry");
		const done = await runToEnd(deps, job.id);
		expect(deps.content.entries.size).toBe(5);
		expect(deps.content.calls.filter((c) => c.startsWith("create:"))).toHaveLength(5);
		const keys = [...deps.content.entries.values()].map((e) => e.data.flux_source_id);
		expect(new Set(keys).size).toBe(5);
		expect(await deps.links.get("products:en:S2")).toMatchObject({ entryId: "e3" });
		// The crash hid the written revision, so the draft is reported, not published.
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 2 } })).items[0]!.data;
		expect(row).toMatchObject({
			status: "conflict",
			entryId: "e3",
			errors: [{ code: "publish_unverified" }],
		});
		expect(done.counters).toMatchObject({ created: 4, conflict: 1, failed: 0 });
	});

	it("records its revision on the link when repairing a publish: false write", async () => {
		const { deps, clock } = makeDeps();
		deps.source.add("u1", csv(3));
		const draftJob = await createJob(deps, {
			uploadId: "u1",
			template,
			schemaFields,
			publish: false,
		});
		const realPut = deps.links.put.bind(deps.links);
		let crash = true;
		deps.links.put = async (id, data) => {
			if (crash && id === "products:en:S1" && data.writtenRev !== undefined) {
				crash = false;
				throw new Error("process killed");
			}
			return realPut(id, data);
		};
		await expect(runBatch(deps, draftJob.id, "first")).rejects.toThrow("process killed");
		clock.t += draftJob.budgetMs + LEASE_GRACE_MS + 1;
		const done = await runToEnd(deps, draftJob.id);
		expect(done.counters).toMatchObject({ created: 3, conflict: 0 });
		expect((await deps.links.get("products:en:S1"))?.writtenRev).toBe(
			String(deps.content.entries.get("e2")!.rev),
		);

		const second = await createJob(deps, { uploadId: "u1", template, schemaFields });
		const published = await runToEnd(deps, second.id);
		expect(published.counters).toMatchObject({ updated: 3, unchanged: 0, conflict: 0 });
		expect([...deps.content.entries.values()].every((e) => !e.pendingPublish)).toBe(true);
	});

	it("fails the job when the target collection is gone", async () => {
		const { deps, job } = await setup(csv(2));
		deps.content.ensureSourceIdField = async () => {
			throw new ContentWriteError("collection_missing", 'Collection "products" does not exist');
		};
		const after = await runBatch(deps, job.id, "driver");
		expect(after).toMatchObject({
			status: "failed",
			failures: 0,
			lease: null,
			error: { code: "collection_missing" },
		});
		expect(deps.content.entries.size).toBe(0);
	});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/batch.test.ts`
Expected: 5 failures — "resets the failure count after a successful batch" (error still `internal`), "finds a crashed entry on retry …" (6 creates), "records its revision on the link …" (`writtenRev` undefined), "fails the job when the target collection is gone" (rejects instead of failing the job), "retries failed and conflicting records only" (no `find:S2`).

- [ ] **Step 3: Implement**

In `packages/flux-import/src/engine/batch.ts`, `release()`: replace
```ts
			error: outcome.error ?? stored.error,
```
with:
```ts
			// A finished batch clears an earlier unexpected error; other errors stay until resume.
			error: outcome.error ?? (stored.error?.code === "internal" ? null : stored.error),
```

In `decide()`, replace
```ts
		if (!entry && existing?.status === "writing") {
			entry = await deps.content.findBySourceId(collection, locale, sourceKey);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
			}
		}
```
with:
```ts
		// Any earlier row of this job may stand for a write whose link was never saved: a crash
		// mid-write, or a crash repair whose lookup failed. Look the entry up before creating one.
		let repaired = false;
		if (!entry && existing !== null) {
			entry = await deps.content.findBySourceId(collection, locale, sourceKey);
			if (entry) {
				link = { collection, locale, sourceKey, entryId: entry.id };
				await deps.links.put(ctx.linkId, link);
				repaired = true;
			}
		}
```
and replace
```ts
		if (plan.action === "unchanged") return await finishUnchanged(ctx, entry, link, existing);
```
with:
```ts
		if (plan.action === "unchanged")
			return await finishUnchanged(ctx, entry, link, existing, repaired);
```

In `finishUnchanged()`, add the parameter and widen `unfinished`: replace
```ts
	link: LinkRow | null,
	existing: RecordRow | null,
): Promise<RowFields> {
	const { job, sourceKey } = ctx;
	const entryId = entry.id;
	const unfinished =
		existing !== null &&
		(existing.status === "writing" ||
			(existing.errors ?? []).some((e) => e.code.startsWith("publish_")));
```
with:
```ts
	link: LinkRow | null,
	existing: RecordRow | null,
	repaired: boolean,
): Promise<RowFields> {
	const { job, sourceKey } = ctx;
	const entryId = entry.id;
	const unfinished =
		repaired ||
		(existing !== null &&
			(existing.status === "writing" ||
				(existing.errors ?? []).some((e) => e.code.startsWith("publish_"))));
```
and, in the same function, replace
```ts
		const published = await publishRev(ctx, entryId, entry.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, entryId, action, writtenRev);
	}
	return {
```
with:
```ts
		const published = await publishRev(ctx, entryId, entry.rev);
		if (!published.ok)
			return publishFailed(published.reason, sourceKey, entryId, action, writtenRev);
	} else if (
		!job.publish &&
		writtenRev !== undefined &&
		entry.rev === writtenRev &&
		link?.writtenRev !== writtenRev
	) {
		// The crash came between saving the written revision and saving the link: the draft is
		// provably ours, so record it on the link for a later publishing run.
		await putLink(ctx, entryId, writtenRev);
	}
	return {
```

In `writeRecord()`, replace
```ts
	await putLink(ctx, written.id, written.rev);
	if (job.publish) {
		// Record the revision we wrote, so crash repair publishes only that revision.
		await save({
			status: "writing",
			sourceKey,
			entryId: written.id,
			action: plan.action,
			writtenRev: written.rev,
		});
		const published = await publishRev(ctx, written.id, written.rev);
```
with:
```ts
	// Record the revision we wrote before anything else, so crash repair can prove a draft is ours
	// and publishes or links only that revision.
	await save({
		status: "writing",
		sourceKey,
		entryId: written.id,
		action: plan.action,
		writtenRev: written.rev,
	});
	await putLink(ctx, written.id, written.rev);
	if (job.publish) {
		const published = await publishRev(ctx, written.id, written.rev);
```

In `runBatch()`'s `catch`, after the `SourceMissingError` branch, add:
```ts
		} else if (e instanceof ContentWriteError && e.code === "collection_missing") {
			outcome = { done: false, error: { code: "collection_missing", message: e.message } };
```
(`ContentWriteError` is already imported in `batch.ts`.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/batch.test.ts`
Expected: PASS (35 tests). Then from the root: `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/engine/batch.ts packages/flux-import/tests/unit/batch.test.ts
git commit -m "Look up the source ID before creating on any re-processed record

A failed crash-repair lookup no longer leads to a duplicate on retry. Also
clear a stale internal error after a good batch, save the written revision
before the link for every job, and fail the job when the collection is gone."
```

### Task 2: CSV record-size cap and sample reader

**Files:**
- Modify: `packages/flux-import/src/sources/csv.ts`
- Test: `packages/flux-import/tests/unit/csv.test.ts`

**Interfaces:**
- Consumes: `parseCsvRows`, `normalizeHeaders`, `CsvSyntaxError` (M2a).
- Produces: `MAX_RECORD_BYTES = 4 * 1024 * 1024`; `interface CsvSample { headers: string[]; rows: string[][] }`; `readCsvSample(stream: ReadableStream<Uint8Array>, n: number): Promise<CsvSample>` (Task 7). A record of `MAX_RECORD_BYTES` or more throws `CsvSyntaxError` with the record's start offset, which `runBatch` already turns into a failed job (`csv_syntax`).

- [ ] **Step 1: Write the failing tests**

In `packages/flux-import/tests/unit/csv.test.ts`, extend the import to:
```ts
import {
	CsvSyntaxError,
	dropBytes,
	MAX_RECORD_BYTES,
	normalizeHeaders,
	parseCsvRows,
	readCsvHeader,
	readCsvRecords,
	readCsvSample,
} from "../../src/sources/csv.js";
```
and append:
```ts
describe("record size limit", () => {
	it("rejects a record larger than MAX_RECORD_BYTES with its start offset", async () => {
		const huge = `sku,notes\nA1,ok\nB2,"${"x".repeat(MAX_RECORD_BYTES)}"\n`;
		const error = await collect(parseCsvRows(streamOf(huge))).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CsvSyntaxError);
		expect(error).toMatchObject({ offset: "sku,notes\nA1,ok\n".length });
	});

	it("accepts a record just under the limit", async () => {
		const big = `sku,notes\nA1,${"x".repeat(MAX_RECORD_BYTES - 10)}\n`;
		const rows = await collect(parseCsvRows(streamOf(big)));
		expect(rows).toHaveLength(2);
	});
});

describe("readCsvSample", () => {
	it("returns the headers and the first n rows", async () => {
		const sample = await readCsvSample(streamOf("sku,name\nA,1\nB,2\nC,3\n"), 2);
		expect(sample).toEqual({
			headers: ["sku", "name"],
			rows: [
				["A", "1"],
				["B", "2"],
			],
		});
	});

	it("returns fewer rows when the file is short and rejects an empty file", async () => {
		expect(await readCsvSample(streamOf("sku\nA\n"), 20)).toEqual({
			headers: ["sku"],
			rows: [["A"]],
		});
		await expect(readCsvSample(streamOf(""), 5)).rejects.toBeInstanceOf(CsvSyntaxError);
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/csv.test.ts`
Expected: FAIL — `MAX_RECORD_BYTES` and `readCsvSample` are not exported.

- [ ] **Step 3: Implement**

In `packages/flux-import/src/sources/csv.ts`, after `const BOM = [0xef, 0xbb, 0xbf];` add:
```ts

/**
 * The largest record (a row with its quoted newlines) the reader accepts. It bounds memory per
 * record, which matters in a 128 MB Workers isolate; a larger record makes the file unreadable.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
```
In `parseCsvRows`, in the main byte loop, replace
```ts
				const row = feed(b, p);
				if (row) yield row;
			}
		}
```
with:
```ts
				if (p - rowStart >= MAX_RECORD_BYTES) {
					throw new CsvSyntaxError(`A record is larger than ${MAX_RECORD_BYTES} bytes`, rowStart);
				}
				const row = feed(b, p);
				if (row) yield row;
			}
		}
```
and before `export interface CsvRecord {` add:
```ts
export interface CsvSample {
	headers: string[];
	rows: string[][];
}

/** Reads the header and up to `n` rows, without validating column counts. */
export async function readCsvSample(
	stream: ReadableStream<Uint8Array>,
	n: number,
): Promise<CsvSample> {
	let headers: string[] | null = null;
	const rows: string[][] = [];
	for await (const row of parseCsvRows(stream, 0)) {
		if (headers === null) headers = normalizeHeaders(row.fields);
		else rows.push(row.fields);
		if (rows.length >= n) break;
	}
	if (headers === null) throw new CsvSyntaxError("CSV has no header row", 0);
	return { headers, rows };
}

```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/csv.test.ts`
Expected: PASS (17 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/sources/csv.ts packages/flux-import/tests/unit/csv.test.ts
git commit -m "Cap CSV records at 4 MiB and add a header-and-rows sample reader"
```

### Task 3: Align dependencies (one emdash copy, auth, kysely, zod)

**Files:**
- Modify: `packages/flux-import/package.json`, `pnpm-lock.yaml` (by `pnpm install`); `pnpm-workspace.yaml` only if Step 4's fallback is needed

**Interfaces:**
- Consumes: nothing new.
- Produces: `flux-import` can import `@emdash-cms/auth` (1.2.0), `kysely` (^0.29, the copy `emdash` uses), `astro` types; `zod` is the 4.5.4 copy `emdash` uses (F14); the workspace resolves exactly one `emdash@1.2.0` directory.

- [ ] **Step 1: Record the current state**

Run: `command ls node_modules/.pnpm | grep -c '^emdash@1.2.0'`
Expected: `2` (report, "Other findings").

- [ ] **Step 2: Edit the package manifest**

Replace `packages/flux-import/package.json` with:
```json
{
	"name": "flux-import",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"exports": {
		".": "./src/index.ts"
	},
	"scripts": {
		"typecheck": "tsc --noEmit",
		"test": "vitest run"
	},
	"peerDependencies": {
		"astro": ">=6.0.0",
		"emdash": "^1.2.0"
	},
	"dependencies": {
		"@emdash-cms/auth": "1.2.0",
		"kysely": "^0.29.0",
		"luxon": "^3.7.2",
		"zod": "4.5.4"
	},
	"devDependencies": {
		"@astrojs/react": "^6.0.5",
		"@types/luxon": "^3.7.0",
		"@types/node": "^22.0.0",
		"astro": "^7.3.2",
		"emdash": "1.2.0",
		"react": "19.2.4",
		"react-dom": "19.2.4",
		"vitest": "^4.1.0"
	}
}
```
The `@astrojs/react`, `react` and `react-dom` versions match `sites/dev/package.json`, so pnpm resolves `emdash`'s peers the same way for both packages (F14).

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` changes.

- [ ] **Step 4: Verify one copy**

Run: `command ls node_modules/.pnpm | grep '^emdash@1.2.0'` and `readlink -f packages/flux-import/node_modules/emdash sites/dev/node_modules/emdash`
Expected: one directory, and both links resolve to it.
If there are still two: add to `pnpm-workspace.yaml`
```yaml
overrides:
  "@astrojs/react": 6.0.6
  react: 19.2.4
  react-dom: 19.2.4
```
run `pnpm install` again and repeat the check. If two copies remain, stop and report the two directory names.

- [ ] **Step 5: Verify nothing broke**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "Resolve a single emdash copy and add auth, kysely and pinned zod"
```

### Task 4: Storage adapters: typed plugin collections and staged uploads

**Files:**
- Modify: `packages/flux-import/src/engine/ports.ts` (`KvCollection`)
- Modify: `packages/flux-import/tests/unit/fakes.ts` (`MemoryKv`, new `FakeStorage`), `packages/flux-import/tests/unit/fakes.test.ts`
- Create: `packages/flux-import/src/emdash/storage.ts`, `packages/flux-import/src/emdash/uploads.ts`
- Test: `packages/flux-import/tests/unit/storage.test.ts`, `packages/flux-import/tests/unit/uploads.test.ts`

**Interfaces:**
- Consumes: `KvCollection<T>`, `SourcePort`, `SourceMissingError` (`src/engine/ports.ts`); `Job`, `RecordRow`, `LinkRow` (`src/engine/types.ts`); from `emdash`: `StorageCollection`, `Storage`, `ulid` (`src/index.ts:147`, `:234`, `:346`).
- Produces:
  - `KvCollection<T>` gains `delete(id: string): Promise<boolean>` and `deleteMany(ids: string[]): Promise<number>` (both exist on EmDash's `StorageCollection`, `src/plugins/types.ts:271-315`).
  - `kvCollection<T>(collection: StorageCollection): KvCollection<T>`; `interface PluginCollections { jobs: KvCollection<Job>; records: KvCollection<RecordRow>; links: KvCollection<LinkRow> }`; `pluginCollections(storage: Record<string, StorageCollection | undefined>): PluginCollections` (throws when one is missing).
  - `UPLOAD_PREFIX = "flux-import-upload-"`; `type UploadStorage = Pick<Storage, "upload" | "download" | "delete" | "list">`; `newUploadId(): string`; `isUploadId(value: string): boolean`; `uploadKey(uploadId: string): string` (throws `SourceMissingError` for a malformed ID); `class UploadTooLargeError extends Error { readonly limit: number }`; `class EmDashUploads implements SourcePort { constructor(storage: UploadStorage); open(uploadId: string, offset: number): Promise<ReadableStream<Uint8Array>>; delete(uploadId: string): Promise<void>; purgeBefore(cutoff: Date): Promise<number> }`; `interface StagedUpload { uploadId: string; bytes: number; sha256: string }`; `stageUpload(storage: UploadStorage, body: ReadableStream<Uint8Array>, maxBytes: number, declaredLength?: number): Promise<StagedUpload>`.
  - Test fake `FakeStorage implements UploadStorage` (`files`, `bodies`, `now`) in `tests/unit/fakes.ts`.

Storage facts: `download(key, { range: { offset } })` returns `range` only when served, and the whole file without `range` at or past the end (report, question 7); a missing file throws `EmDashStorageError` with code `NOT_FOUND` (`src/storage/local.ts:118`; R2: F15); local `delete` ignores a missing file (`src/storage/local.ts:153-162`); keys are flat (F4).

- [ ] **Step 1: Extend the port and the fakes**

In `packages/flux-import/src/engine/ports.ts`, in `KvCollection<T>`, after `put(…)` add:
```ts
	/** Resolves `true` when a row was deleted. */
	delete(id: string): Promise<boolean>;
	/** Resolves the number of rows deleted. */
	deleteMany(ids: string[]): Promise<number>;
```

In `packages/flux-import/tests/unit/fakes.ts`:
- add `import type { UploadStorage } from "../../src/emdash/uploads.js";` as the first import;
- in `matches()`, replace the four range lines with:
```ts
			// Numbers and ISO timestamps both compare correctly with the relational operators.
			const x = v as number | string;
			if ("gte" in c && !(x >= (c.gte as number | string))) return false;
			if ("gt" in c && !(x > (c.gt as number | string))) return false;
			if ("lte" in c && !(x <= (c.lte as number | string))) return false;
			if ("lt" in c && !(x < (c.lt as number | string))) return false;
```
- in `MemoryKv`, after `put`, add:
```ts
	async delete(id: string) {
		return this.rows.delete(id);
	}
	async deleteMany(ids: string[]) {
		let n = 0;
		for (const id of ids) if (this.rows.delete(id)) n++;
		return n;
	}
```
- in `MemoryKv.query`, replace the sort comparator body with:
```ts
				const av = (a.data as Record<string, number | string>)[field] as number | string;
				const bv = (b.data as Record<string, number | string>)[field] as number | string;
				const order = av < bv ? -1 : av > bv ? 1 : 0;
				return dir === "asc" ? order : -order;
```
- append:
```ts
type StoredFile = { bytes: Uint8Array; lastModified: Date };

/** In-memory `emdash.storage` with the local adapter's range and NOT_FOUND behaviour. */
export class FakeStorage implements UploadStorage {
	readonly files = new Map<string, StoredFile>();
	/** What each upload() call received: a stream or bytes. */
	readonly bodies: Array<"stream" | "bytes"> = [];
	now = () => new Date("2026-10-07T10:00:00Z");

	async upload(options: { key: string; body: Buffer | Uint8Array | ReadableStream<Uint8Array> }) {
		const { body } = options;
		let bytes: Uint8Array;
		this.bodies.push(body instanceof ReadableStream ? "stream" : "bytes");
		if (body instanceof ReadableStream) {
			const chunks: Uint8Array[] = [];
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
			bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
			let at = 0;
			for (const c of chunks) {
				bytes.set(c, at);
				at += c.length;
			}
		} else {
			bytes = new Uint8Array(body);
		}
		this.files.set(options.key, { bytes, lastModified: this.now() });
		return { key: options.key, url: `/media/${options.key}`, size: bytes.length };
	}

	async download(
		key: string,
		options?: { range?: { offset: number; length?: number } | { suffix: number } },
	) {
		const file = this.files.get(key);
		if (!file) throw Object.assign(new Error(`File not found: ${key}`), { code: "NOT_FOUND" });
		const size = file.bytes.length;
		const range = options?.range;
		if (range && "offset" in range && range.offset >= 0 && range.offset < size) {
			const length = Math.min(range.length ?? size, size - range.offset);
			return {
				body: streamOf(file.bytes.slice(range.offset, range.offset + length), 7),
				contentType: "text/csv",
				size,
				range: { offset: range.offset, length },
			};
		}
		return { body: streamOf(file.bytes, 7), contentType: "text/csv", size };
	}

	async delete(key: string) {
		this.files.delete(key);
	}

	async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
		const keys = [...this.files.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
		const start = options?.cursor ? Number(options.cursor) : 0;
		const limit = options?.limit ?? 100;
		const files = keys.slice(start, start + limit).map((key) => {
			const file = this.files.get(key)!;
			return { key, size: file.bytes.length, lastModified: file.lastModified };
		});
		return start + limit < keys.length ? { files, nextCursor: String(start + limit) } : { files };
	}
}
```

Append to `describe("MemoryKv", …)` in `packages/flux-import/tests/unit/fakes.test.ts`:
```ts
	it("deletes rows and orders and filters ISO timestamps", async () => {
		const kv = new MemoryKv<{ at: string }>();
		await kv.put("b", { at: "2026-10-02T00:00:00.000Z" });
		await kv.put("a", { at: "2026-10-01T00:00:00.000Z" });
		await kv.put("c", { at: "2026-10-03T00:00:00.000Z" });
		const page = await kv.query({
			where: { at: { lt: "2026-10-03T00:00:00.000Z" } },
			orderBy: { at: "desc" },
		});
		expect(page.items.map((i) => i.id)).toEqual(["b", "a"]);
		expect(await kv.delete("a")).toBe(true);
		expect(await kv.delete("a")).toBe(false);
		expect(await kv.deleteMany(["b", "c", "x"])).toBe(2);
		expect(kv.rows.size).toBe(0);
	});
```

- [ ] **Step 2: Write the failing adapter tests**

`packages/flux-import/tests/unit/storage.test.ts`:
```ts
import type { StorageCollection } from "emdash";
import { describe, expect, it } from "vitest";
import { kvCollection, pluginCollections } from "../../src/emdash/storage.js";
import { MemoryKv } from "./fakes.js";

/** MemoryKv already has the StorageCollection methods the wrapper calls. */
function asStorage(kv: MemoryKv<unknown>): StorageCollection {
	return kv as unknown as StorageCollection;
}

describe("kvCollection", () => {
	it("passes reads, writes, deletes and queries through", async () => {
		const raw = new MemoryKv<unknown>();
		const kv = kvCollection<{ n: number; tag: string }>(asStorage(raw));
		await kv.put("a", { n: 1, tag: "x" });
		await kv.put("b", { n: 2, tag: "y" });
		expect(await kv.get("a")).toEqual({ n: 1, tag: "x" });
		const v = await kv.getVersioned("a");
		expect(await kv.compareAndSet("a", v!.revision, { n: 3, tag: "x" })).toMatchObject({
			applied: true,
		});
		const page = await kv.query({ where: { tag: "x" }, orderBy: { n: "asc" } });
		expect(page.items).toEqual([{ id: "a", data: { n: 3, tag: "x" } }]);
		expect((await kv.query({ limit: 10 })).items).toHaveLength(2);
		expect(await kv.deleteMany(["a"])).toBe(1);
		expect(await kv.delete("b")).toBe(true);
	});
});

describe("pluginCollections", () => {
	it("requires the jobs, records and links collections", () => {
		const s = asStorage(new MemoryKv<unknown>());
		expect(() => pluginCollections({ jobs: s, records: s })).toThrow("storage collections");
		expect(Object.keys(pluginCollections({ jobs: s, records: s, links: s }))).toEqual([
			"jobs",
			"records",
			"links",
		]);
	});
});
```

`packages/flux-import/tests/unit/uploads.test.ts`:
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	EmDashUploads,
	isUploadId,
	newUploadId,
	stageUpload,
	UPLOAD_PREFIX,
	UploadTooLargeError,
	uploadKey,
} from "../../src/emdash/uploads.js";
import { SourceMissingError } from "../../src/engine/ports.js";
import { FakeStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const text = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("upload IDs", () => {
	it("are a ULID plus 32 hex characters and unique", () => {
		const a = newUploadId();
		const b = newUploadId();
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
		expect(uploadKey(a)).toBe(`${UPLOAD_PREFIX}${a}.csv`);
	});

	it("reject anything that could reach another storage path", () => {
		for (const bad of [
			"",
			"../backups/x",
			`${newUploadId()}/x`,
			"01ARZ3NDEKTSV4RRFFQ69G5FAV",
			"a".repeat(58),
		]) {
			expect(isUploadId(bad)).toBe(false);
			expect(() => uploadKey(bad)).toThrow(SourceMissingError);
		}
	});
});

describe("stageUpload", () => {
	it("stores the body under the upload key and reports size and SHA-256", async () => {
		const storage = new FakeStorage();
		const body = "sku,name\nA,1\n";
		const staged = await stageUpload(storage, streamOf(body, 3), 1024);
		expect(staged.bytes).toBe(body.length);
		expect(staged.sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(new TextDecoder().decode(storage.files.get(uploadKey(staged.uploadId))!.bytes)).toBe(
			body,
		);
	});

	it("fails past the limit and leaves nothing in storage", async () => {
		const storage = new FakeStorage();
		await expect(stageUpload(storage, streamOf("x".repeat(100), 10), 99)).rejects.toBeInstanceOf(
			UploadTooLargeError,
		);
		expect(storage.files.size).toBe(0);
	});

	it("rejects a declared length over the limit before reading", async () => {
		const storage = new FakeStorage();
		await expect(stageUpload(storage, streamOf("x"), 99, 100)).rejects.toBeInstanceOf(
			UploadTooLargeError,
		);
		expect(storage.bodies).toEqual([]);
	});

	it("gives Workers storage a known-length stream, or bytes when the length is unknown", async () => {
		const lengths: number[] = [];
		class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
			constructor(length: number) {
				super();
				lengths.push(length);
			}
		}
		const global = globalThis as { FixedLengthStream?: unknown };
		global.FixedLengthStream = FakeFixedLengthStream;
		try {
			const storage = new FakeStorage();
			await stageUpload(storage, streamOf("a,b\n", 2), 100, 4);
			await stageUpload(storage, streamOf("a,b\n", 2), 100);
			expect(lengths).toEqual([4]);
			expect(storage.bodies).toEqual(["stream", "bytes"]);
			expect([...storage.files.values()].map((f) => new TextDecoder().decode(f.bytes))).toEqual([
				"a,b\n",
				"a,b\n",
			]);
		} finally {
			delete global.FixedLengthStream;
		}
	});

	it("accepts a body of exactly the limit", async () => {
		const storage = new FakeStorage();
		const staged = await stageUpload(storage, streamOf("x".repeat(99), 10), 99);
		expect(staged.bytes).toBe(99);
	});
});

describe("EmDashUploads", () => {
	async function staged(body: string) {
		const storage = new FakeStorage();
		const { uploadId } = await stageUpload(storage, streamOf(body), 1 << 20);
		return { storage, uploads: new EmDashUploads(storage), uploadId };
	}

	it("opens at an offset with a ranged read", async () => {
		const { uploads, uploadId } = await staged("0123456789");
		expect(await text(await uploads.open(uploadId, 0))).toBe("0123456789");
		expect(await text(await uploads.open(uploadId, 4))).toBe("456789");
	});

	it("returns an empty stream at or past the end instead of the whole file", async () => {
		const { uploads, uploadId } = await staged("0123456789");
		expect(await text(await uploads.open(uploadId, 10))).toBe("");
		expect(await text(await uploads.open(uploadId, 25))).toBe("");
	});

	it("fails loudly when storage ignores the range", async () => {
		const { storage, uploads, uploadId } = await staged("0123456789");
		const real = storage.download.bind(storage);
		storage.download = (key) => real(key);
		await expect(uploads.open(uploadId, 4)).rejects.toThrow("ignored the byte range");
	});

	it("maps a missing file or a malformed ID to SourceMissingError", async () => {
		const { uploads } = await staged("x");
		await expect(uploads.open(newUploadId(), 0)).rejects.toBeInstanceOf(SourceMissingError);
		await expect(uploads.open("../../etc/passwd", 0)).rejects.toBeInstanceOf(SourceMissingError);
	});

	it("deletes one upload and purges files older than a cutoff", async () => {
		const { storage, uploads, uploadId } = await staged("old");
		storage.now = () => new Date("2026-10-09T00:00:00Z");
		const { uploadId: fresh } = await stageUpload(storage, streamOf("new"), 100);
		const removed = await uploads.purgeBefore(new Date("2026-10-08T00:00:00Z"));
		expect(removed).toBe(1);
		expect(storage.files.has(uploadKey(uploadId))).toBe(false);
		expect(storage.files.has(uploadKey(fresh))).toBe(true);
		await uploads.delete(fresh);
		await uploads.delete(fresh);
		expect(storage.files.size).toBe(0);
	});
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/storage.test.ts tests/unit/uploads.test.ts tests/unit/fakes.test.ts`
Expected: FAIL — `src/emdash/storage.js` and `src/emdash/uploads.js` do not exist.

- [ ] **Step 4: Implement**

`packages/flux-import/src/emdash/storage.ts`:
```ts
import type { StorageCollection } from "emdash";
import type { KvCollection } from "../engine/ports.js";
import type { Job, LinkRow, RecordRow } from "../engine/types.js";

type StorageWhere = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;

/**
 * Types a plugin storage collection for the engine. Plugin storage holds JSON documents and
 * returns them untyped (`emdash` `StorageCollection<unknown>`); this plugin is their only writer,
 * so the casts restore the type it stored.
 */
export function kvCollection<T>(collection: StorageCollection): KvCollection<T> {
	return {
		get: async (id) => (await collection.get(id)) as T | null,
		put: (id, data) => collection.put(id, data),
		delete: (id) => collection.delete(id),
		deleteMany: (ids) => collection.deleteMany(ids),
		getVersioned: async (id) =>
			(await collection.getVersioned(id)) as { value: T; revision: string } | null,
		compareAndSet: (id, expectedRevision, data) =>
			collection.compareAndSet(id, expectedRevision, data),
		query: async ({ where, ...rest }) => {
			const page = await collection.query({
				...rest,
				...(where ? { where: where as StorageWhere } : {}),
			});
			return page as { items: { id: string; data: T }[]; cursor?: string; hasMore: boolean };
		},
	};
}

export interface PluginCollections {
	jobs: KvCollection<Job>;
	records: KvCollection<RecordRow>;
	links: KvCollection<LinkRow>;
}

/** The three collections declared in the plugin definition, typed for the engine. */
export function pluginCollections(
	storage: Record<string, StorageCollection | undefined>,
): PluginCollections {
	const { jobs, records, links } = storage;
	if (!jobs || !records || !links) {
		throw new Error("flux-import: the jobs, records and links storage collections are missing");
	}
	return {
		jobs: kvCollection<Job>(jobs),
		records: kvCollection<RecordRow>(records),
		links: kvCollection<LinkRow>(links),
	};
}
```

`packages/flux-import/src/emdash/uploads.ts`:
```ts
import { createHash } from "node:crypto";
import type { Storage } from "emdash";
import { ulid } from "emdash";
import { SourceMissingError, type SourcePort } from "../engine/ports.js";

/**
 * Staged source files live in `emdash.storage`, which serves every key outside `backups/` and
 * `transfers/` publicly at `/_emdash/api/media/file/<key>` (verification report, question 7).
 * The upload ID is therefore a secret: a ULID plus 128 random bits, returned only to the
 * authenticated uploader and to `import:execute` routes.
 *
 * Keys are flat (no `/`): the local adapter's `list()` splits a prefix into a directory and a file
 * name prefix (src/storage/local.ts:175-200), so a prefix ending in `/` would list the parent.
 */
export const UPLOAD_PREFIX = "flux-import-upload-";
const UPLOAD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}$/;
const PAGE = 100;

export type UploadStorage = Pick<Storage, "upload" | "download" | "delete" | "list">;

export function newUploadId(): string {
	const random = crypto.getRandomValues(new Uint8Array(16));
	return ulid() + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isUploadId(value: string): boolean {
	return UPLOAD_ID_RE.test(value);
}

/** Never builds a key from an unchecked ID, so input cannot reach another storage path. */
export function uploadKey(uploadId: string): string {
	if (!isUploadId(uploadId)) throw new SourceMissingError(uploadId);
	return `${UPLOAD_PREFIX}${uploadId}.csv`;
}

function errorCode(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
		? e.code
		: undefined;
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

export class UploadTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`The upload exceeds the limit of ${limit} bytes`);
		this.name = "UploadTooLargeError";
	}
}

export class EmDashUploads implements SourcePort {
	constructor(private readonly storage: UploadStorage) {}

	async open(uploadId: string, offset: number): Promise<ReadableStream<Uint8Array>> {
		const key = uploadKey(uploadId);
		let result: Awaited<ReturnType<UploadStorage["download"]>>;
		try {
			result = await this.storage.download(key, offset > 0 ? { range: { offset } } : undefined);
		} catch (e) {
			// The local adapter throws EmDashStorageError("…", "NOT_FOUND") (src/storage/local.ts:118).
			if (errorCode(e) === "NOT_FOUND") throw new SourceMissingError(uploadId);
			throw e;
		}
		// An offset at or past the end returns the whole file without `range`
		// (src/storage/range.ts:52-53), so check the size before trusting the body.
		if (offset >= result.size) {
			await result.body.cancel();
			return emptyStream();
		}
		if (offset > 0 && result.range?.offset !== offset) {
			await result.body.cancel();
			throw new Error(
				`Storage ignored the byte range starting at ${offset} for upload ${uploadId}`,
			);
		}
		return result.body;
	}

	async delete(uploadId: string): Promise<void> {
		try {
			await this.storage.delete(uploadKey(uploadId));
		} catch (e) {
			if (errorCode(e) !== "NOT_FOUND") throw e;
		}
	}

	/** Deletes staged files last modified before `cutoff`, including ones no job references. */
	async purgeBefore(cutoff: Date): Promise<number> {
		const expired: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.storage.list({
				prefix: UPLOAD_PREFIX,
				limit: PAGE,
				...(cursor ? { cursor } : {}),
			});
			for (const file of page.files) {
				if (file.lastModified.getTime() < cutoff.getTime()) expired.push(file.key);
			}
			cursor = page.nextCursor;
		} while (cursor);
		for (const key of expired) await this.storage.delete(key);
		return expired.length;
	}
}

export interface StagedUpload {
	uploadId: string;
	bytes: number;
	sha256: string;
}

/** Workers-only (`FixedLengthStream`): R2 `put()` needs a stream whose length is known. */
type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/**
 * Streams `body` into storage under a new upload ID, counting and hashing on the way and failing
 * once more than `maxBytes` arrive. The local adapter buffers the stream before writing
 * (src/storage/local.ts:84-94), so an oversized upload writes nothing there; the key is still
 * deleted on failure for adapters that might write partially.
 *
 * On Workers, R2 `put()` (@emdash-cms/cloudflare src/storage/r2.ts:55-83 passes the body
 * straight to the binding) rejects a stream of unknown length, so the counted stream goes through
 * `FixedLengthStream` when the request declared its length, and is buffered (at most
 * `maxBytes`) when it did not.
 */
export async function stageUpload(
	storage: UploadStorage,
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	declaredLength?: number,
): Promise<StagedUpload> {
	if (declaredLength !== undefined && declaredLength > maxBytes) {
		throw new UploadTooLargeError(maxBytes);
	}
	const uploadId = newUploadId();
	const key = uploadKey(uploadId);
	const hash = createHash("sha256");
	let bytes = 0;
	const counted = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > maxBytes) {
					controller.error(new UploadTooLargeError(maxBytes));
					return;
				}
				hash.update(chunk);
				controller.enqueue(chunk);
			},
		}),
	);
	const FixedLength = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor })
		.FixedLengthStream;
	try {
		let upload: ReadableStream<Uint8Array> | Uint8Array = counted;
		if (FixedLength) {
			upload =
				declaredLength === undefined
					? await readAll(counted)
					: counted.pipeThrough(new FixedLength(declaredLength));
		}
		await storage.upload({ key, body: upload, contentType: "text/csv" });
	} catch (e) {
		await storage.delete(key).catch(() => {});
		if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes);
		throw e;
	}
	return { uploadId, bytes, sha256: hash.digest("hex") };
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/storage.test.ts tests/unit/uploads.test.ts tests/unit/fakes.test.ts`
Expected: PASS (2 + 12 + 3 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/engine/ports.ts packages/flux-import/src/emdash packages/flux-import/tests/unit/fakes.ts packages/flux-import/tests/unit/fakes.test.ts packages/flux-import/tests/unit/storage.test.ts packages/flux-import/tests/unit/uploads.test.ts
git commit -m "Add plugin storage and staged upload adapters

Uploads get an unguessable ID that is also their only key, ranged reads treat
an offset at or past the end as end of input, and Workers storage receives a
known-length stream."
```

### Task 5: Schema and lock adapters

**Files:**
- Create: `packages/flux-import/src/emdash/schema.ts`, `packages/flux-import/src/emdash/locks.ts`
- Test: `packages/flux-import/tests/unit/schema.test.ts`, `packages/flux-import/tests/unit/locks.test.ts`

**Interfaces:**
- Consumes: `ContentWriteError` (`src/engine/ports.ts`), `SOURCE_ID_FIELD`, `SchemaField` (`src/engine/template.ts`); `Database` type from `emdash` (`src/index.ts:12`); `Kysely`, `PostgresAdapter`, `sql` from `kysely` (Task 3).
- Produces:
  - `interface SchemaRegistryLike { getField(collectionSlug: string, fieldSlug: string): Promise<{ type: string; indexed: boolean } | null>; createField(collectionSlug: string, input: { slug: string; label: string; type: "string"; indexed: boolean; translatable: boolean }): Promise<unknown>; updateField(collectionSlug: string, fieldSlug: string, input: { indexed: boolean }): Promise<unknown>; getCollectionWithFields(slug: string): Promise<{ fields: Array<{ slug: string; type: string }> } | null> }` — `EmDashRuntime.schemaRegistry` (`src/emdash-runtime.ts:759`) is assignable to it (checked with `tsc` while writing this plan).
  - `ensureSourceIdField(registry: SchemaRegistryLike, collection: string): Promise<void>` — idempotent; throws `ContentWriteError("collection_missing")` or `ContentWriteError("source_id_field_invalid")`.
  - `listSchemaFields(registry: SchemaRegistryLike, collection: string): Promise<SchemaField[] | null>`.
  - `type EmDashDb = Kysely<Database>`; `isPostgres(db: EmDashDb): boolean`; `foreignLockQuery(db, collection, entryId, userId)` (a Kysely select builder); `isEntryLocked(db: EmDashDb, collection: string, entryId: string, userId: string): Promise<boolean>`.

Facts: `createField` throws `SchemaError` with `code` `FIELD_EXISTS`, `RESERVED_SLUG` or `COLLECTION_NOT_FOUND` (`src/schema/registry.ts:1276-1294`), matched by `code` because a second `emdash` copy may load; `updateField` accepts `{ indexed }` (`src/schema/types.ts:428-449`). The lock rule is `EntryLockRepository.findEnforceable` (`src/database/repositories/entry-locks.ts:112-122`) with the clock comparison at `:230-235`; the importer's own lease counts as unlocked (report, question 3).

- [ ] **Step 1: Write the failing tests**

`packages/flux-import/tests/unit/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	ensureSourceIdField,
	listSchemaFields,
	type SchemaRegistryLike,
} from "../../src/emdash/schema.js";
import { ContentWriteError } from "../../src/engine/ports.js";

type Field = { slug: string; type: string; indexed: boolean; translatable: boolean };

class FakeRegistry implements SchemaRegistryLike {
	readonly collections = new Map<string, Field[]>([
		["products", [{ slug: "title", type: "string", indexed: false, translatable: true }]],
	]);
	readonly calls: string[] = [];
	/** Simulates another request creating the field between our read and our create. */
	raceOnCreate = false;

	async getField(collection: string, slug: string) {
		return this.collections.get(collection)?.find((f) => f.slug === slug) ?? null;
	}
	async createField(collection: string, input: Field & { label: string }) {
		this.calls.push(`create:${collection}`);
		const fields = this.collections.get(collection);
		if (!fields)
			throw Object.assign(new Error("not found"), {
				name: "SchemaError",
				code: "COLLECTION_NOT_FOUND",
			});
		if (this.raceOnCreate) {
			fields.push({ slug: input.slug, type: "string", indexed: true, translatable: false });
			throw Object.assign(new Error("exists"), { name: "SchemaError", code: "FIELD_EXISTS" });
		}
		fields.push({
			slug: input.slug,
			type: input.type,
			indexed: input.indexed,
			translatable: input.translatable,
		});
		return {};
	}
	async updateField(collection: string, slug: string, input: { indexed: boolean }) {
		this.calls.push(`update:${collection}:${slug}:${input.indexed}`);
		const field = this.collections.get(collection)!.find((f) => f.slug === slug)!;
		field.indexed = input.indexed;
		return {};
	}
	async getCollectionWithFields(slug: string) {
		const fields = this.collections.get(slug);
		return fields ? { fields } : null;
	}
}

describe("ensureSourceIdField", () => {
	it("creates an indexed, non-translatable string field once", async () => {
		const registry = new FakeRegistry();
		await ensureSourceIdField(registry, "products");
		await ensureSourceIdField(registry, "products");
		expect(registry.calls).toEqual(["create:products"]);
		expect(await registry.getField("products", "flux_source_id")).toEqual({
			slug: "flux_source_id",
			type: "string",
			indexed: true,
			translatable: false,
		});
	});

	it("indexes an existing unindexed field", async () => {
		const registry = new FakeRegistry();
		registry.collections
			.get("products")!
			.push({ slug: "flux_source_id", type: "string", indexed: false, translatable: true });
		await ensureSourceIdField(registry, "products");
		expect(registry.calls).toEqual(["update:products:flux_source_id:true"]);
	});

	it("accepts a field another request created first", async () => {
		const registry = new FakeRegistry();
		registry.raceOnCreate = true;
		await expect(ensureSourceIdField(registry, "products")).resolves.toBeUndefined();
	});

	it("reports a missing collection and a field of the wrong type", async () => {
		const registry = new FakeRegistry();
		await expect(ensureSourceIdField(registry, "nope")).rejects.toMatchObject({
			code: "collection_missing",
		});
		registry.collections
			.get("products")!
			.push({ slug: "flux_source_id", type: "number", indexed: true, translatable: true });
		const error = await ensureSourceIdField(registry, "products").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "source_id_field_invalid" });
	});
});

describe("listSchemaFields", () => {
	it("lists slugs and types, or null for an unknown collection", async () => {
		const registry = new FakeRegistry();
		expect(await listSchemaFields(registry, "products")).toEqual([
			{ slug: "title", type: "string" },
		]);
		expect(await listSchemaFields(registry, "nope")).toBeNull();
	});
});
```

`packages/flux-import/tests/unit/locks.test.ts`:
```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/schema.test.ts tests/unit/locks.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/emdash/schema.ts`:
```ts
import { ContentWriteError } from "../engine/ports.js";
import { type SchemaField, SOURCE_ID_FIELD } from "../engine/template.js";

/**
 * The part of EmDash's `SchemaRegistry` this plugin uses (`emdash` src/schema/registry.ts:380,
 * :393, :1259, :1276, :1417). `EmDashRuntime.schemaRegistry` (src/emdash-runtime.ts:759) is
 * assignable to it.
 */
export interface SchemaRegistryLike {
	getField(
		collectionSlug: string,
		fieldSlug: string,
	): Promise<{ type: string; indexed: boolean } | null>;
	createField(
		collectionSlug: string,
		input: { slug: string; label: string; type: "string"; indexed: boolean; translatable: boolean },
	): Promise<unknown>;
	updateField(
		collectionSlug: string,
		fieldSlug: string,
		input: { indexed: boolean },
	): Promise<unknown>;
	getCollectionWithFields(
		slug: string,
	): Promise<{ fields: Array<{ slug: string; type: string }> } | null>;
}

/** `SchemaError` is matched by its `code`: the plugin may load a second copy of `emdash`. */
function schemaErrorCode(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
		? e.code
		: undefined;
}

/**
 * Adds `flux_source_id` (`string`, indexed, not translatable) to the collection, or makes an
 * existing one indexed. Idempotent and safe against a concurrent creator. Throws
 * `ContentWriteError("collection_missing")` when the collection does not exist.
 */
export async function ensureSourceIdField(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<void> {
	let field = await registry.getField(collection, SOURCE_ID_FIELD);
	if (!field) {
		try {
			await registry.createField(collection, {
				slug: SOURCE_ID_FIELD,
				label: "Flux source ID",
				type: "string",
				indexed: true,
				translatable: false,
			});
			return;
		} catch (e) {
			const code = schemaErrorCode(e);
			if (code === "COLLECTION_NOT_FOUND") {
				throw new ContentWriteError(
					"collection_missing",
					`Collection "${collection}" does not exist`,
				);
			}
			if (code !== "FIELD_EXISTS") throw e;
			field = await registry.getField(collection, SOURCE_ID_FIELD);
			if (!field) throw e;
		}
	}
	if (field.type !== "string" && field.type !== "text") {
		throw new ContentWriteError(
			"source_id_field_invalid",
			`Field "${SOURCE_ID_FIELD}" in "${collection}" has type "${field.type}"; it must be "string" or "text"`,
		);
	}
	if (!field.indexed) await registry.updateField(collection, SOURCE_ID_FIELD, { indexed: true });
}

/** The collection's fields for `checkTemplate`, or `null` when the collection does not exist. */
export async function listSchemaFields(
	registry: SchemaRegistryLike,
	collection: string,
): Promise<SchemaField[] | null> {
	const found = await registry.getCollectionWithFields(collection);
	return found ? found.fields.map((f) => ({ slug: f.slug, type: f.type })) : null;
}
```

`packages/flux-import/src/emdash/locks.ts`:
```ts
import type { Database } from "emdash";
import { type Kysely, PostgresAdapter, sql } from "kysely";

export type EmDashDb = Kysely<Database>;

/** Same detection as EmDash's own `isPostgres` (src/database/dialect-helpers.ts:33-46). */
export function isPostgres(db: EmDashDb): boolean {
	return db.getExecutor().adapter instanceof PostgresAdapter;
}

/**
 * A live lease on the entry, held by anyone but `userId`, on a collection with edit locking on.
 *
 * EmDash has no public lock API, so this reads the internal `_emdash_entry_locks` table the way
 * `EntryLockRepository.findEnforceable` does (src/database/repositories/entry-locks.ts:112-122,
 * :230-235): `expires_at` is compared to the database clock in the dialect's own form. The lock
 * table has no locale column; entry IDs are per-locale rows, so the entry ID scopes the locale.
 * An integration test pins this query because the table is internal.
 */
export function foreignLockQuery(
	db: EmDashDb,
	collection: string,
	entryId: string,
	userId: string,
) {
	const expiresAt = sql.ref("_emdash_entry_locks.expires_at");
	const live = isPostgres(db)
		? sql<boolean>`${expiresAt}::timestamptz > clock_timestamp()`
		: sql<boolean>`${expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	return db
		.selectFrom("_emdash_entry_locks")
		.innerJoin("_emdash_collections", "_emdash_collections.slug", "_emdash_entry_locks.collection")
		.select("_emdash_entry_locks.user_id")
		.where("_emdash_entry_locks.collection", "=", collection)
		.where("_emdash_entry_locks.entry_id", "=", entryId)
		.where("_emdash_entry_locks.user_id", "!=", userId)
		.where("_emdash_collections.edit_locking", "!=", 0)
		.where(live)
		.limit(1);
}

export async function isEntryLocked(
	db: EmDashDb,
	collection: string,
	entryId: string,
	userId: string,
): Promise<boolean> {
	return (await foreignLockQuery(db, collection, entryId, userId).executeTakeFirst()) !== undefined;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/schema.test.ts tests/unit/locks.test.ts`
Expected: PASS (5 + 3 tests; the SQLite parameters are exactly `["products", "e1", "u1", 0, 1]`). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/emdash/schema.ts packages/flux-import/src/emdash/locks.ts packages/flux-import/tests/unit/schema.test.ts packages/flux-import/tests/unit/locks.test.ts
git commit -m "Add the source-ID field and edit-lock adapters

The field is created indexed and not translatable, or indexed when it exists.
Locks are read from the internal lock table with the dialect's clock, and a
lease held by the importing user does not count."
```

### Task 6: ContentPort adapter

**Files:**
- Create: `packages/flux-import/src/emdash/content.ts`
- Modify: `packages/flux-import/src/engine/ports.ts` (`EntrySnapshot.pendingPublish` comment)
- Test: `packages/flux-import/tests/unit/content.test.ts`

**Interfaces:**
- Consumes: `ContentPort`, `ContentWriteError`, `EntrySnapshot`, `WriteResult` (`src/engine/ports.ts`); `FieldValue`, `SOURCE_ID_FIELD` (`src/engine/template.ts`); `ensureSourceIdField`, `SchemaRegistryLike` (Task 5); `ActorInfo`, `ContentFieldFilters` from `emdash` (`src/plugins/types.ts:1391`, `src/content-list-query.ts:29`).
- Produces:
  - `type HandlerResult = { success: boolean; data?: unknown; error?: { code: string; message: string } }`.
  - `interface ContentRuntime` with `schemaRegistry: SchemaRegistryLike` and `handleContentGet(collection, id, locale?)`, `handleContentList(collection, { locale?, limit?, fieldFilters? })`, `handleContentCreate(collection, { data, slug?, locale?, actor? })`, `handleContentUpdate(collection, id, { data?, slug?, locale?, _rev?, actor? })`, `handleContentPublish(collection, id, { _rev?, actor? }?)`, each `Promise<HandlerResult>`. `EmDashRuntime` from `emdash/middleware` is assignable to it (checked with `tsc`).
  - `type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>`.
  - `class EmDashContent implements ContentPort { constructor(runtime: ContentRuntime, actor: ActorInfo, lockReader: LockReader) }` (Task 9 builds it with `isEntryLocked`).
  - Mapping (exactly as `ports.ts` documents): `CONFLICT` on update or publish → `{ ok: false, reason: "conflict" }`; a foreign lock before publish → `{ ok: false, reason: "locked" }`; `NOT_FOUND` on get → `null`; any other EmDash error → `ContentWriteError("emdash_<code>")`; a malformed response → `ContentWriteError("emdash_bad_response")`; more than one source-ID match → `ContentWriteError("ambiguous_source_id")`.

Facts: envelopes and `_rev` (report, question 1); create defaults to `status: "draft"` (`src/api/handlers/content.ts:1323`); create, update, publish and get all return `{ item, _rev }` (`src/api/handlers/content.ts:1135`, `:2495`); `fieldFilters` needs an indexed field and at most 20 filters (report, question 2); F10, F11.

- [ ] **Step 1: Write the failing tests**

`packages/flux-import/tests/unit/content.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	type ContentRuntime,
	EmDashContent,
	type HandlerResult,
} from "../../src/emdash/content.js";
import type { SchemaRegistryLike } from "../../src/emdash/schema.js";
import { ContentWriteError } from "../../src/engine/ports.js";

type Item = {
	id: string;
	slug: string | null;
	status: string;
	locale: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	version: number;
};

const ok = (data: unknown): HandlerResult => ({ success: true, data });
const fail = (code: string, message = code): HandlerResult => ({
	success: false,
	error: { code, message },
});

/** Mimics the runtime handlers' envelopes and `_rev` checks (verification report, question 1). */
class FakeRuntime implements ContentRuntime {
	readonly items = new Map<string, Item>();
	readonly calls: unknown[] = [];
	listOverride: HandlerResult | null = null;
	private next = 0;
	readonly schemaRegistry = {} as SchemaRegistryLike;

	private envelope(item: Item) {
		return ok({ item: { ...item, authorId: null }, _rev: `rev-${item.version}` });
	}
	async handleContentGet(_c: string, id: string) {
		const item = this.items.get(id);
		return item ? this.envelope(item) : fail("NOT_FOUND");
	}
	async handleContentList(collection: string, params: Record<string, unknown>) {
		this.calls.push(["list", collection, params]);
		if (this.listOverride) return this.listOverride;
		const filters = params.fieldFilters as Record<string, unknown>;
		const items = [...this.items.values()].filter(
			(i) => i.locale === params.locale && i.data.flux_source_id === filters.flux_source_id,
		);
		return ok({ items: items.slice(0, params.limit as number) });
	}
	async handleContentCreate(collection: string, body: Record<string, unknown>) {
		this.calls.push(["create", collection, body]);
		const id = `e${++this.next}`;
		const item: Item = {
			id,
			slug: (body.slug as string | undefined) ?? null,
			status: "draft",
			locale: body.locale as string,
			data: body.data as Record<string, unknown>,
			draftRevisionId: null,
			version: 1,
		};
		this.items.set(id, item);
		return this.envelope(item);
	}
	async handleContentUpdate(collection: string, id: string, body: Record<string, unknown>) {
		this.calls.push(["update", collection, id, body]);
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (body._rev !== `rev-${item.version}`) return fail("CONFLICT", "version conflict");
		item.data = { ...item.data, ...(body.data as Record<string, unknown>) };
		item.draftRevisionId = `d${item.version}`;
		item.version++;
		return this.envelope(item);
	}
	async handleContentPublish(
		collection: string,
		id: string,
		options: Record<string, unknown> = {},
	) {
		this.calls.push(["publish", collection, id, options]);
		const item = this.items.get(id);
		if (!item) return fail("NOT_FOUND");
		if (options._rev !== `rev-${item.version}`)
			return fail("CONFLICT", "Revision precondition did not match");
		item.status = "published";
		item.draftRevisionId = null;
		item.version++;
		return this.envelope(item);
	}
}

const actor = { id: "u1", role: 50 };

function setup(locked: (c: string, id: string, user: string) => boolean = () => false) {
	const runtime = new FakeRuntime();
	const lockCalls: string[] = [];
	const content = new EmDashContent(runtime, actor, async (c, id, user) => {
		lockCalls.push(`${c}/${id}/${user}`);
		return locked(c, id, user);
	});
	return { runtime, content, lockCalls };
}

describe("EmDashContent", () => {
	it("creates, updates and publishes with the returned revisions and the actor", async () => {
		const { runtime, content } = setup();
		const created = await content.create({
			collection: "products",
			locale: "en",
			slug: "a",
			data: { title: "A", flux_source_id: "S1" },
		});
		expect(created).toEqual({ id: "e1", rev: "rev-1" });
		expect(runtime.calls[0]).toEqual([
			"create",
			"products",
			{ data: { title: "A", flux_source_id: "S1" }, locale: "en", actor, slug: "a" },
		]);
		expect(await content.get("products", "en", "e1")).toMatchObject({ pendingPublish: true });

		const published = await content.publish({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-1",
		});
		expect(published).toEqual({ ok: true, rev: "rev-2" });
		expect(await content.get("products", "en", "e1")).toMatchObject({
			rev: "rev-2",
			pendingPublish: false,
		});

		const updated = await content.update({
			collection: "products",
			locale: "en",
			id: "e1",
			rev: "rev-2",
			data: { title: "B" },
		});
		expect(updated).toEqual({ ok: true, rev: "rev-3" });
		expect(runtime.calls[2]).toEqual([
			"update",
			"products",
			"e1",
			{ data: { title: "B" }, locale: "en", _rev: "rev-2", actor },
		]);
		expect(await content.get("products", "en", "e1")).toMatchObject({
			data: { title: "B" },
			pendingPublish: true,
		});
	});

	it("maps CONFLICT to a conflict result on update and publish", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(
			await content.update({
				collection: "products",
				locale: "en",
				id: "e1",
				rev: "stale",
				data: {},
			}),
		).toEqual({ ok: false, reason: "conflict" });
		expect(
			await content.publish({ collection: "products", locale: "en", id: "e1", rev: "stale" }),
		).toEqual({
			ok: false,
			reason: "conflict",
		});
	});

	it("refuses to publish an entry someone else has locked", async () => {
		const { runtime, content, lockCalls } = setup(() => true);
		await content.create({ collection: "products", locale: "en", data: { title: "A" } });
		expect(
			await content.publish({ collection: "products", locale: "en", id: "e1", rev: "rev-1" }),
		).toEqual({
			ok: false,
			reason: "locked",
		});
		expect(lockCalls).toEqual(["products/e1/u1"]);
		expect(runtime.calls.some((c) => (c as string[])[0] === "publish")).toBe(false);
		expect(await content.isLocked("products", "en", "e1")).toBe(true);
	});

	it("turns other EmDash errors into ContentWriteError with an emdash_ code", async () => {
		const { content } = setup();
		const error = await content
			.update({ collection: "products", locale: "en", id: "missing", rev: "r", data: {} })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContentWriteError);
		expect(error).toMatchObject({ code: "emdash_not_found" });
	});

	it("returns null for a missing entry or an entry in another locale", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "fr", data: { title: "A" } });
		expect(await content.get("products", "en", "nope")).toBeNull();
		expect(await content.get("products", "en", "e1")).toBeNull();
		expect(await content.get("products", "fr", "e1")).toMatchObject({ id: "e1" });
	});

	it("finds by source ID with the locale and an indexed field filter", async () => {
		const { runtime, content } = setup();
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		expect(await content.findBySourceId("products", "en", "S1")).toMatchObject({ id: "e1" });
		expect(await content.findBySourceId("products", "en", "S2")).toBeNull();
		expect(runtime.calls).toContainEqual([
			"list",
			"products",
			{ locale: "en", limit: 2, fieldFilters: { flux_source_id: "S1" } },
		]);
	});

	it("never picks one of several entries with the same source ID", async () => {
		const { content } = setup();
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		await content.create({ collection: "products", locale: "en", data: { flux_source_id: "S1" } });
		await expect(content.findBySourceId("products", "en", "S1")).rejects.toMatchObject({
			code: "ambiguous_source_id",
		});
	});

	it("reports a list error, such as an unindexed field, as a ContentWriteError", async () => {
		const { runtime, content } = setup();
		runtime.listOverride = fail("VALIDATION_ERROR", 'Cannot filter by field "flux_source_id"');
		await expect(content.findBySourceId("products", "en", "S1")).rejects.toMatchObject({
			code: "emdash_validation_error",
		});
	});

	it("rejects a response without an item or revision", async () => {
		const { runtime, content } = setup();
		runtime.handleContentGet = async () => ok({ item: { id: "e1" } });
		await expect(content.get("products", "en", "e1")).rejects.toMatchObject({
			code: "emdash_bad_response",
		});
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/content.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/emdash/content.ts`:
```ts
import type { ActorInfo, ContentFieldFilters } from "emdash";
import { z } from "zod";
import {
	type ContentPort,
	ContentWriteError,
	type EntrySnapshot,
	type WriteResult,
} from "../engine/ports.js";
import { type FieldValue, SOURCE_ID_FIELD } from "../engine/template.js";
import { ensureSourceIdField, type SchemaRegistryLike } from "./schema.js";

/** The envelope every runtime content handler returns (`emdash` src/api/types.ts:105). */
export type HandlerResult = {
	success: boolean;
	data?: unknown;
	error?: { code: string; message: string };
};

/**
 * The part of `EmDashRuntime` (from `emdash/middleware`) this adapter calls; the runtime is
 * assignable to it. Signatures: src/emdash-runtime.ts:3336 (list), :3364 (get), :3455 (create),
 * :3649 (update), :4575 (publish), :759 (schemaRegistry).
 */
export interface ContentRuntime {
	readonly schemaRegistry: SchemaRegistryLike;
	handleContentGet(collection: string, id: string, locale?: string): Promise<HandlerResult>;
	handleContentList(
		collection: string,
		params: { locale?: string; limit?: number; fieldFilters?: ContentFieldFilters },
	): Promise<HandlerResult>;
	handleContentCreate(
		collection: string,
		body: { data: Record<string, unknown>; slug?: string; locale?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
	handleContentUpdate(
		collection: string,
		id: string,
		body: {
			data?: Record<string, unknown>;
			slug?: string;
			locale?: string;
			_rev?: string;
			actor?: ActorInfo;
		},
	): Promise<HandlerResult>;
	handleContentPublish(
		collection: string,
		id: string,
		options?: { _rev?: string; actor?: ActorInfo },
	): Promise<HandlerResult>;
}

/** Answers whether anyone but `userId` holds a live lease on the entry. */
export type LockReader = (collection: string, entryId: string, userId: string) => Promise<boolean>;

/** `{ item, _rev }` from get, create, update and publish (src/api/handlers/content.ts:1135). */
const itemResult = z.object({
	item: z.object({
		id: z.string(),
		slug: z.string().nullable(),
		status: z.string(),
		locale: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()),
		draftRevisionId: z.string().nullable().optional(),
	}),
	_rev: z.string(),
});

/** `{ items, nextCursor? }` from list (src/api/types.ts:10). */
const listResult = z.object({ items: z.array(z.object({ id: z.string() })) });

function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		throw new ContentWriteError("emdash_bad_response", `${op}: unexpected response from EmDash`);
	}
	return parsed.data;
}

/**
 * EmDash error codes become `emdash_<code>` record codes, so none can collide with the engine's
 * own codes (`publish_*` codes steer crash repair).
 */
function writeError(op: string, error: HandlerResult["error"]): ContentWriteError {
	const code = error?.code ?? "UNKNOWN_ERROR";
	return new ContentWriteError(
		`emdash_${code.toLowerCase()}`,
		`${op} failed: ${error?.message ?? code}`,
	);
}

function snapshotOf(data: unknown, op: string): EntrySnapshot & { locale: string | null } {
	const { item, _rev } = parse(itemResult, data, op);
	return {
		id: item.id,
		rev: _rev,
		// Slug: the live slug. A slug staged in a draft is not returned by handleContentGet
		// (hydrateDraftData without includeStagedSlug, src/emdash-runtime.ts:3389-3442).
		slug: item.slug,
		data: item.data,
		locale: item.locale ?? null,
		pendingPublish: item.status !== "published" || (item.draftRevisionId ?? null) !== null,
	};
}

/**
 * `ContentPort` over the EmDash runtime. Writes run as `actor` (revision attribution and hooks
 * only; the author is not changed). Lock enforcement is not part of the trusted write path
 * (verification report, question 3), so `isLocked` and `publish` read the lock table.
 */
export class EmDashContent implements ContentPort {
	constructor(
		private readonly runtime: ContentRuntime,
		private readonly actor: ActorInfo,
		private readonly lockReader: LockReader,
	) {}

	async get(collection: string, locale: string, id: string): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentGet(collection, id, locale);
		if (!result.success) {
			if (result.error?.code === "NOT_FOUND") return null;
			throw writeError("Reading the entry", result.error);
		}
		const { locale: entryLocale, ...snapshot } = snapshotOf(result.data, "Reading the entry");
		return entryLocale === null || entryLocale === locale ? snapshot : null;
	}

	async findBySourceId(
		collection: string,
		locale: string,
		sourceId: string,
	): Promise<EntrySnapshot | null> {
		const result = await this.runtime.handleContentList(collection, {
			locale,
			limit: 2,
			fieldFilters: { [SOURCE_ID_FIELD]: sourceId },
		});
		if (!result.success) throw writeError("Looking up the source ID", result.error);
		const { items } = parse(listResult, result.data, "Looking up the source ID");
		if (items.length > 1) {
			throw new ContentWriteError(
				"ambiguous_source_id",
				`More than one entry in "${collection}" (${locale}) has ${SOURCE_ID_FIELD} "${sourceId}"`,
			);
		}
		const [only] = items;
		return only ? this.get(collection, locale, only.id) : null;
	}

	isLocked(collection: string, _locale: string, id: string): Promise<boolean> {
		return this.lockReader(collection, id, this.actor.id);
	}

	async create(input: {
		collection: string;
		locale: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<{ id: string; rev: string }> {
		const result = await this.runtime.handleContentCreate(input.collection, {
			data: input.data,
			locale: input.locale,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) throw writeError("Creating the entry", result.error);
		const { id, rev } = snapshotOf(result.data, "Creating the entry");
		return { id, rev };
	}

	async update(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
		slug?: string;
		data: Record<string, FieldValue>;
	}): Promise<WriteResult> {
		const result = await this.runtime.handleContentUpdate(input.collection, input.id, {
			data: input.data,
			locale: input.locale,
			_rev: input.rev,
			actor: this.actor,
			...(input.slug === undefined ? {} : { slug: input.slug }),
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Updating the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Updating the entry").rev };
	}

	async publish(input: {
		collection: string;
		locale: string;
		id: string;
		rev: string;
	}): Promise<WriteResult> {
		if (await this.lockReader(input.collection, input.id, this.actor.id)) {
			return { ok: false, reason: "locked" };
		}
		const result = await this.runtime.handleContentPublish(input.collection, input.id, {
			_rev: input.rev,
			actor: this.actor,
		});
		if (!result.success) {
			if (result.error?.code === "CONFLICT") return { ok: false, reason: "conflict" };
			throw writeError("Publishing the entry", result.error);
		}
		return { ok: true, rev: snapshotOf(result.data, "Publishing the entry").rev };
	}

	ensureSourceIdField(collection: string): Promise<void> {
		return ensureSourceIdField(this.runtime.schemaRegistry, collection);
	}
}
```

In `packages/flux-import/src/engine/ports.ts`, replace the `pendingPublish` comment
```ts
	/**
	 * The entry has a draft that is not live, or has never been published. Always `false` on
	 * collections without revisions, where writes are live immediately.
	 */
```
with:
```ts
	/**
	 * The entry has a draft that is not live, or is not published (EmDash: `status` is not
	 * `"published"` or `draftRevisionId` is set). On collections without revisions writes are
	 * live immediately, so only an unpublished status counts there.
	 */
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/content.test.ts`
Expected: PASS (9 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/emdash/content.ts packages/flux-import/src/engine/ports.ts packages/flux-import/tests/unit/content.test.ts
git commit -m "Implement ContentPort over the EmDash runtime handlers"
```

### Task 7: Plugin service layer

**Files:**
- Create: `packages/flux-import/src/plugin/service.ts`
- Test: `packages/flux-import/tests/unit/service.test.ts`

**Interfaces:**
- Consumes: `runBatch` (`src/engine/batch.ts`), `createJob`, `CreateJobInput`, `JobError`, `transitionJob` (`src/engine/jobs.ts`), `buildLogCsv` (`src/engine/log.ts`), `SourceMissingError`, `CsvSyntaxError`, `readCsvSample`, `CsvSample` (Task 2), `EngineDeps`, `Job`, `JobStatus`, `RecordRow`, `RecordStatus`, `SchemaField`.
- Produces (`src/plugin/service.ts`): `PAGE_SIZE = 50`; `SAMPLE_MAX = 20`; `LOG_MAX_BYTES = 8 * 1024 * 1024`; `class ServiceError extends Error { readonly code: string; readonly status: number }`; `interface UploadStore { delete(uploadId: string): Promise<void> }`; `interface Page<T> { items: T[]; cursor?: string; hasMore: boolean }`; `sampleSource(deps, uploadId, n): Promise<CsvSample>`; `type StartJobInput = Omit<CreateJobInput, "schemaFields">`; `type FieldLookup = (collection: string) => Promise<SchemaField[] | null>`; `startJob(deps, input: StartJobInput, lookupFields: FieldLookup): Promise<Job>`; `getJob(deps, id): Promise<Job>`; `uploadNeeded(job: Job): boolean`; `releaseUploadIfUnused(deps, uploads: UploadStore, job: Job): Promise<boolean>`; `nextBatch(deps, uploads, id, holder): Promise<Job>`; `changeJob(deps, uploads, id, action: "pause" | "resume" | "cancel" | "retry"): Promise<Job>`; `listJobs(deps, { status?, cursor? }): Promise<Page<Job>>`; `listRecords(deps, { id, status?, cursor? }): Promise<Page<RecordRow>>`; `jobLogCsv(deps, id, status?): Promise<string>`. `deps` is always `EngineDeps`.

Errors: missing upload → `ServiceError("UPLOAD_NOT_FOUND", …, 404)`; unreadable CSV → `ServiceError("INVALID_SOURCE", …, 400)`; log over 8 MiB → `ServiceError("LOG_TOO_LARGE", …, 413)` (F5); unknown job or collection → `JobError` (`not_found` / `invalid_template`), mapped to HTTP in Task 9.

- [ ] **Step 1: Write the failing tests**

`packages/flux-import/tests/unit/service.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { JobError } from "../../src/engine/jobs.js";
import type { Job } from "../../src/engine/types.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	LOG_MAX_BYTES,
	listJobs,
	listRecords,
	nextBatch,
	releaseUploadIfUnused,
	ServiceError,
	sampleSource,
	startJob,
	uploadNeeded,
} from "../../src/plugin/service.js";
import { makeDeps } from "./fakes.js";

const template = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" }, price: { from: "Price", type: "number" } },
};
const fields = async (collection: string) =>
	collection === "products"
		? [
				{ slug: "title", type: "string" },
				{ slug: "price", type: "number" },
			]
		: null;

function csv(n: number, bad: (i: number) => boolean = () => false): string {
	let out = "sku,Name,Price\n";
	for (let i = 0; i < n; i++) out += `S${i},Item ${i},${bad(i) ? "x" : i}\n`;
	return out;
}

class Uploads {
	readonly deleted: string[] = [];
	async delete(id: string) {
		this.deleted.push(id);
	}
}

async function drive(deps: ReturnType<typeof makeDeps>["deps"], uploads: Uploads, id: string) {
	for (let i = 0; i < 100; i++) {
		const job = await nextBatch(deps, uploads, id, `h${i}`);
		if (job.status !== "running") return job;
	}
	throw new Error("did not finish");
}

describe("sampleSource", () => {
	it("returns headers and at most 20 rows", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(30));
		const sample = await sampleSource(deps, "u1", 50);
		expect(sample.headers).toEqual(["sku", "Name", "Price"]);
		expect(sample.rows).toHaveLength(20);
	});

	it("reports a missing upload as 404 and an unreadable one as 400", async () => {
		const { deps } = makeDeps();
		deps.source.add("bad", 'sku\n"open');
		await expect(sampleSource(deps, "nope", 5)).rejects.toMatchObject({
			code: "UPLOAD_NOT_FOUND",
			status: 404,
		});
		await expect(sampleSource(deps, "bad", 5)).rejects.toMatchObject({
			code: "INVALID_SOURCE",
			status: 400,
		});
	});
});

describe("startJob", () => {
	it("checks the template against the collection's fields", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		expect(job).toMatchObject({ status: "created", dryRun: true, publish: true });
	});

	it("rejects an unknown collection and an invalid template", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const unknown = await startJob(
			deps,
			{ uploadId: "u1", template: { ...template, collection: "nope" }, dryRun: false },
			fields,
		).catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(JobError);
		expect(unknown).toMatchObject({ code: "invalid_template" });
		await expect(
			startJob(deps, { uploadId: "u1", template: { version: 2 }, dryRun: false }, fields),
		).rejects.toMatchObject({
			code: "invalid_template",
		});
	});
});

describe("staged upload lifecycle", () => {
	it("deletes the file when an import completes with nothing to retry", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(3));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await drive(deps, uploads, job.id)).status).toBe("completed");
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("keeps the file while failed records can be retried, and after a dry run", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(3, (i) => i === 1),
		);
		const real = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await drive(deps, uploads, real.id)).counters.failed).toBe(1);
		deps.source.add("u2", csv(2));
		const dry = await startJob(deps, { uploadId: "u2", template, dryRun: true }, fields);
		await drive(deps, uploads, dry.id);
		expect(uploads.deleted).toEqual([]);
	});

	it("keeps a file another job still needs, and deletes it on cancel otherwise", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(2));
		const first = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const second = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await changeJob(deps, uploads, first.id, "cancel");
		expect(uploads.deleted).toEqual([]);
		await changeJob(deps, uploads, second.id, "cancel");
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("knows which states still need the file", () => {
		const base = {
			dryRun: false,
			counters: { created: 1, updated: 0, unchanged: 0, locked: 0, conflict: 0, failed: 0 },
		} as Job;
		expect(uploadNeeded({ ...base, status: "paused" })).toBe(true);
		expect(uploadNeeded({ ...base, status: "failed" })).toBe(true);
		expect(uploadNeeded({ ...base, status: "cancelled" })).toBe(false);
		expect(uploadNeeded({ ...base, status: "completed" })).toBe(false);
		expect(
			uploadNeeded({ ...base, status: "completed", counters: { ...base.counters, locked: 1 } }),
		).toBe(true);
		expect(uploadNeeded({ ...base, status: "completed", dryRun: true })).toBe(true);
	});

	it("does not throw when deleting fails", async () => {
		const { deps } = makeDeps();
		deps.source.add("u1", csv(1));
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const failing = { delete: async () => Promise.reject(new Error("storage down")) };
		await expect(
			releaseUploadIfUnused(deps, failing, { ...job, status: "cancelled" }),
		).rejects.toThrow("storage down");
		await expect(changeJob(deps, failing, job.id, "cancel")).resolves.toMatchObject({
			status: "cancelled",
		});
	});
});

describe("reads", () => {
	it("lists jobs newest first with a status filter", async () => {
		const { deps, clock } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(1));
		const a = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		clock.t += 1000;
		const b = await startJob(deps, { uploadId: "u1", template, dryRun: true }, fields);
		await changeJob(deps, uploads, a.id, "cancel");
		expect((await listJobs(deps, {})).items.map((j) => j.id)).toEqual([b.id, a.id]);
		expect((await listJobs(deps, { status: "cancelled" })).items.map((j) => j.id)).toEqual([a.id]);
	});

	it("pages records of one job in order and filters by status", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(60, (i) => i % 10 === 0),
		);
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await drive(deps, uploads, job.id);
		const first = await listRecords(deps, { id: job.id });
		expect(first.items).toHaveLength(50);
		expect(first.hasMore).toBe(true);
		const second = await listRecords(deps, {
			id: job.id,
			...(first.cursor ? { cursor: first.cursor } : {}),
		});
		expect(second.items.map((r) => r.seq)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
		const failed = await listRecords(deps, { id: job.id, status: "failed" });
		expect(failed.items.map((r) => r.seq)).toEqual([0, 10, 20, 30, 40, 50]);
		await expect(listRecords(deps, { id: "nope" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("builds the log CSV and refuses one over the raw response limit", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add(
			"u1",
			csv(2, (i) => i === 1),
		);
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		await drive(deps, uploads, job.id);
		const log = await jobLogCsv(deps, job.id, "failed");
		expect(log.split("\r\n")[1]).toMatch(/^2,failed,,,,invalid_number,price,/);
		const row = (await deps.records.query({ where: { jobId: job.id, seq: 0 } })).items[0]!;
		await deps.records.put(row.id, {
			...row.data,
			errors: [{ code: "x", message: "y".repeat(LOG_MAX_BYTES) }],
		});
		const error = await jobLogCsv(deps, job.id).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ServiceError);
		expect(error).toMatchObject({ code: "LOG_TOO_LARGE", status: 413 });
		await expect(getJob(deps, "nope")).rejects.toMatchObject({ code: "not_found" });
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/plugin/service.ts`:
```ts
import { runBatch } from "../engine/batch.js";
import { type CreateJobInput, createJob, JobError, transitionJob } from "../engine/jobs.js";
import { buildLogCsv } from "../engine/log.js";
import { SourceMissingError } from "../engine/ports.js";
import type { SchemaField } from "../engine/template.js";
import type { EngineDeps, Job, JobStatus, RecordRow, RecordStatus } from "../engine/types.js";
import { type CsvSample, CsvSyntaxError, readCsvSample } from "../sources/csv.js";

export const PAGE_SIZE = 50;
export const SAMPLE_MAX = 20;
/** Raw plugin responses are capped at 8 MiB (`PLUGIN_ROUTE_MAX_BODY_BYTES`, @emdash-cms/plugin-types). */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;

/** A failure the route layer turns into an HTTP error with this code and status. */
export class ServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ServiceError";
	}
}

/** Deletes staged source files; `EmDashUploads` implements it. */
export interface UploadStore {
	delete(uploadId: string): Promise<void>;
}

export interface Page<T> {
	items: T[];
	cursor?: string;
	hasMore: boolean;
}

function page<T>(result: { items: { data: T }[]; cursor?: string; hasMore: boolean }): Page<T> {
	const items = result.items.map((i) => i.data);
	return result.cursor
		? { items, cursor: result.cursor, hasMore: result.hasMore }
		: { items, hasMore: result.hasMore };
}

export async function sampleSource(
	deps: EngineDeps,
	uploadId: string,
	n: number,
): Promise<CsvSample> {
	try {
		return await readCsvSample(await deps.source.open(uploadId, 0), Math.min(n, SAMPLE_MAX));
	} catch (e) {
		if (e instanceof SourceMissingError) throw new ServiceError("UPLOAD_NOT_FOUND", e.message, 404);
		if (e instanceof CsvSyntaxError) {
			throw new ServiceError("INVALID_SOURCE", `${e.message} at byte ${e.offset}`, 400);
		}
		throw e;
	}
}

export type StartJobInput = Omit<CreateJobInput, "schemaFields">;
export type FieldLookup = (collection: string) => Promise<SchemaField[] | null>;

function collectionOf(template: unknown): string | null {
	return typeof template === "object" &&
		template !== null &&
		"collection" in template &&
		typeof template.collection === "string"
		? template.collection
		: null;
}

/** Creates a job after reading the target collection's fields. */
export async function startJob(
	deps: EngineDeps,
	input: StartJobInput,
	lookupFields: FieldLookup,
): Promise<Job> {
	const collection = collectionOf(input.template);
	// Without a collection name the template is invalid; createJob reports that with details.
	const schemaFields = collection === null ? [] : await lookupFields(collection);
	if (schemaFields === null) {
		throw new JobError("invalid_template", `Collection "${collection}" does not exist`);
	}
	return createJob(deps, { ...input, schemaFields });
}

export async function getJob(deps: EngineDeps, id: string): Promise<Job> {
	const job = await deps.jobs.get(id);
	if (!job) throw new JobError("not_found", `Job ${id} not found`);
	return job;
}

/** Whether a job may still read its staged file (resume, retry, or a real run after a dry run). */
export function uploadNeeded(job: Job): boolean {
	switch (job.status) {
		case "cancelled":
			return false;
		case "completed":
			return job.dryRun || job.counters.failed + job.counters.conflict + job.counters.locked > 0;
		default:
			return true;
	}
}

/** Deletes the job's staged file once neither it nor any other job can still read it. */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	let cursor: string | undefined;
	do {
		const result = await deps.jobs.query({
			where: { uploadId: job.uploadId },
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		if (result.items.some(({ id, data }) => id !== job.id && uploadNeeded(data))) return false;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	await uploads.delete(job.uploadId);
	return true;
}

async function releaseQuietly(deps: EngineDeps, uploads: UploadStore, job: Job): Promise<void> {
	// Best effort: a file left behind here is removed by the retention task.
	await releaseUploadIfUnused(deps, uploads, job).catch(() => false);
}

export async function nextBatch(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	holder: string,
): Promise<Job> {
	const job = await runBatch(deps, id, holder);
	await releaseQuietly(deps, uploads, job);
	return job;
}

export async function changeJob(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	const job = await transitionJob(deps, id, action);
	if (action === "cancel") await releaseQuietly(deps, uploads, job);
	return job;
}

export async function listJobs(
	deps: EngineDeps,
	opts: { status?: JobStatus; cursor?: string },
): Promise<Page<Job>> {
	return page(
		await deps.jobs.query({
			...(opts.status ? { where: { status: opts.status } } : {}),
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
}

export async function listRecords(
	deps: EngineDeps,
	opts: { id: string; status?: RecordStatus; cursor?: string },
): Promise<Page<RecordRow>> {
	await getJob(deps, opts.id);
	return page(
		await deps.records.query({
			where: opts.status ? { jobId: opts.id, status: opts.status } : { jobId: opts.id },
			orderBy: { seq: "asc" },
			limit: PAGE_SIZE,
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		}),
	);
}

export async function jobLogCsv(
	deps: EngineDeps,
	id: string,
	status?: RecordStatus,
): Promise<string> {
	await getJob(deps, id);
	const csv = await buildLogCsv(deps, id, status ? { status } : {});
	if (new TextEncoder().encode(csv).byteLength > LOG_MAX_BYTES) {
		throw new ServiceError(
			"LOG_TOO_LARGE",
			"The log is larger than 8 MiB; download it per status (status=failed, conflict, …)",
			413,
		);
	}
	return csv;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/service.test.ts`
Expected: PASS (12 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/service.ts packages/flux-import/tests/unit/service.test.ts
git commit -m "Add the plugin service layer over the engine

Covers sampling, job creation against the collection schema, batches,
transitions, paged reads, the log CSV, and deleting a staged file once no job
can still read it."
```

### Task 8: Retention cleanup

**Files:**
- Create: `packages/flux-import/src/plugin/retention.ts`
- Test: `packages/flux-import/tests/unit/retention.test.ts`

**Interfaces:**
- Consumes: `EngineDeps` (`jobs`, `records`, `now`), `KvCollection.deleteMany`/`delete` (Task 4), `createJob`, `runBatch` (tests).
- Produces: `RETENTION_TASK = "retention"`; `RETENTION_SCHEDULE = "0 3 * * *"`; `RETENTION_DAYS_DEFAULT = 30`; `interface PurgeResult { jobs: number; records: number; uploads: number }`; `interface UploadPurger { purgeBefore(cutoff: Date): Promise<number> }` (`EmDashUploads` implements it); `purgeExpired(deps: Pick<EngineDeps, "jobs" | "records" | "now">, uploads: UploadPurger, retentionDays: number): Promise<PurgeResult>`.

- [ ] **Step 1: Write the failing tests**

`packages/flux-import/tests/unit/retention.test.ts`:
```ts
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
	async purgeBefore(cutoff: Date) {
		this.cutoffs.push(cutoff);
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
		const result = await purgeExpired(deps, new Purger(), 0);
		expect(result.jobs).toBe(0);
		expect(await deps.jobs.get(job.id)).not.toBeNull();
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/plugin/retention.ts`:
```ts
import type { EngineDeps } from "../engine/types.js";

export const RETENTION_TASK = "retention";
/** Daily at 03:00 UTC; EmDash evaluates cron expressions in UTC on every host. */
export const RETENTION_SCHEDULE = "0 3 * * *";
export const RETENTION_DAYS_DEFAULT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;

export interface PurgeResult {
	jobs: number;
	records: number;
	uploads: number;
}

/** Deletes staged files older than a cutoff; `EmDashUploads` implements it. */
export interface UploadPurger {
	purgeBefore(cutoff: Date): Promise<number>;
}

async function deleteRecords(deps: Pick<EngineDeps, "records">, jobId: string): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await deps.records.query({ where: { jobId }, limit: PAGE });
		if (page.items.length === 0) return deleted;
		deleted += await deps.records.deleteMany(page.items.map((i) => i.id));
	}
}

/**
 * Deletes jobs created before the cutoff with their record rows, and staged files last modified
 * before it. A job with a live lease is left for the next run. Links are kept: they map source
 * keys to entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
): Promise<PurgeResult> {
	const now = deps.now();
	const cutoff = new Date(now - retentionDays * DAY_MS);
	const expired: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.jobs.query({
			where: { createdAt: { lt: cutoff.toISOString() } },
			limit: PAGE,
			...(cursor ? { cursor } : {}),
		});
		for (const { id, data } of page.items) {
			if (!(data.lease && data.lease.expiresAt > now)) expired.push(id);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	let records = 0;
	for (const id of expired) {
		records += await deleteRecords(deps, id);
		await deps.jobs.delete(id);
	}
	return { jobs: expired.length, records, uploads: await uploads.purgeBefore(cutoff) };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/retention.test.ts`
Expected: PASS (3 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/plugin/retention.ts packages/flux-import/tests/unit/retention.test.ts
git commit -m "Add retention cleanup for old jobs, records and staged files"
```

### Task 9: Plugin definition and routes

**Files:**
- Create: `packages/flux-import/src/meta.ts`, `packages/flux-import/src/plugin/runtime.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/src/plugin/definition.ts`
- Modify: `packages/flux-import/src/index.ts`
- Test: `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 4 (`pluginCollections`, `EmDashUploads`, `isUploadId`), Task 5 (`isEntryLocked`, `listSchemaFields`), Task 6 (`EmDashContent`), Task 7 (all service functions, `ServiceError`, `SAMPLE_MAX`, `StartJobInput`), Task 8 (`purgeExpired`, `RETENTION_*`). From `emdash`: `definePlugin`, `PluginRouteError`, `pluginResponse`, `ulid`, types `PluginRoute`, `RouteContext`, `PluginContext`, `PluginStorageConfig`, `ActorInfo` (`src/index.ts:274-290`, `:330-420`); `withEmDashRuntime` and type `EmDashRuntime` from `emdash/middleware` (`dist/astro/middleware.d.mts:37-71`).
- Produces:
  - `src/meta.ts`: `FLUX_IMPORT_ID = "flux-import"`, `FLUX_IMPORT_VERSION = "0.1.0"`.
  - `src/plugin/runtime.ts`: `withRuntime<T>(run: (runtime: EmDashRuntime) => Promise<T>): Promise<T>` (lazy import, F3); re-exports `type EmDashRuntime`.
  - `src/plugin/routes.ts`: `routes: Record<string, PluginRoute>` with `sources/sample`, `jobs/create`, `jobs/next`, `jobs/get`, `jobs/list`, `jobs/pause`, `jobs/resume`, `jobs/cancel`, `jobs/retry`, `jobs/records` (POST JSON) and `jobs/log.csv` (GET, raw); `ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">): Promise<void>`.
  - `src/plugin/definition.ts`: `type FluxImportOptions = Record<string, never>`; `STORAGE` (the storage config); `createPlugin(options?: FluxImportOptions)` returning `definePlugin(…)`'s `ResolvedPlugin`.
  - `src/index.ts`: still exports `fluxImport()`, `createPlugin`, `FLUX_IMPORT_ID`, `FLUX_IMPORT_VERSION`, `FluxImportOptions`, default `createPlugin`; the descriptor's `entrypoint` stays `"flux-import"`.
- Route contracts (all `permission: "import:execute"`, inputs validated with Zod, JSON wrapped by the host in `{ success, data }`): `sources/sample { uploadId, n = 5 (1..20) } → { headers, rows }`; `jobs/create { uploadId, template, dryRun, publish?, batchSize?, budgetMs? } → Job`; `jobs/next { id } → Job` (holder `"<userId>:<ulid>"`, unique per call); `jobs/get|pause|resume|cancel|retry { id } → Job`; `jobs/list { status?, cursor? } → Page<Job>`; `jobs/records { id, status?, cursor? } → Page<RecordRow>`; `GET jobs/log.csv?id=&status=` → `text/csv` attachment. Errors: `JobError` `not_found` → 404 `NOT_FOUND`, `invalid_transition` → 409, other `JobError` → 400 with `details.problems`; `ServiceError` → its code and status; no user → 401.

Facts: route options and `permission` (`src/plugins/types.ts:1909-1931`; report, question 6); slashes in route names (report, question 8); hooks and `HookConfig.timeout` (`src/plugins/types.ts:1368-1386`, `:1771-1833`); `cron` hook and `ctx.cron` (`src/plugins/types.ts:1108-1152`; docs https://docs.emdashcms.com/reference/hooks/ "Cron hook"); settings schema (`src/plugins/types.ts:2012-2080`); F5 to F9.

- [ ] **Step 1: Write the failing tests**

`packages/flux-import/tests/unit/definition.test.ts`:
```ts
import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";
import { createPlugin, STORAGE } from "../../src/plugin/definition.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "../../src/plugin/retention.js";
import { ensureRetentionScheduled } from "../../src/plugin/routes.js";

const ROUTES = [
	"sources/sample",
	"jobs/create",
	"jobs/next",
	"jobs/get",
	"jobs/list",
	"jobs/pause",
	"jobs/resume",
	"jobs/cancel",
	"jobs/retry",
	"jobs/records",
	"jobs/log.csv",
];
const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;

describe("createPlugin", () => {
	const plugin = createPlugin();

	it("declares every API route with import:execute", () => {
		expect(Object.keys(plugin.routes).sort()).toEqual([...ROUTES].sort());
		for (const name of ROUTES) expect(plugin.routes[name]?.permission).toBe("import:execute");
		expect(plugin.routes["jobs/log.csv"]).toMatchObject({ methods: ["GET"], response: "raw" });
		expect(plugin.routes["jobs/next"]?.methods).toEqual(["POST"]);
	});

	it("declares the storage indexes the queries use", () => {
		expect(plugin.storage).toEqual(STORAGE);
		expect(STORAGE.records.indexes).toEqual([
			"jobId",
			["jobId", "status"],
			["jobId", "seq"],
			["jobId", "status", "seq"],
		]);
		expect(STORAGE.jobs.indexes).toEqual(["status", "createdAt", "uploadId"]);
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
	});

	it("has the retention setting, the activate hook and the cron hook", () => {
		expect(plugin.admin.settingsSchema?.retentionDays).toMatchObject({
			type: "number",
			default: 30,
			min: 0,
		});
		expect(plugin.hooks["plugin:activate"]).toBeDefined();
		expect(plugin.hooks.cron?.timeout).toBe(60_000);
		expect(plugin.capabilities).toEqual([
			"content:read",
			"content:write",
			"content:publish",
			"schema:read",
		]);
	});

	it("validates route input with Zod", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		expect(create.safeParse({ uploadId: UPLOAD_ID, template: {}, dryRun: true }).success).toBe(
			true,
		);
		expect(create.safeParse({ uploadId: "../x", template: {}, dryRun: true }).success).toBe(false);
		expect(create.safeParse({ uploadId: UPLOAD_ID, template: {} }).success).toBe(false);
		const sample = plugin.routes["sources/sample"]!.input!;
		expect(sample.safeParse({ uploadId: UPLOAD_ID, n: 21 }).success).toBe(false);
		expect(sample.parse({ uploadId: UPLOAD_ID })).toEqual({ uploadId: UPLOAD_ID, n: 5 });
		expect(plugin.routes["jobs/get"]!.input!.safeParse({ id: "a/b" }).success).toBe(false);
		expect(
			plugin.routes["jobs/records"]!.input!.safeParse({ id: "J1", status: "bogus" }).success,
		).toBe(false);
	});

	it("refuses a call without a user before touching the runtime", async () => {
		const ctx = { input: { id: "J1" }, user: undefined } as unknown as RouteContext;
		await expect(plugin.routes["jobs/get"]!.handler(ctx)).rejects.toMatchObject({
			name: "PluginRouteError",
			status: 401,
		});
	});
});

describe("ensureRetentionScheduled", () => {
	it("schedules the daily task once", async () => {
		const scheduled: string[] = [];
		const tasks: { name: string }[] = [];
		const cron = {
			list: async () =>
				tasks.map((t) => ({ ...t, schedule: RETENTION_SCHEDULE, nextRunAt: "", lastRunAt: null })),
			schedule: async (name: string, opts: { schedule: string }) => {
				scheduled.push(`${name}@${opts.schedule}`);
				tasks.push({ name });
			},
			cancel: async () => {},
		};
		await ensureRetentionScheduled({ cron });
		await ensureRetentionScheduled({ cron });
		expect(scheduled).toEqual([`${RETENTION_TASK}@0 3 * * *`]);
		await expect(ensureRetentionScheduled({})).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/definition.test.ts`
Expected: FAIL — `src/plugin/definition.js` not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/meta.ts`:
```ts
export const FLUX_IMPORT_ID = "flux-import";
export const FLUX_IMPORT_VERSION = "0.1.0";
```

`packages/flux-import/src/plugin/runtime.ts`:
```ts
import type { EmDashRuntime } from "emdash/middleware";

export type { EmDashRuntime };

/**
 * Runs `run` against the EmDash runtime (`withEmDashRuntime`, `emdash` dist/astro/middleware.d.mts:37-71).
 * `emdash/middleware` imports `virtual:emdash/*` modules that exist only inside the Astro build,
 * so it is loaded on first use: `astro.config.mjs` and unit tests can import the plugin without it.
 */
export async function withRuntime<T>(run: (runtime: EmDashRuntime) => Promise<T>): Promise<T> {
	const { withEmDashRuntime } = await import("emdash/middleware");
	return withEmDashRuntime(run);
}
```

`packages/flux-import/src/plugin/routes.ts`:
```ts
import type { ActorInfo, PluginContext, PluginRoute, RouteContext } from "emdash";
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { z } from "zod";
import { EmDashContent } from "../emdash/content.js";
import { isEntryLocked } from "../emdash/locks.js";
import { listSchemaFields } from "../emdash/schema.js";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads, isUploadId } from "../emdash/uploads.js";
import { JobError } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { RETENTION_SCHEDULE, RETENTION_TASK } from "./retention.js";
import { type EmDashRuntime, withRuntime } from "./runtime.js";
import {
	changeJob,
	getJob,
	jobLogCsv,
	listJobs,
	listRecords,
	nextBatch,
	SAMPLE_MAX,
	ServiceError,
	type StartJobInput,
	sampleSource,
	startJob,
} from "./service.js";

/** Every route requires Admin (`import:execute` is level 50 in @emdash-cms/auth). */
const PERMISSION = "import:execute";

const JOB_STATUSES = [
	"created",
	"running",
	"paused",
	"completed",
	"cancelled",
	"failed",
] as const satisfies readonly JobStatus[];
const RECORD_STATUSES = [
	"writing",
	"created",
	"updated",
	"unchanged",
	"locked",
	"conflict",
	"failed",
	"planned",
] as const satisfies readonly RecordStatus[];

const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
const uploadId = z.string().refine(isUploadId, "Invalid upload ID");
const cursor = z.string().min(1).max(1024).optional();
const byId = z.object({ id: jobId });

export async function ensureRetentionScheduled(ctx: Pick<PluginContext, "cron">): Promise<void> {
	if (!ctx.cron) return;
	const tasks = await ctx.cron.list();
	if (!tasks.some((t) => t.name === RETENTION_TASK)) {
		await ctx.cron.schedule(RETENTION_TASK, { schedule: RETENTION_SCHEDULE });
	}
}

interface Services {
	deps: EngineDeps;
	uploads: EmDashUploads;
	runtime: EmDashRuntime;
	actor: ActorInfo;
}

function toRouteError(e: unknown): unknown {
	if (e instanceof ServiceError) return new PluginRouteError(e.code, e.message, e.status);
	if (e instanceof JobError) {
		const status = e.code === "not_found" ? 404 : e.code === "invalid_transition" ? 409 : 400;
		const details = e.details.length > 0 ? { problems: e.details } : undefined;
		return new PluginRouteError(e.code.toUpperCase(), e.message, status, details);
	}
	return e;
}

/** Builds the engine's dependencies for one request and maps service errors to HTTP errors. */
async function withServices<T>(
	ctx: RouteContext<unknown>,
	run: (services: Services) => Promise<T>,
): Promise<T> {
	if (!ctx.user) throw PluginRouteError.unauthorized("Importing requires a signed-in user");
	const actor: ActorInfo = { id: ctx.user.id, role: ctx.user.role, source: "api" };
	return withRuntime(async (runtime) => {
		if (!runtime.storage) {
			throw new PluginRouteError("NOT_CONFIGURED", "EmDash storage is not configured", 500);
		}
		const uploads = new EmDashUploads(runtime.storage);
		const deps: EngineDeps = {
			...pluginCollections(ctx.storage),
			content: new EmDashContent(runtime, actor, (collection, entryId, userId) =>
				isEntryLocked(runtime.db, collection, entryId, userId),
			),
			source: uploads,
			now: Date.now,
			newId: () => ulid(),
		};
		try {
			return await run({ deps, uploads, runtime, actor });
		} catch (e) {
			throw toRouteError(e);
		}
	});
}

function route<T>(
	input: z.ZodType<T>,
	handler: (ctx: RouteContext<T>) => Promise<unknown>,
): PluginRoute<T> {
	return { input, permission: PERMISSION, methods: ["POST"], handler };
}

const createInput = z.object({
	uploadId,
	template: z.unknown(),
	dryRun: z.boolean(),
	publish: z.boolean().optional(),
	batchSize: z.number().int().optional(),
	budgetMs: z.number().int().optional(),
});

function transition(action: "pause" | "resume" | "cancel" | "retry"): PluginRoute<{ id: string }> {
	return route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads }) => changeJob(deps, uploads, ctx.input.id, action)),
	);
}

const logCsv: PluginRoute<{ id: string; status?: RecordStatus | undefined }> = {
	input: z.object({ id: jobId, status: z.enum(RECORD_STATUSES).optional() }),
	permission: PERMISSION,
	methods: ["GET"],
	response: "raw",
	handler: (ctx) =>
		withServices(ctx, async ({ deps }) => {
			const csv = await jobLogCsv(deps, ctx.input.id, ctx.input.status);
			return pluginResponse({
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="flux-import-${ctx.input.id}.csv"`,
				},
				body: { kind: "text", value: csv },
			});
		}),
};

export const routes: Record<string, PluginRoute> = {
	"sources/sample": route(
		z.object({ uploadId, n: z.number().int().min(1).max(SAMPLE_MAX).default(5) }),
		(ctx) => withServices(ctx, ({ deps }) => sampleSource(deps, ctx.input.uploadId, ctx.input.n)),
	),

	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime }) => {
			const { input } = ctx;
			const options: StartJobInput = {
				uploadId: input.uploadId,
				template: input.template,
				dryRun: input.dryRun,
				...(input.publish === undefined ? {} : { publish: input.publish }),
				...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
				...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
			};
			return startJob(deps, options, (collection) =>
				listSchemaFields(runtime.schemaRegistry, collection),
			);
		});
	}),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`),
		),
	),

	"jobs/get": route(byId, (ctx) => withServices(ctx, ({ deps }) => getJob(deps, ctx.input.id))),

	"jobs/list": route(z.object({ status: z.enum(JOB_STATUSES).optional(), cursor }), (ctx) =>
		withServices(ctx, ({ deps }) =>
			listJobs(deps, {
				...(ctx.input.status ? { status: ctx.input.status } : {}),
				...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
			}),
		),
	),

	"jobs/pause": transition("pause"),
	"jobs/resume": transition("resume"),
	"jobs/cancel": transition("cancel"),
	"jobs/retry": transition("retry"),

	"jobs/records": route(
		z.object({ id: jobId, status: z.enum(RECORD_STATUSES).optional(), cursor }),
		(ctx) =>
			withServices(ctx, ({ deps }) =>
				listRecords(deps, {
					id: ctx.input.id,
					...(ctx.input.status ? { status: ctx.input.status } : {}),
					...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
				}),
			),
	),

	"jobs/log.csv": logCsv,
};
```

`packages/flux-import/src/plugin/definition.ts`:
```ts
import type { PluginStorageConfig } from "emdash";
import { definePlugin } from "emdash";
import { pluginCollections } from "../emdash/storage.js";
import { EmDashUploads } from "../emdash/uploads.js";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "../meta.js";
import { purgeExpired, RETENTION_DAYS_DEFAULT, RETENTION_TASK } from "./retention.js";
import { ensureRetentionScheduled, routes } from "./routes.js";
import { withRuntime } from "./runtime.js";

export type FluxImportOptions = Record<string, never>;

/**
 * Every field a query filters or sorts on is indexed (plugin storage rejects others,
 * `emdash` src/plugins/storage-query.ts:113-127). `jobs.uploadId` lets a finished job check
 * whether another job still needs its staged file before deleting it.
 */
export const STORAGE = {
	jobs: { indexes: ["status", "createdAt", "uploadId"] },
	records: {
		indexes: ["jobId", ["jobId", "status"], ["jobId", "seq"], ["jobId", "status", "seq"]],
	},
	links: { indexes: ["entryId"] },
} satisfies PluginStorageConfig;

export function createPlugin(_options: FluxImportOptions = {}) {
	return definePlugin({
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		// Declared for disclosure on the admin plugins page. The importer reads and writes content
		// and adds the flux_source_id field through the trusted runtime (withEmDashRuntime), not
		// through ctx.content, so these do not gate any call it makes.
		capabilities: ["content:read", "content:write", "content:publish", "schema:read"],
		storage: STORAGE,
		routes,
		admin: {
			settingsSchema: {
				retentionDays: {
					type: "number",
					label: "Keep import logs for (days)",
					description:
						"Job records and staged source files older than this are deleted daily. 0 deletes them at the next daily run.",
					default: RETENTION_DAYS_DEFAULT,
					min: 0,
					max: 3650,
				},
			},
		},
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await ensureRetentionScheduled(ctx);
			},
			cron: {
				timeout: 60_000,
				handler: async (event, ctx) => {
					if (event.name !== RETENTION_TASK) return;
					const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
					const result = await withRuntime(async (runtime) => {
						if (!runtime.storage) throw new Error("flux-import: EmDash storage is not configured");
						const { jobs, records } = pluginCollections(ctx.storage);
						return purgeExpired(
							{ jobs, records, now: Date.now },
							new EmDashUploads(runtime.storage),
							days,
						);
					});
					ctx.log.info("Removed expired import data", result);
				},
			},
		},
	});
}
```

Replace `packages/flux-import/src/index.ts` with:
```ts
import type { PluginDescriptor } from "emdash";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
import { createPlugin, type FluxImportOptions } from "./plugin/definition.js";

export { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
export { createPlugin, type FluxImportOptions };

export function fluxImport(options: FluxImportOptions = {}): PluginDescriptor<FluxImportOptions> {
	return {
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		format: "native",
		entrypoint: "flux-import",
		options,
	};
}

export default createPlugin;
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/definition.test.ts tests/unit/descriptor.test.ts`
Expected: PASS (6 + 1 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Smoke-test the routes on the dev site**

```bash
cd sites/dev && node node_modules/astro/bin/astro.mjs dev --ignore-lock --port 4321
```
(`--ignore-lock` keeps it in the foreground, F1.) In another shell:
```bash
TOKEN=$(curl -s -X POST -H 'X-EmDash-Request: 1' 'http://localhost:4321/_emdash/api/setup/dev-bypass?token=1&content=0' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.token))')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' http://localhost:4321/_emdash/api/plugins/flux-import/jobs/list
curl -s -X POST -H 'X-EmDash-Request: 1' -H 'Content-Type: application/json' -d '{}' http://localhost:4321/_emdash/api/plugins/flux-import/jobs/list
```
Expected: `{"success":true,"data":{"items":[],"hasMore":false}}` with the PAT (this call goes through `withEmDashRuntime()`), and 401 without auth. Stop the server (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/meta.ts packages/flux-import/src/plugin packages/flux-import/src/index.ts packages/flux-import/tests/unit/definition.test.ts
git commit -m "Define the flux-import plugin: routes, storage, settings and retention cron

All routes need import:execute and validate input with Zod. jobs/next uses a
unique lease holder per call. The runtime is reached through
withEmDashRuntime, loaded on first use."
```

### Task 10: Upload route and `fluxImportRoutes()`

**Files:**
- Create: `packages/flux-import/src/astro/config.ts`, `packages/flux-import/src/astro/env.d.ts`, `packages/flux-import/src/astro/upload-route.ts`, `packages/flux-import/src/astro/integration.ts`
- Modify: `packages/flux-import/src/index.ts`, `packages/flux-import/package.json` (`exports`), `sites/dev/astro.config.mjs`
- Test: `packages/flux-import/tests/unit/integration.test.ts`

**Interfaces:**
- Consumes: `stageUpload`, `UploadTooLargeError` (Task 4); `hasPermission` from `@emdash-cms/auth` (`@emdash-cms/auth/dist/index.d.mts:253`); `App.Locals` augmentation from `emdash/locals` (`locals.emdash.storage: Storage | null`, `locals.user?: User`; `emdash/locals.d.ts`, `dist/astro/types.d.mts:491`); `AstroIntegration`, `APIRoute` from `astro`.
- Produces: `MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024`; `maxSourceBytes(): number`; `interface FluxImportRoutesOptions { maxSourceBytes?: number }`; `UPLOAD_ROUTE = "/_emdash/api/flux-import/uploads"`; `fluxImportRoutes(options?: FluxImportRoutesOptions): AstroIntegration` (exported from the package root); package export `flux-import/astro/upload`. Route: `POST /_emdash/api/flux-import/uploads?filename=<name>.csv` → 201 `{ success: true, data: { uploadId, bytes, sha256 } }`; 403 without `import:execute`, 415 for a non-CSV name, 413 over the limit, 400 without a body; 401/403 CSRF come from EmDash's middleware (report, question 5). `sites/dev/astro.config.mjs` reads `FLUX_DEV_DB`, `FLUX_DEV_UPLOADS`, `FLUX_DEV_MAX_SOURCE_BYTES` (Task 11 sets them).

`injectRoute({ pattern, entrypoint, prerender })` (astro `dist/types/public/internal.d.ts:310-315`); the limit reaches the route through Vite `define`.

- [ ] **Step 1: Write the failing test**

`packages/flux-import/tests/unit/integration.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MAX_SOURCE_BYTES_DEFAULT, maxSourceBytes } from "../../src/astro/config.js";
import { fluxImportRoutes, UPLOAD_ROUTE } from "../../src/astro/integration.js";

type SetupArgs = {
	injectRoute: (route: { pattern: string; entrypoint: string; prerender?: boolean }) => void;
	updateConfig: (config: { vite: { define: Record<string, string> } }) => void;
};

function runSetup(options?: Parameters<typeof fluxImportRoutes>[0]) {
	const routes: unknown[] = [];
	const configs: unknown[] = [];
	const integration = fluxImportRoutes(options);
	const setup = integration.hooks["astro:config:setup"] as unknown as (args: SetupArgs) => void;
	setup({ injectRoute: (r) => routes.push(r), updateConfig: (c) => configs.push(c) });
	return { integration, routes, configs };
}

describe("fluxImportRoutes", () => {
	it("injects the upload route and passes the size limit to the build", () => {
		const { integration, routes, configs } = runSetup({ maxSourceBytes: 1234 });
		expect(integration.name).toBe("flux-import-routes");
		expect(routes).toEqual([
			{ pattern: UPLOAD_ROUTE, entrypoint: "flux-import/astro/upload", prerender: false },
		]);
		expect(UPLOAD_ROUTE).toBe("/_emdash/api/flux-import/uploads");
		expect(configs).toEqual([{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: "1234" } } }]);
	});

	it("defaults to 50 MiB and rejects a bad limit", () => {
		expect(runSetup().configs).toEqual([
			{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT) } } },
		]);
		expect(() => fluxImportRoutes({ maxSourceBytes: 0 })).toThrow("positive integer");
		expect(() => fluxImportRoutes({ maxSourceBytes: 1.5 })).toThrow("positive integer");
	});

	it("falls back to the default limit outside the build", () => {
		expect(maxSourceBytes()).toBe(MAX_SOURCE_BYTES_DEFAULT);
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/integration.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/flux-import/src/astro/config.ts`:
```ts
/** Replaced at build time by `fluxImportRoutes()` through Vite `define`. */
declare const __FLUX_IMPORT_MAX_SOURCE_BYTES__: number | undefined;

/**
 * On Node the local storage adapter buffers the whole upload in memory
 * (`emdash` src/storage/local.ts:84-94), so the default stays modest.
 */
export const MAX_SOURCE_BYTES_DEFAULT = 50 * 1024 * 1024;

export function maxSourceBytes(): number {
	return typeof __FLUX_IMPORT_MAX_SOURCE_BYTES__ === "number"
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}
```

`packages/flux-import/src/astro/env.d.ts` (gives the route `locals.emdash` and `locals.user`):
```ts
/// <reference types="emdash/locals" />
```

`packages/flux-import/src/astro/upload-route.ts`:
```ts
import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { stageUpload, UploadTooLargeError } from "../emdash/uploads.js";
import { maxSourceBytes } from "./config.js";

export const prerender = false;

const CSV_FILENAME = /^[^/\\\0]{1,251}\.csv$/i;

/** Same envelope as EmDash's own API errors (`emdash` src/api/error.ts:31-43). */
function apiError(code: string, message: string, status: number): Response {
	return Response.json({ success: false, error: { code, message } }, { status });
}

/**
 * POST /_emdash/api/flux-import/uploads?filename=<name>.csv
 *
 * EmDash's middleware authenticates this path and applies CSRF (`X-EmDash-Request: 1` for
 * session callers; PATs need the `admin` scope), verification report question 5. The route adds
 * the `import:execute` check and the size limit, enforced while the body streams.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
	if (!hasPermission(locals.user, "import:execute")) {
		return apiError("FORBIDDEN", "Importing requires the import:execute permission", 403);
	}
	const storage = locals.emdash?.storage;
	if (!storage) return apiError("NOT_CONFIGURED", "EmDash storage is not configured", 500);

	const filename = url.searchParams.get("filename") ?? "";
	if (!CSV_FILENAME.test(filename)) {
		return apiError("UNSUPPORTED_SOURCE", "filename must name a .csv file", 415);
	}
	const limit = maxSourceBytes();
	const header = request.headers.get("content-length");
	const declared = header === null ? undefined : Number(header);
	if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
		return apiError("TOO_LARGE", `The upload exceeds the limit of ${limit} bytes`, 413);
	}
	if (!request.body) return apiError("EMPTY_BODY", "The request has no body", 400);

	try {
		const length = declared !== undefined && Number.isSafeInteger(declared) ? declared : undefined;
		const staged = await stageUpload(storage, request.body, limit, length);
		return Response.json({ success: true, data: staged }, { status: 201 });
	} catch (e) {
		if (e instanceof UploadTooLargeError) return apiError("TOO_LARGE", e.message, 413);
		throw e;
	}
};
```

`packages/flux-import/src/astro/integration.ts`:
```ts
import type { AstroIntegration } from "astro";
import { MAX_SOURCE_BYTES_DEFAULT } from "./config.js";

export interface FluxImportRoutesOptions {
	/** Largest accepted upload in bytes. Default 50 MiB. */
	maxSourceBytes?: number;
}

export const UPLOAD_ROUTE = "/_emdash/api/flux-import/uploads";

/**
 * Adds the streamed upload route. Plugin routes buffer bodies and cap them at 8 MiB, so the
 * upload is a trusted Astro route under `/_emdash/api/`, where EmDash's auth and CSRF
 * middleware apply (verification report, question 5).
 */
export function fluxImportRoutes(options: FluxImportRoutesOptions = {}): AstroIntegration {
	const max = options.maxSourceBytes ?? MAX_SOURCE_BYTES_DEFAULT;
	if (!Number.isSafeInteger(max) || max < 1) {
		throw new Error("fluxImportRoutes: maxSourceBytes must be a positive integer");
	}
	return {
		name: "flux-import-routes",
		hooks: {
			"astro:config:setup": ({ injectRoute, updateConfig }) => {
				updateConfig({
					vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: JSON.stringify(max) } },
				});
				injectRoute({
					pattern: UPLOAD_ROUTE,
					entrypoint: "flux-import/astro/upload",
					prerender: false,
				});
			},
		},
	};
}
```

Replace `packages/flux-import/src/index.ts` with:
```ts
import type { PluginDescriptor } from "emdash";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
import { createPlugin, type FluxImportOptions } from "./plugin/definition.js";

export { type FluxImportRoutesOptions, fluxImportRoutes } from "./astro/integration.js";
export { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION } from "./meta.js";
export { createPlugin, type FluxImportOptions };

export function fluxImport(options: FluxImportOptions = {}): PluginDescriptor<FluxImportOptions> {
	return {
		id: FLUX_IMPORT_ID,
		version: FLUX_IMPORT_VERSION,
		format: "native",
		entrypoint: "flux-import",
		options,
	};
}

export default createPlugin;
```

In `packages/flux-import/package.json`, replace
```json
	"exports": {
		".": "./src/index.ts"
	},
```
with:
```json
	"exports": {
		".": "./src/index.ts",
		"./astro/upload": "./src/astro/upload-route.ts"
	},
```

Replace `sites/dev/astro.config.mjs` with:
```js
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fluxImport, fluxImportRoutes } from "flux-import";

// Integration tests point the site at a throwaway database and upload directory.
const databaseFile = process.env.FLUX_DEV_DB ?? "./data.db";
const uploadsDir = process.env.FLUX_DEV_UPLOADS ?? "./uploads";
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databaseFile}` }),
			plugins: [fluxImport()],
			storage: local({
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
		fluxImportRoutes(maxSourceBytes ? { maxSourceBytes } : {}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/integration.test.ts`
Expected: PASS (3 tests). Then `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 5: Smoke-test the upload on the dev site**

Start the site as in Task 9 Step 5 and get `TOKEN` the same way, then:
```bash
printf 'sku,Name\nA,1\n' > /tmp/flux-sample.csv
curl -s -X POST -H "Authorization: Bearer $TOKEN" --data-binary @/tmp/flux-sample.csv 'http://localhost:4321/_emdash/api/flux-import/uploads?filename=sample.csv'
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" --data-binary @/tmp/flux-sample.csv 'http://localhost:4321/_emdash/api/flux-import/uploads?filename=sample.txt'
curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @/tmp/flux-sample.csv 'http://localhost:4321/_emdash/api/flux-import/uploads?filename=sample.csv'
```
Expected: `{"success":true,"data":{"uploadId":"<58 chars>","bytes":13,"sha256":"…"}}`, then `415`, then `403` (CSRF_REJECTED: no auth and no header). `ls sites/dev/uploads` shows `flux-import-upload-<uploadId>.csv`. Delete that file and stop the server.

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/astro packages/flux-import/src/index.ts packages/flux-import/package.json packages/flux-import/tests/unit/integration.test.ts sites/dev/astro.config.mjs
git commit -m "Add the streamed upload route and the fluxImportRoutes integration

The route checks import:execute, accepts only .csv names, enforces
maxSourceBytes while reading and stores under an unguessable key. The dev site
registers it and reads its database and upload paths from the environment."
```

### Task 11: Integration harness and end-to-end test

**Files:**
- Create: `packages/flux-import/vitest.integration.config.ts`
- Create: `packages/flux-import/tests/integration/server.ts`, `client.ts`, `fixtures.ts`, `global-setup.ts`, `e2e.test.ts`
- Modify: `packages/flux-import/package.json` (script), `package.json` (root script)

**Interfaces:**
- Consumes: the dev site from Task 10 (env vars), routes from Task 9, `Job`, `RecordRow` types.
- Produces:
  - `server.ts`: `SITE_DIR`, `ENV_DTS`, `TEST_MAX_SOURCE_BYTES = 1_000_000`; `interface AstroProcess { baseUrl: string; child: ChildProcess; log: string[] }`; `interface DevServer extends AstroProcess { dir: string; dbPath: string; uploadsDir: string }`; `startAstroDev(siteDir: string, port: number, env?: Record<string, string>): Promise<AstroProcess>`; `startServer(port: number, dir?: string): Promise<DevServer>`; `stopServer(server: AstroProcess, signal?: NodeJS.Signals): Promise<void>`.
  - `client.ts`: `class ApiError extends Error { status; code }`; `devBypass(baseUrl: string): Promise<string>`; `interface Product { id; slug; status; data; draftRevisionId; liveRevisionId }`; `class Client { constructor(baseUrl: string, token: string); raw(method, path, body?, init?): Promise<Response>; api<T>(method, path, body?): Promise<T>; plugin<T = Job>(route, input?): Promise<T>; upload(csv, filename?): Promise<{ uploadId; bytes; sha256 }>; uploadRaw(body, filename?): Promise<Response>; createProducts(slug): Promise<void>; fieldSlugs(collection): Promise<string[]>; listAll(collection): Promise<Product[]>; getEntry(collection, id): Promise<{ item: Product; _rev: string }>; runToEnd(id, maxBatches?): Promise<Job>; records(id, status?): Promise<RecordRow[]> }`.
  - `fixtures.ts`: `productsCsv(n: number, price?: (i: number) => string): string`; `MALFORMED_CSV`; `template(collection: string)`.
  - `global-setup.ts`: provides `baseUrl`, `token`, `dbPath` (Vitest `inject`); restores `sites/dev/emdash-env.d.ts`.
  - Scripts: `pnpm test:integration` (root) → `pnpm --filter flux-import test:integration`.

Harness facts: dev-bypass returns an Admin PAT with `admin` scope (report, question 9); schema routes `POST /_emdash/api/schema/collections` (`createCollectionBody`, `src/api/schemas/schema.ts:168-187`, accepts `editLocking`) and `POST …/collections/{slug}/fields` (`createFieldBody`, `:214-230`); `GET …/collections/{slug}?includeFields=true` returns `{ item: { fields } }` (`src/api/handlers/schema.ts:219-231`); `GET /_emdash/api/content/{collection}?locale=&limit=&cursor=` returns `{ items, nextCursor }` (`src/api/types.ts:10-24`); `/_emdash/api/health` is public (`src/astro/middleware/auth.ts:116`); F1, F2. Schema changes make the dev server rewrite `sites/dev/emdash-env.d.ts` (report, question 4), hence the restore. Ports 4396 to 4399 must be free.

- [ ] **Step 1: Write the harness**

`packages/flux-import/vitest.integration.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/integration/**/*.test.ts"],
		globalSetup: ["tests/integration/global-setup.ts"],
		// Suites share one dev server and some start their own; run them one at a time.
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 240_000,
	},
});
```

`packages/flux-import/tests/integration/server.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev");
export const ENV_DTS = join(SITE_DIR, "emdash-env.d.ts");

/** Small enough that the size-limit test uploads only a little more than 1 MB. */
export const TEST_MAX_SOURCE_BYTES = 1_000_000;

export interface AstroProcess {
	baseUrl: string;
	child: ChildProcess;
	log: string[];
}

export interface DevServer extends AstroProcess {
	dir: string;
	dbPath: string;
	uploadsDir: string;
}

/**
 * The environment Vitest runs in (`NODE_ENV=test`, `VITEST*`) leaves `astro dev` answering every
 * request with 404, so the child gets the parent environment without them.
 */
function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "NODE_ENV" || key === "TEST" || key.startsWith("VITEST")) continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

async function waitForHealth(server: AstroProcess, timeoutMs: number): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (server.child.exitCode !== null) {
			throw new Error(`astro dev exited with ${server.child.exitCode}:\n${server.log.join("")}`);
		}
		try {
			const res = await fetch(`${server.baseUrl}/_emdash/api/health`);
			if (res.ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`astro dev did not answer /_emdash/api/health (if it answers 404, delete the site's node_modules/.vite and retry):\n${server.log.join("")}`,
	);
}

/**
 * Starts `astro dev` for a site and waits until EmDash answers. `--ignore-lock` keeps it in the
 * foreground: Astro 7 moves `astro dev` to the background when it detects an AI agent, and
 * refuses a second server for the same project without the flag
 * (astro dist/cli/dev/index.js:85-90). `detached` gives it its own process group, so stopping it
 * also stops the processes it spawned.
 */
export async function startAstroDev(
	siteDir: string,
	port: number,
	env: Record<string, string> = {},
): Promise<AstroProcess> {
	const child = spawn(
		process.execPath,
		[
			join(siteDir, "node_modules/astro/bin/astro.mjs"),
			"dev",
			"--ignore-lock",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
		],
		{ cwd: siteDir, env: serverEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: true },
	);
	const log: string[] = [];
	child.stdout?.on("data", (d) => log.push(String(d)));
	child.stderr?.on("data", (d) => log.push(String(d)));
	const server = { baseUrl: `http://127.0.0.1:${port}`, child, log };
	await waitForHealth(server, 180_000);
	return server;
}

/** Starts `sites/dev` on its own SQLite file and upload directory (`dir`, new when omitted). */
export async function startServer(port: number, dir?: string): Promise<DevServer> {
	const root = dir ?? (await mkdtemp(join(tmpdir(), "flux-import-it-")));
	const dbPath = join(root, "test.db");
	const uploadsDir = join(root, "uploads");
	const server = await startAstroDev(SITE_DIR, port, {
		FLUX_DEV_DB: dbPath,
		FLUX_DEV_UPLOADS: uploadsDir,
		FLUX_DEV_MAX_SOURCE_BYTES: String(TEST_MAX_SOURCE_BYTES),
	});
	return { ...server, dir: root, dbPath, uploadsDir };
}

/** Stops the server and the processes it spawned; `SIGKILL` simulates a crash. */
export async function stopServer(
	server: AstroProcess,
	signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	const exited = new Promise((r) => server.child.once("exit", r));
	process.kill(-(server.child.pid as number), signal);
	await exited;
}
```

`packages/flux-import/tests/integration/client.ts`:
```ts
import type { Job, RecordRow } from "../../src/engine/types.js";

type Envelope<T> =
	| { success: true; data: T }
	| { success: false; error: { code: string; message: string } };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(`${status} ${code}: ${message}`);
	}
}

/** Admin PAT from the dev-only setup bypass (verification report, question 9). */
export async function devBypass(baseUrl: string): Promise<string> {
	const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass?token=1&content=0`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	const body = (await res.json()) as Envelope<{ token: string }>;
	if (!body.success) throw new ApiError(res.status, body.error.code, body.error.message);
	return body.data.token;
}

export interface Product {
	id: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	liveRevisionId: string | null;
}

/** HTTP client for the dev site with an Admin PAT (Bearer tokens skip the CSRF header). */
export class Client {
	constructor(
		readonly baseUrl: string,
		readonly token: string,
	) {}

	async raw(
		method: string,
		path: string,
		body?: unknown,
		init: RequestInit = {},
	): Promise<Response> {
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(init.headers as Record<string, string> | undefined),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.raw(method, path, body);
		const json = (await res.json()) as Envelope<T>;
		if (!json.success) throw new ApiError(res.status, json.error.code, json.error.message);
		return json.data;
	}

	plugin<T = Job>(route: string, input: unknown = {}): Promise<T> {
		return this.api<T>("POST", `/_emdash/api/plugins/flux-import/${route}`, input);
	}

	async upload(csv: string | Uint8Array<ArrayBuffer>, filename = "data.csv") {
		const res = await this.uploadRaw(csv, filename);
		const json = (await res.json()) as Envelope<{
			uploadId: string;
			bytes: number;
			sha256: string;
		}>;
		if (!json.success) throw new ApiError(res.status, json.error.code, json.error.message);
		return json.data;
	}

	async uploadRaw(
		body: string | Uint8Array<ArrayBuffer>,
		filename = "data.csv",
	): Promise<Response> {
		return fetch(
			`${this.baseUrl}/_emdash/api/flux-import/uploads?filename=${encodeURIComponent(filename)}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "text/csv" },
				body,
			},
		);
	}

	/** Creates a revisioned collection with edit locking and the fields the template maps. */
	async createProducts(slug: string): Promise<void> {
		await this.api("POST", "/_emdash/api/schema/collections", {
			slug,
			label: slug,
			supports: ["drafts", "revisions"],
			editLocking: true,
		});
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "price", label: "Price", type: "number" },
			{ slug: "released", label: "Released", type: "datetime" },
		]) {
			await this.api("POST", `/_emdash/api/schema/collections/${slug}/fields`, field);
		}
	}

	async fieldSlugs(collection: string): Promise<string[]> {
		const data = await this.api<{ item: { fields: { slug: string }[] } }>(
			"GET",
			`/_emdash/api/schema/collections/${collection}?includeFields=true`,
		);
		return data.item.fields.map((f) => f.slug);
	}

	async listAll(collection: string): Promise<Product[]> {
		const items: Product[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.api<{ items: Product[]; nextCursor?: string }>(
				"GET",
				`/_emdash/api/content/${collection}?locale=en&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor);
		return items;
	}

	async getEntry(collection: string, id: string) {
		return this.api<{ item: Product; _rev: string }>(
			"GET",
			`/_emdash/api/content/${collection}/${id}?locale=en`,
		);
	}

	async runToEnd(id: string, maxBatches = 1000): Promise<Job> {
		for (let i = 0; i < maxBatches; i++) {
			const job = await this.plugin("jobs/next", { id });
			if (job.status !== "running" && job.status !== "created") return job;
		}
		throw new Error(`Job ${id} did not finish in ${maxBatches} batches`);
	}

	async records(id: string, status?: string): Promise<RecordRow[]> {
		const rows: RecordRow[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.plugin<{ items: RecordRow[]; cursor?: string; hasMore: boolean }>(
				"jobs/records",
				{ id, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
			);
			rows.push(...page.items);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
		return rows;
	}
}
```

`packages/flux-import/tests/integration/fixtures.ts`:
```ts
/** Source rows: `sku` is the key, `Handle` the slug, the rest map to title, price and released. */
export function productsCsv(n: number, price: (i: number) => string = (i) => `${i}.5`): string {
	let out = "sku,Name,Price,Released,Handle\r\n";
	for (let i = 0; i < n; i++) {
		const day = String((i % 28) + 1).padStart(2, "0");
		out += `SKU-${i},"Product ${i}, ""quoted""",${price(i)},${day}/03/2026,product-${i}\r\n`;
	}
	return out;
}

/**
 * Two good rows, a short row, a bad number, a good row, then a quote that never closes: the job
 * logs the bad rows, imports the good ones and fails at the unreadable tail.
 */
export const MALFORMED_CSV =
	"sku,Name,Price,Released,Handle\n" +
	"M-1,One,1,01/03/2026,m-1\n" +
	"M-2,Two,2,02/03/2026,m-2\n" +
	"M-3,Short row\n" +
	"M-4,Four,not-a-number,04/03/2026,m-4\n" +
	"M-5,Five,5,05/03/2026,m-5\n" +
	'M-6,"Six never closes,6,06/03/2026,m-6\n';

export function template(collection: string) {
	return {
		version: 1,
		collection,
		locale: "en",
		key: { from: "sku" },
		slug: { from: "Handle" },
		fields: {
			title: { from: "Name", type: "text" },
			price: { from: "Price", type: "number" },
			released: { from: "Released", type: "date", format: "dd/MM/yyyy", tz: "Europe/Chisinau" },
		},
	};
}
```

`packages/flux-import/tests/integration/global-setup.ts`:
```ts
import { readFile, rm, writeFile } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { devBypass } from "./client.js";
import { ENV_DTS, startServer, stopServer } from "./server.js";

declare module "vitest" {
	export interface ProvidedContext {
		baseUrl: string;
		token: string;
		dbPath: string;
	}
}

export const SHARED_PORT = 4399;

/**
 * One dev server for the suites that can share it. Schema changes make the dev server rewrite
 * `sites/dev/emdash-env.d.ts`, so the tracked file is restored on teardown.
 */
export default async function setup(project: TestProject) {
	const envDts = await readFile(ENV_DTS, "utf8");
	const server = await startServer(SHARED_PORT);
	try {
		project.provide("baseUrl", server.baseUrl);
		project.provide("token", await devBypass(server.baseUrl));
		project.provide("dbPath", server.dbPath);
	} catch (e) {
		await stopServer(server);
		throw e;
	}
	return async () => {
		await stopServer(server);
		await rm(server.dir, { recursive: true, force: true });
		await writeFile(ENV_DTS, envDts);
	};
}
```

In `packages/flux-import/package.json` `scripts`, add after `"test": "vitest run"`:
```json
		"test:integration": "vitest run --config vitest.integration.config.ts"
```
In the root `package.json` `scripts`, add after `"test"`:
```json
		"test:integration": "pnpm --filter flux-import test:integration"
```

- [ ] **Step 2: Write the end-to-end test**

`packages/flux-import/tests/integration/e2e.test.ts`:
```ts
import { beforeAll, describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";
import { productsCsv, template } from "./fixtures.js";

const COLLECTION = "it_e2e";
const client = new Client(inject("baseUrl"), inject("token"));

describe("import end to end (10 rows)", () => {
	beforeAll(async () => {
		await client.createProducts(COLLECTION);
	});

	it("uploads, samples, imports and publishes every row", async () => {
		const csv = productsCsv(10);
		const upload = await client.upload(csv);
		expect(upload.bytes).toBe(new TextEncoder().encode(csv).byteLength);
		expect(upload.sha256).toMatch(/^[0-9a-f]{64}$/);

		const sample = await client.plugin<{ headers: string[]; rows: string[][] }>("sources/sample", {
			uploadId: upload.uploadId,
			n: 3,
		});
		expect(sample.headers).toEqual(["sku", "Name", "Price", "Released", "Handle"]);
		expect(sample.rows).toHaveLength(3);

		const job = await client.plugin("jobs/create", {
			uploadId: upload.uploadId,
			template: template(COLLECTION),
			dryRun: false,
			batchSize: 4,
		});
		expect(job.status).toBe("created");
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({
			status: "completed",
			counters: { created: 10, updated: 0, unchanged: 0, failed: 0, conflict: 0, locked: 0 },
		});

		const entries = await client.listAll(COLLECTION);
		expect(entries).toHaveLength(10);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0")!;
		expect(first).toMatchObject({ slug: "product-0", status: "published", draftRevisionId: null });
		expect(first.data).toMatchObject({ title: 'Product 0, "quoted"', price: 0.5 });
		expect(Date.parse(first.data.released as string)).toBe(Date.parse("2026-02-28T22:00:00.000Z"));
		expect(await client.fieldSlugs(COLLECTION)).toContain("flux_source_id");
	});
});
```

- [ ] **Step 3: Run it**

Run: `pnpm test:integration`
Expected: PASS (1 test, about 10 s plus server start). If global setup reports that `/_emdash/api/health` answered 404, delete `sites/dev/node_modules/.vite` and retry (seen once after a Vite config change). If it reports `astro dev` exited, read the log it prints. Afterwards `git status` must show no change to `sites/dev/emdash-env.d.ts`.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass (the integration files are type-checked with the package).

- [ ] **Step 5: Commit**

```bash
git add package.json packages/flux-import/package.json packages/flux-import/vitest.integration.config.ts packages/flux-import/tests/integration
git commit -m "Add the dev-site integration harness and an end-to-end import test

Global setup starts astro dev on a temporary SQLite file and upload directory,
gets an Admin PAT from dev-bypass and restores the generated env types."
```

### Task 12: Behaviour integration tests

**Files:**
- Create: `packages/flux-import/tests/integration/db.ts`, `packages/flux-import/tests/integration/behaviours.test.ts`

**Interfaces:**
- Consumes: Task 11 harness (`Client`, `ApiError`, `inject("baseUrl" | "token" | "dbPath")`, `productsCsv`, `MALFORMED_CSV`, `template`, `TEST_MAX_SOURCE_BYTES`), `UPLOAD_PREFIX` (Task 4), `Job`.
- Produces: `withDb<T>(path: string, run: (db: DatabaseSync) => T): T`; `giveLockToSecondUser(dbPath: string, collection: string, entryId: string): string`; `expireLock(dbPath: string, collection: string, entryId: string): void` (Task 13 uses `withDb`).

Covers: dry run writes nothing (not even the field); publish off then on; identical re-run is `unchanged` with the same `_rev` (Review Focus 1); only changed rows update; malformed input (bad rows logged, job fails at the unreadable tail); log CSV download; upload rejections leave nothing staged (Review Focus 2); concurrent `jobs/next` (Review Focus 4); an editor's draft gets a new `_rev` (the engine's `pending_draft` rule depends on it) and is neither overwritten nor published; the importer's own lock does not block, another user's lock does, and the record is imported after the lock expires; HTTP errors 404 and 409. Lock rows: F12; lock route `POST /_emdash/api/content/{collection}/{id}/lock` (report, question 3); `_emdash_entry_locks` columns (`src/database/migrations/075_entry_edit_locks.ts:12-21`).

- [ ] **Step 1: Write the database helper**

`packages/flux-import/tests/integration/db.ts`:
```ts
import { DatabaseSync } from "node:sqlite";

/**
 * Opens the dev server's SQLite file directly. Tests use it only for what no API offers: a second
 * user's lock (invites need a passkey), and moving a cron task's due time.
 */
export function withDb<T>(path: string, run: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		return run(db);
	} finally {
		db.close();
	}
}

/**
 * Inserts a second account (columns as `emdash` src/astro/routes/api/auth/dev-bypass.ts inserts
 * them) and moves the entry's lock to it.
 */
export function giveLockToSecondUser(dbPath: string, collection: string, entryId: string): string {
	const userId = `01SECONDUSER${Date.now()}`;
	const now = new Date().toISOString();
	withDb(dbPath, (db) => {
		db.prepare(
			"INSERT INTO users (id, email, name, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, 40, 1, ?, ?)",
		).run(userId, `${userId.toLowerCase()}@example.test`, "Second editor", now, now);
		const moved = db
			.prepare("UPDATE _emdash_entry_locks SET user_id = ? WHERE collection = ? AND entry_id = ?")
			.run(userId, collection, entryId);
		if (moved.changes !== 1) throw new Error(`No lock row for ${collection}/${entryId}`);
	});
	return userId;
}

export function expireLock(dbPath: string, collection: string, entryId: string): void {
	withDb(dbPath, (db) => {
		db.prepare(
			"UPDATE _emdash_entry_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE collection = ? AND entry_id = ?",
		).run(collection, entryId);
	});
}
```

- [ ] **Step 2: Write the tests**

`packages/flux-import/tests/integration/behaviours.test.ts`:
```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import { ApiError, Client } from "./client.js";
import { expireLock, giveLockToSecondUser } from "./db.js";
import { MALFORMED_CSV, productsCsv, template } from "./fixtures.js";
import { TEST_MAX_SOURCE_BYTES } from "./server.js";

const client = new Client(inject("baseUrl"), inject("token"));
const dbPath = inject("dbPath");

async function importCsv(
	collection: string,
	csv: string,
	options: { dryRun?: boolean; publish?: boolean; batchSize?: number } = {},
): Promise<Job> {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: template(collection),
		dryRun: options.dryRun ?? false,
		...(options.publish === undefined ? {} : { publish: options.publish }),
		batchSize: options.batchSize ?? 50,
	});
	return client.runToEnd(job.id);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

describe("dry run", () => {
	it("plans every row and writes nothing, not even the source-ID field", async () => {
		await client.createProducts("it_dry");
		const done = await importCsv("it_dry", productsCsv(10), { dryRun: true });
		expect(done).toMatchObject({ status: "completed", counters: { created: 10 } });
		const rows = await client.records(done.id);
		expect(rows.every((r) => r.status === "planned" && r.action === "create")).toBe(true);
		expect(rows[0]?.changes).toContainEqual({ field: "price", before: null, after: 0.5 });
		expect(await client.listAll("it_dry")).toEqual([]);
		expect(await client.fieldSlugs("it_dry")).not.toContain("flux_source_id");
	});
});

describe("publish option and re-runs", () => {
	it("leaves drafts with publish: false and publishes its own drafts on a publishing re-run", async () => {
		await client.createProducts("it_publish");
		const drafts = await importCsv("it_publish", productsCsv(5), { publish: false });
		expect(drafts.counters).toMatchObject({ created: 5 });
		for (const e of (await byKey("it_publish")).values()) {
			expect(e).toMatchObject({ status: "draft", liveRevisionId: null });
		}
		const published = await importCsv("it_publish", productsCsv(5));
		expect(published.counters).toMatchObject({ updated: 5, conflict: 0 });
		for (const e of (await byKey("it_publish")).values()) {
			expect(e).toMatchObject({ status: "published", draftRevisionId: null });
		}
	});

	it("reports every row unchanged when the same file is imported again", async () => {
		const before = await byKey("it_publish");
		const revs = new Map(
			await Promise.all(
				[...before.values()].map(
					async (e) => [e.id, (await client.getEntry("it_publish", e.id))._rev] as const,
				),
			),
		);
		const again = await importCsv("it_publish", productsCsv(5));
		expect(again.counters).toMatchObject({ unchanged: 5, updated: 0, created: 0 });
		for (const [id, rev] of revs) expect((await client.getEntry("it_publish", id))._rev).toBe(rev);
	});

	it("updates only the rows whose values changed", async () => {
		const changed = await importCsv(
			"it_publish",
			productsCsv(5, (i) => (i === 2 ? "99" : `${i}.5`)),
		);
		expect(changed.counters).toMatchObject({ updated: 1, unchanged: 4 });
		expect((await byKey("it_publish")).get("SKU-2")?.data.price).toBe(99);
	});
});

describe("malformed input", () => {
	it("logs bad rows, keeps the good ones, and fails the job at an unreadable tail", async () => {
		await client.createProducts("it_bad");
		const done = await importCsv("it_bad", MALFORMED_CSV);
		expect(done).toMatchObject({
			status: "failed",
			error: { code: "csv_syntax" },
			counters: { created: 3, failed: 2 },
		});
		const failed = await client.records(done.id, "failed");
		expect(failed.map((r) => r.errors?.[0]?.code)).toEqual(["column_count", "invalid_number"]);
		expect([...(await byKey("it_bad")).keys()].sort()).toEqual(["M-1", "M-2", "M-5"]);
	});

	it("downloads the record log as CSV", async () => {
		const [job] = (await client.plugin<{ items: Job[] }>("jobs/list", { status: "failed" })).items;
		const res = await client.raw(
			"GET",
			`/_emdash/api/plugins/flux-import/jobs/log.csv?id=${job!.id}&status=failed`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("content-disposition")).toContain(`flux-import-${job!.id}.csv`);
		const lines = (await res.text()).trimEnd().split("\r\n");
		expect(lines[0]).toBe(
			"record,status,source_key,entry_id,action,error_code,error_field,message",
		);
		expect(lines.slice(1).map((l) => l.split(",")[1])).toEqual(["failed", "failed"]);
	});
});

describe("uploads", () => {
	it("rejects other file types, oversized bodies and anonymous callers, and stores nothing", async () => {
		const staged = async () =>
			(await readdir(join(dbPath, "..", "uploads"))).filter((f) => f.startsWith(UPLOAD_PREFIX));
		const before = (await staged()).length;
		expect((await client.uploadRaw("a,b\n", "data.txt")).status).toBe(415);
		const big = new Uint8Array(TEST_MAX_SOURCE_BYTES + 1).fill(0x61);
		expect((await client.uploadRaw(big)).status).toBe(413);
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(100_000).fill(0x61));
				controller.close();
			},
		});
		const streamed = await fetch(
			`${client.baseUrl}/_emdash/api/flux-import/uploads?filename=big.csv`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${client.token}` },
				body: chunked,
				duplex: "half",
			} as RequestInit,
		);
		expect(streamed.status).toBe(413);
		const anonymous = await fetch(
			`${client.baseUrl}/_emdash/api/flux-import/uploads?filename=a.csv`,
			{
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
				body: "a\n",
			},
		);
		expect(anonymous.status).toBe(401);
		expect((await staged()).length).toBe(before);
	});
});

describe("concurrent drivers", () => {
	it("never processes the same batch twice when jobs/next is called in parallel", async () => {
		await client.createProducts("it_parallel");
		const { uploadId } = await client.upload(productsCsv(40));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_parallel"),
			dryRun: false,
			batchSize: 20,
		});
		const results = await Promise.all([
			client.plugin("jobs/next", { id: job.id }),
			client.plugin("jobs/next", { id: job.id }),
		]);
		expect(results.map((j) => j.cursor.seq).sort()).toEqual([0, 20]);
		const done = await client.runToEnd(job.id);
		expect(done.counters).toMatchObject({ created: 40 });
		expect((await client.listAll("it_parallel")).length).toBe(40);
	});
});

describe("editor drafts", () => {
	it("gives an editor's draft a new _rev and never overwrites or publishes it (pending_draft)", async () => {
		await client.createProducts("it_drafts");
		await importCsv("it_drafts", productsCsv(2));
		const entry = (await byKey("it_drafts")).get("SKU-0")!;
		const before = await client.getEntry("it_drafts", entry.id);
		await client.api("PUT", `/_emdash/api/content/it_drafts/${entry.id}`, {
			data: { title: "Editor title" },
			_rev: before._rev,
		});
		const drafted = await client.getEntry("it_drafts", entry.id);
		// The engine's pending_draft rule depends on this: an editor's draft is a new revision.
		expect(drafted._rev).not.toBe(before._rev);
		expect(drafted.item.draftRevisionId).not.toBeNull();

		const done = await importCsv(
			"it_drafts",
			productsCsv(2, () => "7"),
		);
		expect(done.counters).toMatchObject({ conflict: 1, updated: 1 });
		const [row] = (await client.records(done.id, "conflict")) ?? [];
		expect(row).toMatchObject({ sourceKey: "SKU-0", errors: [{ code: "pending_draft" }] });
		const after = await client.getEntry("it_drafts", entry.id);
		expect(after._rev).toBe(drafted._rev);
		expect(after.item.data).toMatchObject({ title: "Editor title", price: 0.5 });
	});
});

describe("edit locks", () => {
	it("skips an entry another user is editing and imports it once the lock expires", async () => {
		await client.createProducts("it_locks");
		await importCsv("it_locks", productsCsv(2));
		const entry = (await byKey("it_locks")).get("SKU-0")!;
		await client.api("POST", `/_emdash/api/content/it_locks/${entry.id}/lock`, {});

		// The importing user's own lock does not block the import.
		const own = await importCsv(
			"it_locks",
			productsCsv(2, () => "3"),
		);
		expect(own.counters).toMatchObject({ updated: 2, locked: 0 });

		giveLockToSecondUser(dbPath, "it_locks", entry.id);
		const blocked = await importCsv(
			"it_locks",
			productsCsv(2, () => "4"),
		);
		expect(blocked.counters).toMatchObject({ locked: 1, updated: 1 });
		const [row] = await client.records(blocked.id, "locked");
		expect(row).toMatchObject({ entryId: entry.id, errors: [{ code: "locked" }] });
		expect((await byKey("it_locks")).get("SKU-0")?.data.price).toBe(3);

		expireLock(dbPath, "it_locks", entry.id);
		await client.plugin("jobs/retry", { id: blocked.id });
		const retried = await client.runToEnd(blocked.id);
		expect(retried.counters).toMatchObject({ locked: 0, updated: 2 });
		expect((await byKey("it_locks")).get("SKU-0")?.data.price).toBe(4);
	});
});

describe("errors", () => {
	it("returns 404 for an unknown job and 409 for an invalid transition", async () => {
		await expect(client.plugin("jobs/get", { id: "NOPE" })).rejects.toMatchObject({
			status: 404,
			code: "NOT_FOUND",
		});
		const [job] = (await client.plugin<{ items: Job[] }>("jobs/list", { status: "completed" }))
			.items;
		await expect(client.plugin("jobs/pause", { id: job!.id })).rejects.toBeInstanceOf(ApiError);
		await expect(client.plugin("jobs/pause", { id: job!.id })).rejects.toMatchObject({
			status: 409,
		});
	});
});
```

- [ ] **Step 3: Run them**

Run: `pnpm test:integration`
Expected: PASS (e2e 1 + behaviours 11 tests). These tests pin internal EmDash behaviour (lock table, revision tokens); a failure after an EmDash upgrade means the adapter must follow the change, not that the test is wrong.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/tests/integration/db.ts packages/flux-import/tests/integration/behaviours.test.ts
git commit -m "Test dry runs, publishing, re-runs, malformed input, uploads, drafts and locks

Also pins that an editor's draft gets a new revision token, which the
pending_draft rule relies on, and that the importer's own lock does not block."
```

### Task 13: Scale, kill-and-resume and retention integration tests

**Files:**
- Create: `packages/flux-import/tests/integration/scale.test.ts`, `crash.test.ts`, `retention.test.ts`

**Interfaces:**
- Consumes: Task 11 (`Client`, `devBypass`, `startServer`, `stopServer`, `DevServer`, fixtures), Task 12 (`withDb`), Task 4 (`UPLOAD_PREFIX`).
- Produces: nothing new.

M2 "Done when": 10,000 rows import; kill-and-resume gives no duplicates and any entry a crash leaves unpublished is reported as `publish_unverified` (relaxed criterion); retention works. `crash.test.ts` and `retention.test.ts` start their own servers (ports 4398 and 4397) because they kill the server or change plugin settings. The crash test kills `astro dev` with `SIGKILL` while a `jobs/next` call is in flight, twice, restarts on the same database, waits out the dead lease (`budgetMs` 2,000 + `LEASE_GRACE_MS` 30,000), and finishes; whether a kill lands between a content write and the record save depends on timing, so the test asserts the invariants rather than a count, and logs how many rows were left `writing`. The retention test sets `retentionDays` to 0 through the admin settings route (F9), moves the task's `next_run_at` into the past (F8) and waits for the Node scheduler.

- [ ] **Step 1: Write the tests**

`packages/flux-import/tests/integration/scale.test.ts`:
```ts
import { describe, expect, inject, it } from "vitest";
import { Client } from "./client.js";
import { productsCsv, template } from "./fixtures.js";

const client = new Client(inject("baseUrl"), inject("token"));

describe("10,000 rows", () => {
	it("imports and publishes every row in resumable batches", async () => {
		await client.createProducts("it_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_scale"),
			dryRun: false,
			batchSize: 500,
			budgetMs: 20_000,
		});
		const started = Date.now();
		const done = await client.runToEnd(job.id);
		console.info(`10,000 rows imported in ${Math.round((Date.now() - started) / 1000)} s`);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10_000, failed: 0 } });
		// A finished cursor must not re-read the file (ranged read past the end).
		expect((await client.plugin("jobs/next", { id: job.id })).counters.created).toBe(10_000);
		const entries = await client.listAll("it_scale");
		expect(entries).toHaveLength(10_000);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});
});
```

`packages/flux-import/tests/integration/crash.test.ts`:
```ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import { Client, devBypass } from "./client.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4398;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

async function restart(): Promise<void> {
	server = await startServer(PORT, server.dir);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
}

/** jobs/next does nothing while the killed driver's lease is live (budgetMs + 30 s). */
async function waitForLease(id: string): Promise<Job> {
	for (;;) {
		const job = await client.plugin("jobs/get", { id });
		if (!job.lease || job.lease.expiresAt <= Date.now()) return job;
		await sleep(1000);
	}
}

beforeAll(async () => {
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_crash");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

describe("kill and resume", () => {
	it("leaves no duplicates and reports any entry a crash left unpublished", async () => {
		const { uploadId } = await client.upload(productsCsv(10_000));
		const created = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_crash"),
			dryRun: false,
			batchSize: 500,
			budgetMs: 2_000,
		});
		let writing = 0;
		for (const delay of [300, 700]) {
			await client.plugin("jobs/next", { id: created.id });
			const inFlight = client.plugin("jobs/next", { id: created.id }).catch(() => null);
			await sleep(delay);
			await stopServer(server, "SIGKILL");
			await inFlight;
			await restart();
			writing += (await client.records(created.id, "writing")).length;
			await waitForLease(created.id);
		}
		// Diagnostic only: SIGKILL timing decides whether a write was caught mid-record.
		console.info(`records left writing by the kills: ${writing}`);

		const done = await client.runToEnd(created.id);
		expect(done.status).toBe("completed");
		const total = Object.values(done.counters).reduce((a, b) => a + b, 0);
		expect(total).toBe(10_000);
		expect(done.counters.failed).toBe(0);

		const entries = await client.listAll("it_crash");
		expect(entries).toHaveLength(10_000);
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);

		// Relaxed criterion: an entry a crash left unpublished is reported, never silently dropped.
		const unverified = new Set(
			(await client.records(created.id, "conflict"))
				.filter((r) => r.errors?.[0]?.code === "publish_unverified")
				.map((r) => r.entryId),
		);
		expect(done.counters.conflict).toBe(unverified.size);
		for (const e of entries) {
			if (e.status !== "published") expect(unverified.has(e.id)).toBe(true);
		}
	});
});
```

`packages/flux-import/tests/integration/retention.test.ts`:
```ts
import { readdir, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4397;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: DevServer;
let client: Client;

beforeAll(async () => {
	server = await startServer(PORT);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_retention");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
});

const stagedFiles = async () =>
	(await readdir(server.uploadsDir).catch(() => [] as string[])).filter((f) =>
		f.startsWith(UPLOAD_PREFIX),
	);

describe("retention cleanup", () => {
	it("deletes expired jobs, their records and staged files, and keeps links", async () => {
		const csv = productsCsv(3);
		const { uploadId } = await client.upload(csv);
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("it_retention"),
			dryRun: false,
		});
		await client.runToEnd(job.id);
		// The completed import deleted its own staged file; this one is never used by a job.
		await client.upload(csv);
		expect(await stagedFiles()).toHaveLength(1);

		await client.api("PUT", "/_emdash/api/admin/plugins/flux-import/settings", {
			values: { retentionDays: 0 },
		});
		// plugin:activate scheduled the task on this fresh database; make it due now.
		withDb(server.dbPath, (db) => {
			const task = db
				.prepare(
					"SELECT schedule FROM _emdash_cron_tasks WHERE plugin_id = 'flux-import' AND task_name = 'retention'",
				)
				.get() as { schedule: string } | undefined;
			expect(task?.schedule).toBe("0 3 * * *");
			db.prepare(
				"UPDATE _emdash_cron_tasks SET next_run_at = ? WHERE plugin_id = 'flux-import' AND task_name = 'retention'",
			).run(new Date(Date.now() - 60_000).toISOString());
		});

		// The Node scheduler re-reads due times at least every 60 s (src/plugins/scheduler/node.ts:26).
		let gone = false;
		for (let i = 0; i < 90 && !gone; i++) {
			await sleep(1000);
			gone = await client.plugin("jobs/get", { id: job.id }).then(
				() => false,
				(e: unknown) => e instanceof ApiError && e.status === 404,
			);
		}
		expect(gone).toBe(true);
		expect(await stagedFiles()).toEqual([]);

		// Links survive: the same rows match their entries again instead of creating new ones.
		const { uploadId: again } = await client.upload(csv);
		const rerun = await client.plugin("jobs/create", {
			uploadId: again,
			template: template("it_retention"),
			dryRun: false,
		});
		expect((await client.runToEnd(rerun.id)).counters).toMatchObject({ unchanged: 3, created: 0 });
	});
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test:integration`
Expected: PASS, 5 files and 15 tests, about 4 to 5 minutes (while this plan was drafted: 10,000 rows in about a minute; the crash test about 2 minutes; retention about 65 s). Note the `records left writing by the kills` and `10,000 rows imported in` lines for the review notes.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`

- [ ] **Step 4: Commit**

```bash
git add packages/flux-import/tests/integration/scale.test.ts packages/flux-import/tests/integration/crash.test.ts packages/flux-import/tests/integration/retention.test.ts
git commit -m "Test 10,000 rows, kill-and-resume and retention on the dev site

The crash test kills astro dev mid-batch twice and checks for unique source
IDs and that every unpublished entry is reported as publish_unverified."
```

### Task 14: `sites/dev-cf` workerd parity

**Files:**
- Create: `sites/dev-cf/package.json`, `sites/dev-cf/astro.config.mjs`, `sites/dev-cf/wrangler.jsonc`, `sites/dev-cf/src/worker.ts`, `sites/dev-cf/src/pages/index.astro`, `sites/dev-cf/tsconfig.json`, `sites/dev-cf/.gitignore`
- Create: `packages/flux-import/vitest.cf.config.ts`, `packages/flux-import/tests/integration-cf/global-setup.ts`, `packages/flux-import/tests/integration-cf/parity.test.ts`
- Modify: `packages/flux-import/package.json` (script), `package.json` (root script), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `startAstroDev`, `stopServer` (Task 11), `Client`, `devBypass`, `productsCsv`, `template` (Task 11); the plugin and upload route (Tasks 9, 10).
- Produces: `pnpm test:cf` (root) → `pnpm --filter flux-import test:cf`; `CF_SITE_DIR` from `tests/integration-cf/global-setup.ts`; Vitest provides `cfBaseUrl`, `cfToken`.

Configuration comes from https://docs.emdashcms.com/deployment/cloudflare/ ("Configure bindings", "Configure EmDash", "Add the Worker entry point"); package versions from F16. Not documented and not run while writing this plan: whether `astro dev` with `@astrojs/cloudflare` 14 runs the site in workerd with local D1 and R2, where it keeps that local state, and whether `wrangler d1 execute --local` sees the same database. Steps 2 and 3 verify these before any test is written to depend on them.

- [ ] **Step 1: Create the site**

`sites/dev-cf/package.json`:
```json
{
  "name": "flux-import-dev-cf-site",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "wrangler dev --test-scheduled",
    "typecheck": "astro check"
  },
  "dependencies": {
    "@astrojs/cloudflare": "^14.3.4",
    "@astrojs/react": "^6.0.5",
    "@emdash-cms/cloudflare": "1.2.0",
    "astro": "^7.3.2",
    "emdash": "1.2.0",
    "flux-import": "workspace:*",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.10",
    "@cloudflare/workers-types": "^5.20261008.1",
    "wrangler": "^4.148.0"
  }
}
```

`sites/dev-cf/astro.config.mjs`:
```js
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fluxImport, fluxImportRoutes } from "flux-import";

// Same plugin and routes as sites/dev, on D1 and R2 under workerd.
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [fluxImport()],
		}),
		fluxImportRoutes(),
	],
	devToolbar: { enabled: false },
});
```

`sites/dev-cf/wrangler.jsonc`:
```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "flux-import-dev-cf",
	"main": "./src/worker.ts",
	"compatibility_date": "2026-02-24",
	"compatibility_flags": ["nodejs_compat"],
	"d1_databases": [{ "binding": "DB", "database_name": "flux-import-dev-cf" }],
	"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "flux-import-dev-cf-media" }],
	"triggers": { "crons": ["* * * * *"] }
}
```

`sites/dev-cf/src/worker.ts`:
```ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

// From https://docs.emdashcms.com/deployment/cloudflare/ ("Add the Worker entry point").
export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
```

`sites/dev-cf/src/pages/index.astro`:
```astro
---
export const prerender = false;
---

<p>flux-import workerd parity site. The admin is at <a href="/_emdash/admin">/_emdash/admin</a>.</p>
```

`sites/dev-cf/tsconfig.json`:
```json
{
	"extends": "astro/tsconfigs/base",
	"compilerOptions": {
		"types": ["@cloudflare/workers-types"]
	},
	"include": ["src", ".astro/types.d.ts", "emdash-env.d.ts"]
}
```

`sites/dev-cf/.gitignore`:
```text
node_modules
dist
.astro
.wrangler
.dev.vars
emdash-env.d.ts
```

Run: `pnpm install`, then `command ls node_modules/.pnpm | grep '^emdash@1.2.0'`.
Expected: still one `emdash@1.2.0` directory. If a second appears, apply the Task 3 Step 4 overrides; if that does not help, stop and report.

- [ ] **Step 2: Verify that `astro dev` runs in workerd with local D1 and R2**

```bash
cd sites/dev-cf && rm -rf .wrangler/state && node node_modules/astro/bin/astro.mjs dev --ignore-lock --port 4396 --host 127.0.0.1
```
In another shell:
```bash
curl -s http://127.0.0.1:4396/_emdash/api/health
pgrep -af workerd
TOKEN=$(curl -s -X POST -H 'X-EmDash-Request: 1' 'http://127.0.0.1:4396/_emdash/api/setup/dev-bypass?token=1&content=0' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.token))')
echo "$TOKEN"
```
Expected: health JSON; at least one `workerd` process; a token starting `ec_pat_`. Then repeat Task 10 Step 5's upload `curl` against port 4396.
- If Wrangler refuses the D1 binding without `database_id`, add `"database_id": "00000000-0000-0000-0000-000000000000"` to the `d1_databases` entry (local only) and restart.
- If no `workerd` process runs (the adapter serves `astro dev` from Node), stop: the parity tests would prove nothing about workerd. Report the adapter version and the dev-server log.
- If the upload fails with "Provided readable stream must have a known length", `stageUpload`'s `FixedLengthStream` path (Task 4) is not being used: confirm `typeof FixedLengthStream` in the worker and report.

- [ ] **Step 3: Verify the local D1 state is shared with `wrangler d1 execute`**

With the server from Step 2 still running:
```bash
cd sites/dev-cf && node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --command "SELECT email FROM users"
```
Expected: one row, `dev@emdash.local`. If it shows no rows or errors, the dev server keeps its D1 state elsewhere: run `find .wrangler -name '*.sqlite'` and, if the server's file is in another directory, add `"--persist-to", "<that directory>"` to the `d1()` helper arguments in `parity.test.ts` below. If no shared state can be found, delete the foreign-lock half of the third test (from `d1(` onwards), keep the own-lock half, and record the gap in the review notes. Stop the server.

- [ ] **Step 4: Write the parity tests**

`packages/flux-import/vitest.cf.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/integration-cf/**/*.test.ts"],
		globalSetup: ["tests/integration-cf/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 900_000,
		hookTimeout: 300_000,
	},
});
```

`packages/flux-import/tests/integration-cf/global-setup.ts`:
```ts
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { devBypass } from "../integration/client.js";
import { startAstroDev, stopServer } from "../integration/server.js";

export const CF_SITE_DIR = resolve(import.meta.dirname, "../../../../sites/dev-cf");
const PORT = 4396;

declare module "vitest" {
	export interface ProvidedContext {
		cfBaseUrl: string;
		cfToken: string;
	}
}

/** Starts `sites/dev-cf` under workerd with fresh local D1 and R2 state (kept in .wrangler/state). */
export default async function setup(project: TestProject) {
	await rm(join(CF_SITE_DIR, ".wrangler", "state"), { recursive: true, force: true });
	const server = await startAstroDev(CF_SITE_DIR, PORT);
	try {
		project.provide("cfBaseUrl", server.baseUrl);
		project.provide("cfToken", await devBypass(server.baseUrl));
	} catch (e) {
		await stopServer(server);
		throw e;
	}
	return async () => {
		await stopServer(server);
	};
}
```

`packages/flux-import/tests/integration-cf/parity.test.ts`:
```ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { Client } from "../integration/client.js";
import { productsCsv, template } from "../integration/fixtures.js";
import { CF_SITE_DIR } from "./global-setup.js";

const client = new Client(inject("cfBaseUrl"), inject("cfToken"));

/** Runs SQL on the local D1 database the dev server uses (Task 14 Step 3 checks they share it). */
function d1(sql: string): void {
	execFileSync(
		process.execPath,
		[
			join(CF_SITE_DIR, "node_modules/wrangler/bin/wrangler.js"),
			"d1",
			"execute",
			"DB",
			"--local",
			"--command",
			sql,
		],
		{ cwd: CF_SITE_DIR, stdio: "pipe" },
	);
}

const byKey = async (collection: string) =>
	new Map((await client.listAll(collection)).map((e) => [e.data.flux_source_id as string, e]));

async function importCsv(collection: string, csv: string, batchSize = 50) {
	const { uploadId } = await client.upload(csv);
	const job = await client.plugin("jobs/create", {
		uploadId,
		template: template(collection),
		dryRun: false,
		batchSize,
		budgetMs: 20_000,
	});
	return client.runToEnd(job.id);
}

describe("workerd parity (D1, R2)", () => {
	it("uploads to R2 and imports 10 rows through plugin routes that reach the runtime", async () => {
		await client.createProducts("cf_e2e");
		const { uploadId } = await client.upload(productsCsv(10));
		const sample = await client.plugin<{ headers: string[]; rows: string[][] }>("sources/sample", {
			uploadId,
			n: 2,
		});
		expect(sample.rows).toHaveLength(2);
		const done = await importCsv("cf_e2e", productsCsv(10), 4);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10, failed: 0 } });
		const entries = await client.listAll("cf_e2e");
		expect(entries.every((e) => e.status === "published")).toBe(true);
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
		await client.createProducts("cf_scale");
		const { uploadId } = await client.upload(productsCsv(10_000));
		const job = await client.plugin("jobs/create", {
			uploadId,
			template: template("cf_scale"),
			dryRun: false,
			batchSize: 500,
			budgetMs: 20_000,
		});
		const done = await client.runToEnd(job.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 10_000 } });
		expect((await client.plugin("jobs/next", { id: job.id })).counters.created).toBe(10_000);
		const entries = await client.listAll("cf_scale");
		expect(new Set(entries.map((e) => e.data.flux_source_id)).size).toBe(10_000);
	});

	it("reads edit locks from D1: the importer's own lock passes, another user's lock skips", async () => {
		await client.createProducts("cf_locks");
		await importCsv("cf_locks", productsCsv(2));
		const entry = (await byKey("cf_locks")).get("SKU-0")!;
		if (!/^[0-9A-Z]+$/.test(entry.id)) throw new Error(`Unexpected entry ID ${entry.id}`);
		await client.api("POST", `/_emdash/api/content/cf_locks/${entry.id}/lock`, {});
		const own = await importCsv(
			"cf_locks",
			productsCsv(2, () => "3"),
		);
		expect(own.counters).toMatchObject({ updated: 2, locked: 0 });

		d1(
			"INSERT INTO users (id, email, name, role, email_verified, created_at, updated_at) VALUES ('01CFSECONDUSER', 'second@example.test', 'Second editor', 40, 1, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')",
		);
		d1(
			`UPDATE _emdash_entry_locks SET user_id = '01CFSECONDUSER' WHERE collection = 'cf_locks' AND entry_id = '${entry.id}'`,
		);
		const blocked = await importCsv(
			"cf_locks",
			productsCsv(2, () => "4"),
		);
		expect(blocked.counters).toMatchObject({ updated: 1, locked: 1 });
	});
});
```

In `packages/flux-import/package.json` `scripts` add `"test:cf": "vitest run --config vitest.cf.config.ts"`; in the root `package.json` `scripts` add `"test:cf": "pnpm --filter flux-import test:cf"`.

- [ ] **Step 5: Run them**

Run: `pnpm test:cf`
Expected: PASS (3 tests). The first proves `withEmDashRuntime()` from a plugin route and the R2 upload; the second ranged reads on R2 across 20 batches plus the end-of-input guard; the third the lock query on D1.

- [ ] **Step 6: Verify the scheduled handler on a build (manual)**

```bash
cd sites/dev-cf && node node_modules/astro/bin/astro.mjs build && node node_modules/wrangler/bin/wrangler.js dev --test-scheduled --port 4395
curl -s 'http://127.0.0.1:4395/__scheduled?cron=*+*+*+*+*'
```
Expected: the Wrangler log shows the scheduled run without `[scheduled] runScheduledTasks failed`. If Step 3 showed shared state, also check that the retention task runs: before the build, while `astro dev` runs, set `retentionDays` to 0 with `curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"values":{"retentionDays":0}}' http://127.0.0.1:4396/_emdash/api/admin/plugins/flux-import/settings` and make it due with `wrangler d1 execute DB --local --command "UPDATE _emdash_cron_tasks SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE plugin_id = 'flux-import'"`; after the `__scheduled` call, the log shows `Removed expired import data`. Record the outcome in the review notes; `dev-bypass` answers 403 on a build (report, question 9), so this step uses no new token.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: pass; the root `typecheck` now also runs `astro check` in `sites/dev-cf`. If `astro check` reports `ExportedHandler` as unknown, confirm `@cloudflare/workers-types` is installed and listed in `tsconfig.json` `types`.

- [ ] **Step 8: Commit**

```bash
git add sites/dev-cf package.json packages/flux-import/package.json packages/flux-import/vitest.cf.config.ts packages/flux-import/tests/integration-cf pnpm-lock.yaml
git commit -m "Add the sites/dev-cf workerd site and parity tests on D1 and R2"
```

### Task 15: Milestone 2 review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-08-m2-review.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass. Copy the summary lines (files, tests, durations) and the two diagnostic lines from Task 13 into the note.

- [ ] **Step 2: Manual walkthrough in `pnpm dev`**

On the normal dev database (`sites/dev/data.db`), start the site with `pnpm --filter flux-import-dev-site dev` (an agent runs `node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`, F1) and check, recording each result:
1. `/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` signs in; the admin Plugins page lists `flux-import` 0.1.0 as active, with its capabilities.
2. The plugin's settings show "Keep import logs for (days)" = 30.
3. With a PAT (Task 9 Step 5), upload a 5-row CSV with columns `sku,Name,Notes` and run a dry run into `posts` with template `{ "version": 1, "collection": "posts", "locale": "en", "key": { "from": "sku" }, "slug": { "from": "sku" }, "fields": { "title": { "from": "Name", "type": "text" }, "excerpt": { "from": "Notes", "type": "text" } } }`: `jobs/records` shows 5 `planned` rows with diffs, and the admin shows no new posts and no `flux_source_id` field.
4. The same upload with `dryRun: false`: 5 published posts appear in the admin; each has a visible `flux_source_id` (read-only by convention until M7).
5. Edit one imported post in the admin and save a draft; re-run the import with a changed `Name`: that row is `conflict` / `pending_draft`, the draft is untouched.
6. `jobs/log.csv` downloads (with the PAT) and opens in a spreadsheet with neutralised formula cells.
7. `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('sites/dev/data.db');console.log(d.prepare(\"SELECT task_name,schedule,next_run_at FROM _emdash_cron_tasks WHERE plugin_id='flux-import'\").all())"` shows the `retention` task (scheduled by the first `jobs/create`, F7).
8. `git status` shows no stray changes (`sites/dev/emdash-env.d.ts` may change because `posts` gained `flux_source_id`; revert it).

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-08-m2-review.md` from this template and fill in every `…`:
````markdown
# Milestone 2 review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Automated checks

| Command | Result | Summary (files / tests / duration) |
| --- | --- | --- |
| `pnpm typecheck` | … | … |
| `pnpm lint` | … | … |
| `pnpm test` | … | … |
| `pnpm test:integration` | … | … |
| `pnpm test:cf` | … | … |

Diagnostics: 10,000 rows imported in … s on Node; records left `writing` by the kills: ….

## Milestone 2 "Done when" (spec, Roadmap)

| Criterion | Evidence | Result |
| --- | --- | --- |
| 10,000 rows import | `scale.test.ts`, `parity.test.ts` | … |
| Kill-and-resume gives no duplicates; entries a crash leaves unpublished are reported as `publish_unverified` | `crash.test.ts` | … |
| Locked entries skipped | `behaviours.test.ts` "edit locks", `parity.test.ts` | … |
| Dry-run writes nothing | `behaviours.test.ts` "dry run" | … |
| Node and workerd pass | `pnpm test:integration`, `pnpm test:cf` | … |

## workerd verification (Task 14)

| Check | Result | Notes |
| --- | --- | --- |
| `astro dev` runs the site in workerd (Step 2) | … | … |
| `wrangler d1 execute --local` sees the dev server's D1 (Step 3) | … | … |
| Scheduled handler and retention task on a build (Step 6) | … | … |

## Manual walkthrough (`pnpm dev`)

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Plugins page lists flux-import 0.1.0, active, with capabilities | … | … |
| 2 | Settings show "Keep import logs for (days)" = 30 | … | … |
| 3 | Dry run into `posts`: 5 planned rows, no posts, no field | … | … |
| 4 | Real run: 5 published posts with `flux_source_id` | … | … |
| 5 | Editor draft kept, record `pending_draft` | … | … |
| 6 | Log CSV downloads and opens safely | … | … |
| 7 | `retention` cron task present | … | … |
| 8 | Working tree clean afterwards | … | … |

## Deviations from the plan

…

## Open issues for the next milestone

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-08-m2-review.md
git commit -m "Add the Milestone 2 review results"
```

---

## After this plan

Milestone 2 ends here with the review stop. M3 (sources) builds on `SourcePort`, `readCsvSample` and the upload route; M6 exposes the routes as MCP tools (they are POST JSON routes with a declared permission, which `definePlugin` requires for MCP, `src/plugins/define-plugin.ts:160-175`); M7 hides `flux_source_id` with a field widget and downloads `jobs/log.csv` with `fetch`.
