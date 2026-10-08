# M2 verification report

Answers to the "Verify first" questions of the M2 design, checked against the installed packages
and the dev site on 2026-10-08.

- Packages: `emdash@1.2.0`, `@emdash-cms/auth@1.2.0`, `@emdash-cms/admin@1.2.0`. The `emdash`
  tarball ships its TypeScript sources under `src/` next to `dist/`. Paths below are relative to
  `sites/dev/node_modules/emdash/` unless they start with another package name.
- Experiments ran against `sites/dev` (`pnpm dev`, Node, SQLite, local storage). They used a
  throwaway Astro integration that injected `/_emdash/api/flux-import/probe` and two throwaway
  plugin routes. All of it was removed afterwards, and the dev database was restored from a backup.
- Authentication came from `POST /_emdash/api/setup/dev-bypass?token=1&content=0` (see question 9).

## 1. Runtime write handlers

**Answer:** Yes. `withEmDashRuntime()` hands the callback an `EmDashRuntime` instance with
`handleContentCreate`, `handleContentUpdate`, `handleContentGet`, `handleContentList`, `storage`
and `db`. `locals.emdash` is typed `EmDashHandlers` and exposes the same methods. Both return the
envelope `{ success, data?, error?: { code, message, details? } }`.

- `slug`, `status`, `locale`, `authorId`, `bylines`, `taxonomies` and `references` are body fields.
- The acting user is `actor: ActorInfo` (`{ id, role, source? }`). It is only passed to hooks and
  used for revision attribution. It never sets the author: that is `authorId`.
- `_rev` is an opaque `base64("<version>:<updatedAt>")` token. `handleContentGet` returns it as
  `data._rev`, and create and update return a fresh one too. Leaving `_rev` out makes a blind write.
- A stale `_rev` returns `{ success: false, error: { code: "CONFLICT" } }`, not an exception.
- **Updates go to a draft on collections with `revisions`.** On a collection that supports
  `revisions` (the `posts` collection in `sites/dev` does), `handleContentUpdate` writes a draft
  revision. The live columns stay unchanged until something publishes it.

**Evidence:** `dist/astro/types.d.mts:264` (`EmDashHandlers`), `:298`, `:320`;
`src/emdash-runtime.ts:3455` (create), `:3649` (update), `:3364` (get);
`src/plugins/types.ts:1391` (`ActorInfo`); `src/api/rev.ts:19` and `:47`.
```ts
handleContentUpdate(collection: string, id: string, body: {
  data?: Record<string, unknown>; slug?: string | null; status?: string; authorId?: string | null;
  locale?: string; _rev?: string; skipRevision?: boolean; actor?: ActorInfo; /* bylines, seo,
  taxonomies, references, publishedAt, migrateBlocks, replaceBlocks */ })
// src/emdash-runtime.ts:3691-3702
const revCheck = validateRev(body._rev, resolvedItem);
if (!revCheck.valid) return { success: false, error: { code: "CONFLICT", message: revCheck.message } };
```
Dev site (probe route, `withEmDashRuntime`). Create gave `_rev` `MToy…` (version 1). Update with
that `_rev` gave `success: true` and `draftRevisionId: "01M4D2N9…"`. A second update with the old
`_rev` gave
`{"success":false,"error":{"code":"CONFLICT","message":"Content has been modified since last read (version conflict)"}}`.
The SQLite row after the update still had `title = 'Probe entry'` (the live value) and
`draft_revision_id` set.

Two more observations from the same run:

- `handleContentCreate` with `status: "published"` stored `status = 'published'` but left
  `published_at` and `live_revision_id` as NULL.
- The runtime method's own `body` type has no `createdAt` or `publishedAt`. `EmDashHandlers`
  declares both, and they are spread through to the core handler.

**Publish (exercised).** `handleContentPublish(collection, id, { _rev?, actor?, publishedAt?, … })`
is at `src/emdash-runtime.ts:4575`, and the core handler at `src/api/handlers/content.ts:2341`
checks `_rev` as a precondition. Second probe run on `posts`, one chain per entry, all inside
`withEmDashRuntime()`. The same sequence was run twice, once with a create `status` of `"draft"`
and once with `"published"`, with identical results except for row 1:

| Step | Result | SQLite `ec_posts` row afterwards |
| --- | --- | --- |
| 1. `handleContentCreate` | `_rev` v1 | draft: `status draft`; published: `status published`. Both: `published_at` NULL, `live_revision_id` NULL |
| 2. `handleContentPublish` with the create `_rev` | `success`, `_rev` v2 | `status published`, `published_at` set, `live_revision_id` set, `title 'Pub v1'` |
| 3. `handleContentUpdate` `{ title: 'Pub v2' }` with the step 2 `_rev` | `success`, `_rev` v3, `draftRevisionId` set | `title 'Pub v1'` (live unchanged), `draft_revision_id` set |
| 4. `handleContentPublish` with the stale step 2 `_rev` | `{"code":"CONFLICT","message":"Revision precondition did not match"}` | unchanged |
| 5. `handleContentPublish` with the update's `_rev` (step 3) | `success`, `_rev` v4 | `title 'Pub v2'`, `live_revision_id` = the step 3 draft id, `draft_revision_id` NULL |
| 6. `handleContentGet` | `_rev` v4, `data.title 'Pub v2'` | |

The `_rev` that a draft-staging update returns is accepted by publish. A stale `_rev` on publish
fails with `CONFLICT` (a different message from update's, the same code).

**Consequence for M2b:**

- Type the writer port against `EmDashRuntime` from `emdash/middleware` and check `error.code`
  (`CONFLICT` becomes the record status `conflict`, on update and on publish).
- On a revisioned collection, "update" only stages a draft. To make imported values live, the
  writer calls `handleContentPublish(collection, id, { _rev: <the _rev from the update>, actor })`.
  For creates, it creates and then publishes with the create's `_rev`. It does not rely on
  `status: "published"` at create, which leaves `published_at` and `live_revision_id` NULL. These
  calls are verified (table above).
- Update and publish are two writes. A crash between them leaves a staged draft. On resume, the
  record should be re-run (update, then publish), not assumed done.
- Pass `authorId` explicitly if entries need an author.

## 2. Find by field

**Answer:** Use `handleContentList(collection, { locale, fieldFilters: { flux_source_id: key },
limit: 2 })`. The filter works only on fields with `indexed: true`. Any other field is rejected
with `VALIDATION_ERROR`. A list call accepts at most 20 field filters. Indexing creates a per-field
index and a per-field-plus-locale index.

**Evidence:** `src/content-list-query.ts:29` (the `ContentFieldFilters` type);
`src/database/repositories/content.ts:3063-3110`.
```ts
.where("field.indexed", "=", 1)
...
`Cannot filter by field "${field}". Custom fields must be indexed before filtering.`
```
Dev site. `fieldFilters: { flux_source_id: "SKU-1" }` returned exactly the created entry, and
`fieldFilters: { title: … }` returned
`{"code":"VALIDATION_ERROR","message":"Cannot filter by field \"title\". Custom fields must be indexed before filtering."}`.
SQLite showed the new indexes `idx_cf_01m4d2n951…` and `idx_cf_01m4d2n951…_loc`.

**Consequence for M2b:** Create `flux_source_id` with `indexed: true`. Crash recovery uses
`handleContentList` with `locale` and `fieldFilters`. If it finds more than one match, the record
fails with a reason code; it never picks one.

## 3. Lock state

**Answer:** No public function reads an entry lock without HTTP:

- `handleEntryLockRead`, `claimEntryLockForWrite` and `EntryLockRepository` are internal. They
  live in the hashed chunk `dist/entry-lock-B4n0HdQ_.mjs` (`dist/entry-lock-BAAlKYrz.d.mts` holds
  only the Zod schemas) and are not re-exported from any `package.json` export.
- Trusted code can read the lock table `_emdash_entry_locks` through `runtime.db`. It is typed in
  the exported `Database`.
- Calling the REST lock route internally works only with a credential (a forwarded PAT or cookie).
  A plugin route driven by a cron job or an external `jobs/next` call has none of its own.
- Confirmed: a trusted `handleContentUpdate` succeeds while another session holds the lock.
  Enforcement lives only in the REST route.

**Evidence:** `src/database/repositories/entry-locks.ts:112` (the rule the REST write path
enforces).
```ts
async findEnforceable(collection, entryId) {
  return this.liveQuery(collection, entryId)            // expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    .innerJoin("_emdash_collections", "_emdash_collections.slug", "_emdash_entry_locks.collection")
    .where("_emdash_collections.edit_locking", "!=", 0) ...
```
`src/api/handlers/entry-lock.ts:179` (`claimEntryLockForWrite`: the caller's own live lease is
allowed, and any other live lease on a collection with locking enabled refuses the write).
Dev site:

1. `POST /_emdash/api/content/posts/<id>/lock` returned `heldByCaller: true` and `expiresAt` 7
   minutes out.
2. The probe read `runtime.db.selectFrom("_emdash_entry_locks")` and got the row (`user_id`,
   `token`, `expires_at`).
3. `handleContentUpdate` on the locked entry returned `success: true`.
4. Calling the lock route from inside the trusted route returned 401 without credentials and
   200 with the caller's PAT forwarded.

**Consequence for M2b:**

- Implement `LockReader` as a Kysely query on `_emdash_entry_locks` joined to
  `_emdash_collections.edit_locking != 0`, with `expires_at` compared to the database clock.
  SQLite and D1 use the `strftime` form; Postgres needs `::timestamptz > clock_timestamp()`.
- This reads an internal table that may change, so pin it with an integration test.
- Treat a lock held by the importing user as not locked, which matches the REST rule.

## 4. Schema writes

**Answer:**

- Yes. `SchemaRegistry` is exported from `emdash`: `new SchemaRegistry(db: Kysely<Database>)`, and
  `createField(collectionSlug: string, input: CreateFieldInput): Promise<Field>`.
- The short-text type is `"string"` (TEXT column). `"text"` is the long-text type.
- A field cannot be hidden or made read-only:
  - `CreateFieldInput` has no `hidden` or `readOnly`. Only collections have `hidden`.
  - The one lever is `widget: "<pluginId>:<widgetName>"`. The admin then renders the plugin's
    `fields[widgetName]` React component, or a Block Kit `fieldWidgets` entry, in place of the
    default input. A component that renders the value as plain text, or renders nothing, would make
    the field read-only or hidden in the editor. This is from reading the code; I did not try it.
- `createField` throws a `SchemaError` with code `FIELD_EXISTS` or `RESERVED_SLUG`.
- In dev it also regenerates the site's `emdash-env.d.ts`.

**Evidence:** `src/index.ts:490`; `src/schema/registry.ts:337` (constructor), `:1276`
(`createField`); `src/schema/types.ts:13` (`FieldType`), `:406`.
```ts
export interface CreateFieldInput { slug: string; label: string; type: FieldType; required?: boolean;
  unique?: boolean; defaultValue?: unknown; validation?: FieldValidation | null; widget?: string;
  options?: FieldWidgetOptions; sortOrder?: number; searchable?: boolean; indexed?: boolean;
  translatable?: boolean; }
```
The admin widget resolution is in `@emdash-cms/admin/dist/index.js:35001-35031`
(`field.widget.indexOf(":")`, then `pluginAdmins[pluginId]?.fields?.[widgetName]`). The REST
`POST /_emdash/api/schema/collections/{slug}/fields` route calls the same registry method under
`schema:manage` (`src/api/handlers/schema.ts:587`).

Dev site. `new SchemaRegistry(emdash.db).createField("posts", { slug: "flux_source_id", label:
"Flux source ID", type: "string", indexed: true })` returned
`{ type: "string", columnType: "TEXT", indexed: true, translatable: true, … }`. The dev server then
rewrote `sites/dev/emdash-env.d.ts` (`+ flux_source_id?: string;`). I reverted that change.

**Consequence for M2b:**

- Create the field with `{ type: "string", indexed: true }`. Think about `translatable: false` so
  that translations share the key.
- In M2 the field is visible and editable, read-only by convention (the spec's fallback). It can
  be hidden in M7 with a `flux-import:sourceId` field widget shipped in the admin entry.

## 5. Trusted route

**Answer:** Yes. A separate integration can `injectRoute` the pattern
`/_emdash/api/flux-import/...`, and it gets EmDash's full auth and CSRF middleware:

- Any path under `/_emdash/api` that is not on the public list gets that treatment.
- `locals.emdash` is set, and `locals.user` is the full `User` (id, email, role 50, …).
- Session callers must send `X-EmDash-Request: 1` on POST. Bearer tokens skip the CSRF check.
- A token on a path no scope rule matches needs the `admin` scope (fail-closed).

**Evidence:** `src/astro/middleware/auth.ts:186-188` (`isApiRoute`), `:294-311` (the CSRF check),
`:833-868` (`enforceTokenScope`, which falls back to `admin`). Dev site, with
`/_emdash/api/flux-import/probe` returning `{ method, user, hasEmdash }`:

| Request | Status | Body |
| --- | --- | --- |
| GET, no auth | 401 | `NOT_AUTHENTICATED` |
| POST, no auth, no header | 403 | `CSRF_REJECTED` |
| POST, no auth, with header | 401 | `NOT_AUTHENTICATED` |
| GET, session cookie | 200 | `user.role: 50`, `hasEmdash: true` |
| POST, session, no header | 403 | `CSRF_REJECTED` |
| POST, session, with header | 200 | user and `hasEmdash: true` |
| POST, PAT with all scopes, no header | 200 | user and `hasEmdash: true` |
| POST, PAT with `content:read` and `content:write` only | 403 | `INSUFFICIENT_SCOPE: admin` |

**Consequence for M2b:** The upload route can rely on the middleware for authentication and CSRF.
It still checks `hasPermission(locals.user, "import:execute")` itself. PAT callers need the
`admin` scope.

## 6. Permission check

**Answer:**

- `import:execute` is a real permission. It sits at level 50 (Admin) in `@emdash-cms/auth`'s
  `Permissions`, and core's WordPress import routes require it.
- Trusted code uses `hasPermission(user, "import:execute")` from `@emdash-cms/auth`.
- Plugin routes declare `permission: "import:execute"` (typed `Permission`). The host checks it
  before dispatch; with no declaration the route defaults to `plugins:manage`. The host also
  requires the `admin` token scope for plugin routes.

**Evidence:** `@emdash-cms/auth/dist/index.d.mts:239` (`readonly "import:execute": 50;`) and
`:253` (`hasPermission`); `src/astro/routes/api/import/wordpress/execute.ts:114`;
`src/plugins/types.ts:1918`; `src/plugins/http-route-dispatch.ts:55-73`.
```ts
const permission = routeMeta.permission ?? "plugins:manage";
const denied = requirePerm(permissionUser, permission);
const scopeError = requireScope({ tokenScopes }, "admin");
```
Dev site. The throwaway plugin route `jobs/create` with `permission: "import:execute"` returned 200
for the Admin session and for the full PAT, 401 `UNAUTHORIZED` with no auth, and 403
`INSUFFICIENT_SCOPE` for the content-only PAT.

**Consequence for M2b:**

- Keep `import:execute` everywhere, which means only Admins can import.
- Add `@emdash-cms/auth` (1.2.0) as a direct dependency of `flux-import`. pnpm does not hoist it
  from `emdash`.
- Document that an external scheduler's PAT needs the `admin` scope.

## 7. Storage

**Answer:**

- `download(key, { range })` returns `DownloadResult`. The body is
  `body: ReadableStream<Uint8Array>`; `size` is the whole file; `range?: { offset, length }` is
  present only when a range was served.
- `range: { offset }` with no `length` works on the local adapter.
- **An offset at or past the end of the file returns the whole file**, without `range`.
- The local adapter's `upload()` reads a `ReadableStream` fully into memory before writing it.
- Every storage key outside `backups/` and `transfers/` is served without authentication at
  `/_emdash/api/media/file/<key>`.

**Evidence:** `src/storage/types.ts:79-113`, `src/storage/range.ts:52-53`.
```ts
const length = Math.min(range.length ?? size, size - range.offset);
return range.offset >= 0 && length > 0 ? { offset: range.offset, length } : null; // null → whole file
```
`src/storage/local.ts:84-94` (stream to `Buffer.concat`); `src/transfer/staging/keys.ts:71`
(`PRIVATE_STORAGE_PREFIXES = ["backups/", "transfers/"]`); `src/astro/middleware/auth.ts:108`
(`/_emdash/api/media/file/` is on the public list).

Dev site, on a 20-byte object:

| Call | Result |
| --- | --- |
| `{ offset: 5 }` | `"56789abcdefghij"`, `range {5, 15}` |
| `{ offset: 5, length: 3 }` | `"567"` |
| `{ offset: 20 }` and `{ offset: 25 }` | the full 20 bytes, `range: null` |

A file placed at `uploads/flux-import/uploads/leak.csv` came back from an unauthenticated
`GET /_emdash/api/media/file/flux-import/uploads/leak.csv` as **200** `text/csv` with
`content-disposition: attachment` and `cache-control: public, max-age=31536000, immutable`.
`…/media/file/backups/x.csv` returned 404.

**Consequence for M2b:**

- The CSV reader must treat a missing `result.range` when `offset > 0` as end of input, or check
  `offset >= size` first. Otherwise a finished cursor re-imports the whole file.
- Staged sources are public to anyone who knows the key. Use unguessable keys (ULID plus random
  suffix), never expose them in public responses, and delete them when a job ends and on
  retention cleanup.
- On Node the upload route's memory use equals the file size. Keep `maxSourceBytes` modest for
  local storage.

## 8. Plugin route names

**Answer:** `jobs/create` works as a native plugin route name. The catch-all
`/_emdash/api/plugins/[pluginId]/[...path]` passes the whole path, slashes included, as the route
key.

**Evidence:** `src/astro/routes/api/plugins/[pluginId]/[...path].ts:24-32`. Dev site:
`POST /_emdash/api/plugins/flux-import/jobs/create` with a session and the header returned
`{"success":true,"data":{"route":"jobs/create","input":{"uploadId":"u1"},"user":{…,"role":50}}}`.
Without `X-EmDash-Request` it returned 403 `CSRF_REJECTED`. A second throwaway route
`probe/runtime` called `withEmDashRuntime()` from inside a plugin route handler and got
`handleContentCreate: "function"`, `storage: true`, `db: true`.

**Consequence for M2b:** Keep the route names in the spec. The JSON is wrapped in
`{ success, data }` by the host. Plugin routes can reach the runtime through `withEmDashRuntime()`,
as the design assumes.

## 9. Integration test harness

**Answer:**

- `@emdash-cms/plugin-test` (0.2.8, not installed) cannot load our plugin. It builds a
  **sandboxed** plugin with `@emdash-cms/plugin-cli` and runs it through the Cloudflare sandbox
  runner and `PluginBridge` in workerd. A native plugin that uses `withEmDashRuntime()` and an
  injected Astro route does not fit that model.
- Integration tests run against `sites/dev` over HTTP, and authentication is fully scriptable in
  dev. `POST /_emdash/api/setup/dev-bypass?token=1&content=0` with `X-EmDash-Request: 1`:
  - applies the seed (schema only with `content=0`). The route does not run migrations itself;
    runtime initialization runs them before any request reaches it.
  - creates `dev@emdash.local` as Admin and marks setup complete
  - sets a session cookie
  - returns a PAT named `dev-bypass-token` with scopes `content:*`, `media:*`, `schema:*` and
    `admin`
  - runs again safely: it replaces the existing token
- In production builds it returns 403.
- More PATs: `POST /_emdash/api/admin/api-tokens` with `{ name, scopes }` (Admin session).

**Evidence:** `@emdash-cms/plugin-test@0.2.8` tarball, `dist/config.mjs:5,9,36`
(`buildPlugin` from `@emdash-cms/plugin-cli`, "Configure Vitest to build a sandboxed plugin and run
tests inside workerd"). Docs: https://docs.emdashcms.com/plugins/creating-plugins/testing/ ("builds
a sandboxed plugin"). `src/astro/routes/api/setup/dev-bypass.ts:107-127`;
`src/astro/routes/api/admin/api-tokens/index.ts:51`. Dev site, on the existing DB with no users and
setup not complete:
`{"success":true,"data":{"message":"Dev setup complete","userCreated":true,"user":{"id":"01M4D2KY…","role":50},"token":"ec_pat_…"}}`.
I did not run it against a deleted `data.db`. On a fresh file, migrations come from runtime
initialization on the first request, not from this route.

**Consequence for M2b:** The vitest global setup does the following:

1. Point the site at a temporary SQLite file and upload directory. `astro.config.mjs` would read
   them from env vars; that change is not made yet.
2. Start `astro dev`.
3. Wait for `/_emdash/api/health`.
4. Call dev-bypass with `?token=1&content=0`.
5. Pass the PAT to tests as `Authorization: Bearer`.

Tests then:

- create the target collection through `/_emdash/api/schema` with the PAT
- create a foreign lock with a second user, which needs a second session; dev-bypass creates only
  one user (open point)
- stop the server on teardown

## 10. workerd

**Answer:** UNVERIFIED. `sites/dev` has none of the needed packages (`@astrojs/cloudflare`,
`@emdash-cms/cloudflare` and `wrangler` are missing from `node_modules/.pnpm`). Installing them
changes the lockfile, which this task must not commit. The docs describe the configuration for a
deploy:

- `adapter: cloudflare()`
- `database: d1({ binding: "DB" })` and `storage: r2({ binding: "MEDIA" })`
- `wrangler.jsonc` with `d1_databases`, `r2_buckets` and `triggers.crons`
- a `src/worker.ts` that exports `createScheduledHandler()`

They do not describe a local `astro dev` run on D1 and R2. The `withEmDashRuntime()` doc comment
names Cloudflare Queue consumers and `scheduled()` handlers as its use case, and on workerd it opens
an event-scoped database connection. Nobody has run it there yet.

**Evidence:** https://docs.emdashcms.com/deployment/cloudflare/ ("Configure bindings", "Configure
EmDash", "Add the Worker entry point"); `dist/astro/middleware.d.mts:37-71`;
`src/astro/middleware.ts:357-380` (`runOutsideRequest`).

**Consequence for M2b:** Add a task that creates `sites/dev-cf` with those three dependencies and
the configuration above. Run it with `astro dev` (the Cloudflare adapter's local bindings), then
`wrangler dev` on the build. Prove the following there before claiming workerd parity:

- `withEmDashRuntime()` from a plugin route
- `storage.download` with `range` on R2
- the lock query on D1

## Other findings

- **Two `emdash` copies.** The workspace installs two copies of `emdash@1.2.0`: `sites/dev`
  resolves one built against `@astrojs/react@6.0.6`, and `packages/flux-import` one built against
  `@astrojs/react@7.0.1`.
  - `withEmDashRuntime()` imported from the plugin's copy still found the site's runtime, because
    the singleton is stored under `Symbol.for("emdash:runtime-holder")` on `globalThis`
    (`src/astro/middleware.ts:147`).
  - Class identity (`instanceof SchemaError`) and module state can still differ between the
    copies. Aligning `@astrojs/react` so pnpm dedupes is recommended.

## Design impact

Places where the answers contradict
`docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`:

1. **"Writing a record", step 5 (`handleContentUpdate` writes the entry).** On collections with
   `revisions` (including `posts` in `sites/dev`), an update only stages a draft; live values do
   not change. The writer needs an explicit publish step. This was exercised on `sites/dev` (Q1
   table):
   - `handleContentPublish` with the `_rev` returned by the draft-staging update makes the values
     live.
   - Publish with the create's `_rev` sets `published_at` and `live_revision_id`.
   - A stale `_rev` on publish returns `CONFLICT`.

   The spec needs an M2 default for created and updated entries (publish, or leave as draft)
   instead of deferring all of this to M5. Creating with `status: "published"` leaves
   `published_at` and `live_revision_id` NULL, so creates are published through
   `handleContentPublish`. Update and publish are two writes, so crash recovery re-runs both.
2. **Edit locks ("reads the entry's lock state").** There is no public API. The only non-HTTP path
   is a Kysely read of the internal table `_emdash_entry_locks` through `runtime.db`. The query is
   dialect-specific and may change. The spec should name this mechanism and its risk.
3. **Duplicate safety and verify-first item 5 ("hidden text field").** Fields cannot be hidden.
   The spec's fallback applies (visible, read-only by convention). The field must also be created
   with `indexed: true`, or the `flux_source_id` lookup fails with `VALIDATION_ERROR`. A real
   hidden or read-only editor needs a plugin field widget in M7.
4. **Verify-first item 2 (resume by byte range).** Ranges work, but an offset at or past the end
   silently returns the whole file. Staged uploads in `emdash.storage` are publicly downloadable
   at `/_emdash/api/media/file/<key>`, which the spec's private source staging does not account
   for. The spec needs unguessable keys, deletion after the job, and the EOF guard.
5. **API (`POST /_emdash/api/flux-import/uploads`, "streamed").** On Node with local storage,
   `storage.upload()` buffers the whole stream in memory. Streaming holds end to end only on
   adapters that stream (R2 and S3; R2 is unverified).
6. **Testing (implied use of EmDash test tooling) and the "External trigger" decision.**
   `@emdash-cms/plugin-test` does not support native plugins, so integration tests run over HTTP
   against `sites/dev` with the dev-bypass PAT. A PAT that calls `jobs/next` or the upload route
   must have the `admin` scope, not just content scopes.
7. **workerd parity.** The setup is unverified and needs new dependencies (`sites/dev-cf`). The
   M2 "Node and workerd pass" criterion depends on a task the M2b plan must add.
