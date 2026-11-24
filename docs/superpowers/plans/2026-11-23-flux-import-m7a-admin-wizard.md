# Flux Import M7a: the import wizard in the EmDash admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 0's facts were proven while this plan was drafted (results below), and Task 0 changes no file. Task 1 runs alone; then Tasks 2, 3 and 4 in parallel; then Tasks 5-13 in parallel; then 14, 15 and 16 in order (see "Parallel execution"). Plan Ruling 1 is answered yes by the coordinator, so Task 13 runs in its wave. Each task stands alone: its Interfaces block names everything it uses from other tasks.

**Goal:** A six-step React wizard (Source, Target, Map, Options, Preview, Run) at `/_emdash/admin/plugins/flux-import/import` that takes an Administrator from a file, URL or pasted snippet to a finished, watched import through the routes that already exist.

**Architecture:** A native React admin module (`src/admin/`, exported as `flux-import/admin`) compiled by the host: Kumo, Lingui and React Query come from the host as peer dependencies, and `@dnd-kit/core` resolves to the admin's own copy. One reducer holds the draft template. React Query reads collections, sources and templates. A run-driver hook loops `jobs/next` while the page is open. Every call goes through `apiFetch` to the M2-M6 routes and EmDash's own manifest and schema reads, and the module imports server code with `import type` only.

**Tech Stack:** React 19.2.4, `@cloudflare/kumo` 2.6.0, `@lingui/core` and `@lingui/react` 5.9.5, `@tanstack/react-query` 5.90.21, `@dnd-kit/core` 6.3.1 and `@dnd-kit/utilities` 3.2.2, EmDash 1.2.0 (`emdash/plugin-utils`), TypeScript 5.9 strict ESM, Vitest 4.1 with a `happy-dom` 21.0.4 project, Testing Library (`react` 16.3.3, `dom` 10.4.2, `user-event` 14.6.8, `jest-dom` 7.0.1), Biome 2.

**Spec:** `docs/superpowers/specs/2026-11-23-flux-import-m7a-admin-wizard-design.md`, all sections; its "Coordinator's calls" 1-5 are binding. Mockups (local): `.superpowers/brainstorm/map-v2.html`, `.superpowers/brainstorm/flow-and-home.html`. Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (row 7). Previous plan and review: `docs/superpowers/plans/2026-11-19-flux-import-m6d-ai-mapping.md`, `docs/superpowers/notes/2026-11-19-m6d-review.md`. EmDash docs: "React admin extensions" (`https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/`), "Distributing native plugins".

Citation conventions: EmDash paths are under `node_modules/emdash/src/` (1.2.0); admin paths under `@emdash-cms/admin@1.2.0/dist/`; this plan's facts are "Fact V<n>" and "Fact D<n>", its rulings "plan Ruling <n>"; the spec's calls are "Coordinator's call <n>".

## Global Constraints

**Interfaces and dependencies**
- The plugin ID stays `flux-import`. The descriptor gains `adminEntry: "flux-import/admin"`. The runtime gains `admin.entry: "flux-import/admin"` and `admin.pages: [{ path: "/import", label: "Import", icon: "upload-simple" }]` (Task 1). `package.json` `exports` gains `"./admin": "./src/admin/index.tsx"`. `FLUX_IMPORT_VERSION` becomes `0.6.0` (coordinator ruling: the plugin now ships admin pages and a field widget); Task 1 changes it and its definition test.
- **No engine, route or storage change.** M7a calls only existing routes (spec "The wizard"), EmDash's `GET /_emdash/api/manifest` and `GET /_emdash/api/schema/collections/<slug>?includeFields=true` (Fact V1). The only server change in this plan is Task 13, approved by the coordinator (plan Ruling 1).
- Dependencies, exactly (Fact V2, Fact V9):
  - `dependencies`: `"@dnd-kit/core": "^6.3.1"` and `"@dnd-kit/utilities": "^3.2.2"`, the admin's own ranges. No `@dnd-kit/sortable`.
  - `peerDependencies` (added beside the existing `astro` and `emdash`): `"@cloudflare/kumo": "2.6.0"`, `"@emdash-cms/admin": "*"`, `"@lingui/core": "*"`, `"@lingui/react": "*"`, `"@tanstack/react-query": "*"`, `"react": "^18.0.0 || ^19.0.0"`.
  - `devDependencies`, all exact: `@cloudflare/kumo` 2.6.0, `@emdash-cms/admin` 1.2.0, `@lingui/core` 5.9.5, `@lingui/react` 5.9.5, `@tanstack/react-query` 5.90.21, `@types/react` 19.3.0, `@types/react-dom` 19.3.0, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `@testing-library/user-event` 14.6.8, `@testing-library/jest-dom` 7.0.1, `happy-dom` 21.0.4.
  - Nothing else: no `@phosphor-icons/react`, no `jsdom`, no `@lingui/message-utils`, no Lingui CLI. Never take a newer Kumo, Lingui or React Query than the admin's (Fact D9).
- The admin module (`src/admin/**`) imports at runtime only `react`, `@cloudflare/kumo`, `@lingui/core`, `@lingui/react`, `@tanstack/react-query`, `@dnd-kit/core`, `@dnd-kit/utilities`, `emdash/plugin-utils` and its own files. It imports `emdash` and every file outside `src/admin/` with whole-clause `import type { … }` only. Task 1's boundary test enforces this.
- Plugin route URLs are `/_emdash/api/plugins/flux-import/<route>`. The upload URL is `/_emdash/api/flux-import/uploads?filename=<name>`. Every request carries `X-EmDash-Request: 1`, GETs included (Fact D2).
- Links: a collection's entries are at `/_emdash/admin/content/<collection>`. EmDash's WordPress importer is at `/_emdash/admin/import/wordpress`.

**Text and accessibility**
- Every visible string is a `Msg` (`{ id, message }`) rendered through `useT()` (plan Ruling 2). IDs match `^flux-import\.[a-z0-9-]+(\.[a-z0-9-]+)+$`, and placeholders are only `{name}` (letters). There is no plural or select syntax. English only.
- Copy the spec fixes: the 403 state is "Only administrators can import." Badges read "AI · high", "AI · medium", "AI · low", "Name · high" (and so on), "Template" and "check". The status line reads like "AI (Anthropic) · 4 filled, 1 to check" or "Name matching". The Run screen says that leaving the page pauses nothing.
- Confidence bands (for the badges): high ≥ 0.8, medium ≥ 0.5, low < 0.5. "check" when confidence < 0.5, or when a `date_format_ambiguous` or `number_format_ambiguous` warning names the field.
- The step bar is an `<ol>` of links with `aria-current="step"` on the current step. Focus moves to the step's `<h2>` on every step change. Badges carry text, not colour alone. Every drag has a keyboard path.
- Styling: Kumo components, plus Tailwind utility classes that exist in the admin's prebuilt `dist/styles.css` (Fact D3, plan Ruling 9). Every `className` is a string literal, or a conditional between string literals. Inline `style` only for @dnd-kit transforms.

**Environment**
- Node `>=22.16`. In agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- `cat` is aliased to `cat -n`. Write files with the editor tools; never `cat >` or heredocs through `cat`.
- Scratch files go in `.superpowers/wt/` (excluded from git), never `/tmp`, which WSL wipes. Throwaway installs (Task 16's `playwright-core`) go in the session scratchpad.
- Never call a real AI provider. The acceptance run uses `FakeAiServer` (`tests/integration/fake-ai.ts`).
- Dev servers: check that a port is free with `curl` before using it. Never use 4392, 4396 or 4397 (Fact F3). `astro dev` detaches in a non-TTY shell, so stop it with `pnpm exec astro dev stop` in the site directory (Fact D13).

**Code rules**
- TypeScript strict ESM, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `import type`, `.js` extensions on internal imports (also from `.tsx` files). `packages/flux-import/tsconfig.json` gains `"jsx": "react-jsx"` (Task 1).
- Biome: tabs, line width 100. Run `pnpm format` before `pnpm lint`. Biome's recommended a11y rules apply to TSX and must pass.
- No `console.*` in `src/admin/`. Show no upload ID, credential header or value, or provider text anywhere (spec Anti-goals). Show job IDs only in the URL and the log file name.

**Running tests**
- From `packages/flux-import`: `pnpm exec vitest run --project unit tests/unit/<file>.test.ts` (node), `pnpm exec vitest run --project admin tests/admin/<file>.test.tsx` (happy-dom). `pnpm test` runs both projects.
- Component tests mock the routes at the global `fetch` beneath the real `apiFetch`, with Task 1's `mockRoutes` (plan Ruling 11), so every test also checks the CSRF header.
- @dnd-kit drags in happy-dom need element rects. Use Task 1's `withRects` and the keyboard sensor: Space, then arrow keys (25 px per press), then Space (Fact V9).

**Repository hygiene**
- Never commit `sites/*/.env`, `.dev.vars`, `sites/*/emdash-env.d.ts` or `sites/dev/data.db*`. Restore with `git checkout --` any file a dev server changes.
- Commits are signed through the 1Password SSH signer. If signing fails with "1Password: failed to fill whole buffer", retry once; otherwise stop and report. Never pass `--no-gpg-sign`.
- Commit messages end at the body: no `Co-Authored-By`, no "Generated with", no AI attribution.

**Definition of done**
- `pnpm format && pnpm typecheck && pnpm lint && pnpm test` pass from the repo root after every task. Baseline at `a171ed2`: 104 unit files. This plan adds 10 node files (`admin-package`, `admin-boundary`, `admin-i18n`, `admin-limits`, `admin-api`, `admin-state`, `admin-sample`, `admin-errors`, `admin-driver`, `admin-infer`) and 12 happy-dom files (`index`, `queries`, `wizard`, `source`, `target`, `detail`, `new-fields`, `options`, `preview`, `run`, `map`, `flow`; 13 with Task 13's `source-id-field`).
- `pnpm test:integration` and `pnpm test:cf` still pass (Task 16). M7a changes no route.

## Review Focus

1. **A reload, or a second tab, in the middle of a run.** The closed page's batch keeps its lease for up to `budgetMs` + 30 s, and `jobs/next` returns the job unchanged until then (Fact D4). Expected: `/import?job=<id>` reopens the Run screen and shows "Waiting for the previous batch to finish", with an indeterminate bar. It keeps calling `jobs/next` every `LEASE_WAIT_MS` and drives on once the lease expires. It never shows an error, never stops, and never processes a record twice. Tests: Task 4 ("waits while another holder's lease is live, then drives on"), Task 12 ("reopens ?job= with a live lease: waits, then counts").
2. **A 403: an Editor, or a session without `import:execute`.** Expected: the whole page shows "Only administrators can import.", with no step bar, no retry loop and no raw message. A 403 in the middle of a step (a role changed) shows the same sentence inline, and the run driver stops at once instead of backing off. Tests: Task 4 ("does not retry a 4xx"), Task 5 ("shows the administrators-only state when the access probe answers 403").
3. **A source with zero records.** Examples: a CSV with only a header, `[]`, or a records path that matches nothing. `sources/sample` then answers no keys or `NO_SOURCE_KEYS`, and the suggestion `sample_empty`. Expected: Source shows an empty state that names the cause and suggests the records path, and Next stays disabled. If it is reached anyway (a saved template), Preview shows "No records to import" and Run stays disabled. Tests: Task 6 ("blocks Next with an empty state when the sample has no records"), Task 11 ("shows No records and disables Run for a dry run with zero records").
4. **A 1,000-key source** (wide XLSX, deep JSON), including keys 300 characters long. Expected: the Keys pane renders at most `KEYS_SHOWN` (200) rows, says "Showing 200 of 1,000 keys" with a filter box, and stays responsive. The detail panel's picker finds key 1,000 by typing. A suggestion's `keys_not_matched` shows as a plain sentence. Long names are truncated, with the full name as accessible text. Tests: Task 14 ("caps the Keys pane at 200 rows with a filter, and finds the 1,000th key"), Task 8 ("finds a key past the first 200 by typing").
5. **A collection field the template cannot map.** Examples: a `repeater`, `blocks` or other type outside `COMPATIBLE`, or a required one. Expected: the row is disabled with its reason, is not a drop target, and is absent from the picker's target list. If it is required, Next is blocked with "Every record would fail: <field> is required and cannot be imported", instead of letting Preview fail every record. Tests: Task 3 (`mapBlockers` row), Task 14 ("disables an unmappable field and blocks Next when it is required").

---

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, pnpm 10.18.0, EmDash and `@emdash-cms/admin` 1.2.0, Astro 7.3.7, at commit `a171ed2`. V1-V9 answer the coordinator's nine Task 0 items, which include the spec's six open questions. D1-D13 are facts the spec did not list.

How they were proven:
- **Workspace probe.** A copy of `HEAD` (`git archive`) in the session scratchpad. First `pnpm install --frozen-lockfile`, then the exact `pnpm --filter flux-import add` commands of Task 1, the peer dependencies by hand, `pnpm install` and `pnpm install --frozen-lockfile` again. Then a probe admin page (Kumo `Button`, `useLingui`, `useQuery`, `DndContext` with a keyboard sensor) and a happy-dom component test of it, `tsc --noEmit`, and the whole Vitest run.
- **Site probe.** The scratch copy's `sites/dev`, with `adminEntry`, `admin.entry`, `admin.pages` and the `./admin` export wired, started on port 4471 with a scratch database. A dev-bypass PAT, held in shell memory, read the manifest, schema and taxonomies and ran a dry run. Headless Chromium (`playwright-core` 1.56.1, Fact D12) opened the page through `setup/dev-bypass?redirect=…`, ran fetches in the page and recorded the module URLs requested.
- **Source reading** of `emdash` 1.2.0, `@emdash-cms/admin` 1.2.0 `dist/index.js`, `@lingui/core` 5.9.5, and a Node probe of `@lingui/core` under `NODE_ENV=production` and `development`.
- Everything was removed afterwards: the scratch workspace, the browser, the extracted library, the database, and `.superpowers/wt/scratch-m7a-plan/`. The dev server was stopped with `astro dev stop`. `git status` is clean.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | **Schema, locales and taxonomies come from EmDash's own reads; no plugin route lists them.** `GET /_emdash/api/manifest` (any signed-in user) → `data.collections: Record<slug, { label, labelSingular, supports, hidden?, fields: Record<slug, { kind, label, required, translatable, widget? }> }>`, `data.i18n?: { defaultLocale, locales[] }` (present only with more than one locale), `data.contentLocale: { defaultLocale, implicit }`, `data.taxonomies: { name, label, labelSingular, hierarchical, collections[], locale }[]`. `GET /_emdash/api/schema/collections/<slug>?includeFields=true` (needs `schema:read`, which Admins hold) → `data.item: { slug, label, fields: { slug, label, type, required, unique, validation?, widget?, sortOrder, searchable, indexed, translatable }[] }`, where `validation.options` holds select options. `GET /_emdash/api/taxonomies` → `data.taxonomies`, the same rows as the manifest's. On `sites/dev`: collections `pages` and `posts`, locales `en`, `fr` and `de`, taxonomies `category` and `tag` on `posts` | Site probe; `src/astro/routes/api/manifest.ts`, `…/schema/collections/[slug]/index.ts:22-39`, `…/taxonomies/index.ts:20-40` |
| V2 | **`@dnd-kit` resolves to the admin's copy.** `@emdash-cms/admin` 1.2.0 depends on `@dnd-kit/core ^6.3.1`, `@dnd-kit/sortable ^10.0.0` and `@dnd-kit/utilities ^3.2.2`, installed at 6.3.1, 10.0.0 and 3.2.2 (with `@dnd-kit/accessibility` 3.1.1). After Task 1's adds, the realpath of `packages/flux-import/node_modules/<pkg>` equals the admin's sibling `node_modules/<pkg>` for `@cloudflare/kumo` (the `zod@4.5.4` peer variant, the admin's), `@lingui/core`, `@lingui/react`, `@tanstack/react-query`, `@dnd-kit/core`, `@dnd-kit/utilities`, `react` and `react-dom`. In the browser each was served once (`/node_modules/.vite/deps/@cloudflare_kumo.js`, `@dnd-kit_core.js`, `@lingui_react.js`, `@tanstack_react-query.js`). `useLingui()` returned the admin's instance (`locale=en`), and `useQuery` found the admin's `QueryClient`. Vite's own `resolve.dedupe` lists only `@emdash-cms/admin`, `react` and `react-dom` (`dist/astro/index.mjs:1669`), so one copy holds because pnpm resolves one store path | Workspace and site probes |
| V3 | **A plugin can attach a field widget, but only through a server change for `flux_source_id`.** The editor reads `field.widget` as `"<pluginId>:<name>"` and renders `pluginAdmins[pluginId].fields[name]` with `{ value, onChange, label, id, required, options, validation, minimal }`, with no `readOnly` (admin `index.js:34999-35018`). `SchemaRegistry.createField` and `updateField` accept `widget` and do not validate it (`src/schema/types.ts:406-446`, `src/schema/registry.ts:1336`, `:1557`). The schema API accepts it too (docs). But `flux_source_id` is created by `ensureSourceIdField` (`packages/flux-import/src/emdash/schema.ts:67-99`) on the first real batch, without `widget`, and `schema/apply` never creates it. Attaching the widget therefore needs that function changed (plan Ruling 1) | Source; docs "Custom field widgets" |
| V4 | **No existing route converts sample values without writing.** `jobs/plan` takes only a saved `templateId` and creates a dry-run job (`routes.ts:351-379`). A dry run (`jobs/create { dryRun: true }`) writes a job row and one record row per record of the whole file to plugin storage, and has no record limit. `sources/sample` returns raw values. So the Map panel shows raw samples and Preview shows conversions (plan Ruling 6) | `src/plugin/routes.ts`; site probe (Fact D5) |
| V5 | **Hand-written `{ id, message }` descriptors work in dev only.** With `NODE_ENV=production` (any Vite build), `@lingui/core` 5.9.5 installs no message compiler (`dist/index.mjs:266-268`), and the admin installs none. A descriptor whose ID is not in the catalog is returned raw, with a "Uncompiled message detected!" `console.warn`, and `{count}` is not interpolated: `"Imported {count} records"`. In development it is interpolated. A compiled catalog entry (`["Imported ", ["count"], " records"]`) interpolates in both. The docs' pattern loads a plugin catalog into the shared `i18n` and reloads it on `change`. M7a ships no catalog, so `useT()` interpolates the English itself when the ID is absent (plan Ruling 2) | Node probe; docs "React admin extensions" |
| V6 | **`apiFetch` serves every call, with two adjustments.** It is `fetch` with `X-EmDash-Request: 1` set (`dist/plugin-utils.mjs`). For the upload route, a page-side `XMLHttpRequest` with that header answered 201 `{ success: true, data: { uploadId, bytes, sha256 } }` and fired `upload.onprogress`. Without the header it answered 403. A **GET** of `jobs/log.csv` without the header answers 403 `CSRF_REJECTED` (Fact D2). With it, 200 `text/csv; charset=utf-8` with `content-disposition: attachment; filename="flux-import-<id>.csv"`. So the log is downloaded through `apiFetch` → `Blob` → object URL, not a plain link (plan Ruling 4). `parseApiResponse` drops the error code (Fact D1) | Site probe |
| V7 | **The page mounts as documented.** With the descriptor's `adminEntry`, the runtime's `admin.entry` and `admin.pages`, and the package's `./admin` export, the manifest reports `plugins["flux-import"]: { adminMode: "react", adminPages: [{ path: "/import", label: "Import", icon: "upload-simple" }] }`. The page renders inside the admin chrome at `/_emdash/admin/plugins/flux-import/import`, with "Import" in the sidebar. `/_emdash/admin/plugins/flux-import` opens it (the root falls back to the first page, admin `index.js:220-232`). `?step=map` survives a load. `definePlugin` accepts the `admin` block unchanged | Site probe (screenshot kept in the probe, then removed) |
| V8 | **Types.** `PluginAdminExports` is `{ widgets?, pages?, fields?: Record<string, JSX.Element> }`, with `JSX` from `astro/jsx-runtime`, whose `Element` is `HTMLElement \| any`. So `export const pages: PluginAdminExports["pages"] = { "/import": ImportPage }` typechecks with a component (`dist/types-C4P7F1Vq.d.mts:1703-1707`). The admin renders a page as `<PluginComponent />` with **no props** (admin `index.js:80677-80683`). The host wraps it in `I18nProvider` and `QueryClientProvider` (`:80945-80953`) | `tsc` in the workspace probe; source |
| V9 | **DOM tests: happy-dom 21.0.4 with Vitest projects.** `vitest.config.ts` with `test.projects` (`unit`: `tests/unit/**/*.test.ts`, node; `admin`: `tests/admin/**/*.test.{ts,tsx}`, `happy-dom`) ran 104 unit files and the probe test together: 105 files, 2,822 tests, 55 s. In happy-dom: Kumo rendered; `I18nProvider` + `QueryClientProvider` worked; `fetch` stubbed under `apiFetch` saw the CSRF header; a @dnd-kit keyboard drag (Space, ArrowDown ×2, Space) with mocked `getBoundingClientRect` dropped on the target. `tsc --noEmit` passes with `"jsx": "react-jsx"`. `import userEvent from "@testing-library/user-event"` fails typecheck under NodeNext, so use `import { userEvent } from "@testing-library/user-event"`. Versions chosen as the newest released before 2026-11-09 (14 days): RTL 16.3.3 (2026-08-27), dom 10.4.2 (2026-09-13), user-event 14.6.8 (2026-10-13; 14.6.13 is held back), jest-dom 7.0.1 (2026-08-09; 8.0.0 is held back), happy-dom 21.0.4 (2026-10-20), `@types/react` and `@types/react-dom` 19.3.0 (2026-09-09). Under `minimumReleaseAge: 20160` the adds changed the lockfile by +659/−18 lines, and `--frozen-lockfile` passed after them | Workspace probe; `npm view … time` |
| D1 | `parseApiResponse` throws `new Error(message)`: the error `code`, `status` and `details` are lost (`dist/plugin-utils.mjs`). The wizard needs the code, so `readError` parses the envelope itself (plan Ruling 3) | Source |
| D2 | **Private plugin routes need `X-EmDash-Request: 1` for every method under session auth**, GET included: `if (!tokenScopes && request.headers.get("X-EmDash-Request") !== "1") return apiError("CSRF_REJECTED", …, 403)` (`src/plugins/http-route-dispatch.ts:75-77`). EmDash's own `/_emdash/api/manifest` and `/schema/*` GETs do not need it | Source; site probe |
| D3 | **The admin's CSS is prebuilt** (Tailwind 4.3.3, `@emdash-cms/admin/dist/styles.css`, 259 KB). The host does not scan plugin sources. Present: `grid-cols-3`, `md:grid-cols-3`, `gap-4`, `space-y-4`, `sr-only`, `max-h-96`, `overflow-y-auto`, `opacity-50`, `cursor-grab`, `text-kumo-danger`, `text-kumo-subtle`, `border-kumo-line`, `bg-kumo-*`. Absent: arbitrary values such as `grid-cols-[…]`. A class the admin does not use has no effect (plan Ruling 9) | Source |
| D4 | **`jobs/next` while another lease is live returns the stored job unchanged** (`batch.ts:2103-2120`; the lease lasts `budgetMs` + `LEASE_GRACE_MS` 30,000, `:127`, `:147-152`). It returns a `completed`, `paused` or `cancelled` job unchanged too. Transitions: pause from `created` or `running`; resume from `paused` or `failed`; cancel from `created`, `running`, `paused` or `failed`; retry from `completed` real jobs (`jobs.ts:395-400`). Others → 409 `INVALID_TRANSITION` (for example "Cannot pause a completed dry-run job") | Source; site probe |
| D5 | **Dry runs.** Counters count planned creates under `created` (and so on), with `removed` for the missing phase. `jobs/records` rows: `{ seq, status: "planned", sourceKey, action: "create" \| "update" \| "unchanged", changes: [{ field, before, after }] }`, or `{ status: "failed", errors: [{ field, code, message }] }` (also `conflict`, `locked`, `filtered`, `removed`), paged by `cursor` and `hasMore`. The log CSV header: `record,status,source_key,entry_id,action,error_code,error_field,message,warnings` | Site probe |
| D6 | `jobs/create` checks the mapping against the live schema: 400 `INVALID_TEMPLATE` "The template does not fit the source or schema", with `details.problems` such as `Field "excerpt" has type "text"; a number mapping needs one of number, integer` | Site probe |
| D7 | Name clashes: a URL source → 409 `CONFLICT` "A source named … already exists" (`sources.ts:143`); a template → 409 `NAME_TAKEN` (`templates.ts:335`) | Source |
| D8 | `sources/create` needs a `name` (1-100 characters) besides the URL. `credentials/list` answers `{ name, header }[]` and never a value. `sources/fetch` answers `{ changed, uploadId, bytes, sha256 }` | `routes.ts:760-822`; `sources.ts:92-97` |
| D9 | Newer upstream releases exist and must not be taken: Kumo 2.19.0 (the docs' example), Lingui 6.12.0, React Query 5.108.4 | `npm view` |
| D10 | Kumo 2.6.0 exports what the wizard needs: `Badge`, `Banner`, `Button`, `Checkbox`, `Combobox`, `Dialog` (+`DialogRoot`, `DialogTitle`, `DialogDescription`, `DialogClose`), `DatePicker`, `Empty`, `Field`, `Input`, `InputArea`, `Label`, `LayerCard`, `Link`, `Loader`, `Meter`, `Pagination`, `Popover`, `Radio`/`RadioGroup`, `Select`, `SkeletonLine`, `Surface`, `Switch`, `Table`, `Tabs`, `Text`, `Textarea`, `Toast`/`Toasty`, `Tooltip` | `@cloudflare/kumo/dist/src/index.d.ts` |
| D11 | A brand-new admin user sees a "Welcome to EmDash" dialog over every page until "Get Started" is pressed. While it is open, the page underneath is inert to role queries. The acceptance run dismisses it first | Site probe |
| D12 | **Headless Chromium on this machine:** `playwright-core` 1.56.1, installed in the session scratchpad, with `executablePath: ~/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`. The shell lacks `libasound.so.2`, so `apt-get download libasound2t64`, then `dpkg-deb -x` it into the scratchpad and set `LD_LIBRARY_PATH` to its `usr/lib/x86_64-linux-gnu`. No root needed | Site probe |
| D13 | Astro 7.3.7's `astro dev`, started without a TTY, prints "Dev server running at … (pid N) Stop: astro dev stop" and detaches. `pnpm exec astro dev stop` in the site directory stops it | Site probe |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 1.3-5.4 s; a polling wait can see it. Re-running settles it | M3c-M6d reviews |
| F3 | `Cursor.exe` on Windows can listen on `127.0.0.1:4392` and `:4397`, so `translations.test.ts` and `retention.test.ts` fail in setup in a full Node run; they pass alone on free ports | M5c-M6d reviews |

## Rulings this plan makes

1. **STOP, for the coordinator: the `flux_source_id` widget needs a server change** (Fact V3). The widget component is admin-only. But a field uses it only when its `widget` column is `"flux-import:source-id"`, and the only code that creates `flux_source_id` is `ensureSourceIdField`. The proposal, which is Task 13: pass `widget: "flux-import:source-id"` to `createField`; when the field exists with no widget, set it with `updateField` in the same idempotent pass; never overwrite a widget someone else set. Fields on existing sites are fixed by their next real import. This is a server behaviour change, which the spec's "No engine change" rule forbids without a ruling. **Coordinator's answer (2026-11-23): yes.** Set the widget on create and on an existing `flux_source_id` that has none; never overwrite another widget; no other server change. (Had the answer been no:) skip Task 13; Task 16 records "`flux_source_id` stays visible: attaching the widget needs `ensureSourceIdField` to set `widget`" in the spec's open issues, and `index.tsx` exports no `fields`.
2. **Messages live beside their components; `useT()` interpolates English itself** (Fact V5; amends the spec's single `src/admin/messages.ts`). Each area owns a `messages.ts` that exports `const M = { … } satisfies Record<string, Msg>`. The error and warning tables live in `src/admin/errors.ts`. `translate(i18n, msg, values)` calls `i18n._(msg.id, values)` when `msg.id in i18n.messages`, so a future catalog translates. Otherwise it substitutes `{name}` in the English. So no uncompiled message ever reaches Lingui: no production warning, and placeholders always work. Task 1's test keeps IDs unique and placeholders simple across every `messages.ts`.
3. **Route errors are read by `readError`, not `parseApiResponse`** (Fact D1). `ApiError { code, status, details }` comes from the `{ success: false, error: { code, message, details } }` envelope. A body that is not JSON → `HTTP_<status>`. A `fetch` rejection stays a `TypeError` (offline). Successful replies are unwrapped by `parseApiResponse`.
4. **The log is downloaded with `apiFetch` + `Blob` + an object URL** (Facts D2, V6). The file name is taken from `content-disposition`, falling back to `flux-import-<id>.csv`.
5. **The schema is read from EmDash** (Fact V1). Collections, locales and taxonomies come from the manifest. A collection's fields come from the schema API with `includeFields=true`, because the manifest has no types or options. Hidden collections are listed, with the label "(hidden)". `flux_source_id` is never shown as a target.
6. **The Map panel shows raw sample values; Preview shows conversions** (Fact V4; the spec's fallback). The panel says so in one line.
7. **Every source becomes an upload ID in the Source step.** Upload → `uploadId`; Paste → `sources/paste`; From URL → `sources/create`, then `sources/fetch`; Saved source → `sources/fetch { id }`. `sources/sample`, `templates/suggest` and `jobs/create` then all take `uploadId` (and the `source` block), which is what Coordinator's call 2 asks of Run anyway. The source ID is kept only for display.
8. **Server constants and logic the browser needs are copied into `src/admin/limits.ts` and `src/admin/wizard/sample.ts`, and node tests pin them to the server's.** The constants: `PASTE_MAX_BYTES`, `SAMPLE_MAX`, `MAX_APPLY_FIELDS`, `TEMPLATE_NAME_MAX`, `OWNER_PATTERN`, `APPLY_FIELD_TYPES`, `COMPATIBLE`, `SOURCE_FORMATS`, `MAX_UPDATE_FIELDS`, `BATCH_SIZE_MAX`. The logic: `resolvePath`. The admin cannot import them at runtime (spec "Architecture inside the package").
9. **Only Kumo and the admin's existing utility classes** (Fact D3). Task 1's test reads every `className` literal in `src/admin/**/*.tsx` through the TypeScript AST and requires each token in `@emdash-cms/admin/dist/styles.css`.
10. **`@dnd-kit/core` and `@dnd-kit/utilities` are `dependencies` with the admin's caret ranges**, so any lockfile resolves one version for both. `@dnd-kit/sortable` is not used: keys are dropped on targets, not sorted (spec "Left to the builder").
11. **Component tests mock the global `fetch` beneath the real `apiFetch`** (refines the spec's "mocked at `apiFetch`"). This exercises `apiFetch` itself, and the harness rejects any call without `X-EmDash-Request: 1`.
12. **The URL is synced with `history.replaceState(history.state, "", url)`**, keeping TanStack Router's state object, for `?step=<id>` and `?job=<id>` (Fact V7). Nothing pushes history entries.
13. **Template saves.** "Save the changes to <template>" (`templates/update` at the base revision) runs on Next from Options, so its `check.warnings` (schedule pins) show at the top of Preview, before Run. Preview and Run then use `templateId` + the new revision. "Save as template" and "Save as a new template" run `templates/create` on Run (spec), and the job runs from the saved ID and revision. An unedited saved template runs by ID and revision. "Run with these changes without saving them" runs the draft inline.
14. **Run-driver policy.**
    - `RETRY_DELAYS_MS = [1000, 3000, 9000]`: a `TypeError`, a 429 or a 5xx is retried after each delay, then reported. Any other 4xx is reported at once.
    - `LEASE_WAIT_MS = 2000`: wait, then call again, when a reply shows no progress while `job.lease` is live (Fact D4).
    - `IDLE_WAIT_MS = 500` after a reply with no progress and no lease.
    - The driver stops on `completed`, `cancelled`, `failed` or `paused`.
    - "Progress" means any change in `cursor`, `phase`, `status` or a counter.
15. **Owner** (Coordinator's call 1). `deriveOwner` gives the saved template's name, lower-cased, with runs outside `[a-z0-9]` → `-`, trimmed of `-` and cut to 100 characters. When that is empty, or for a one-off run: `wizard-<collection>-<locale>`. Validated by `OWNER_PATTERN`. The clash check lists `templates/list { collection }` (every page) and warns when another template with the same `owner` and `locale` exists.
16. **"The same date for every record"** (Coordinator's call 4) is written as `publishAt: { expr: JSON.stringify(<yyyy-MM-ddTHH:mm>), tz: "site" }`, with `publish: true`.
17. **Access is probed once on mount** with `credentials/list` (cheap, `import:execute`, and the URL tab needs it anyway). A 403 there renders the administrators-only page.

## Verification while drafting

| Check | Result |
| --- | --- |
| Task 0 (V1-V9, D1-D13) | All answered. V3 needs a coordinator ruling (plan Ruling 1); every other item holds, with the adjustments of Rulings 2-4 and 6 |
| Tree after Task 0 | `git status` clean; the scratch workspace, browser, library and `.superpowers/wt/scratch-m7a-plan/` removed; port 4471 closed |
| Tasks 1-16 | Written against `a171ed2`. Task 1's dependency commands, config and harness shape were run in the workspace probe; the components were not built while drafting |

## File map

All paths under `packages/flux-import/` unless they start at the repo root.

| File | Responsibility |
| --- | --- |
| `package.json`, `/pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/plugin/definition.ts` | Dependencies, export, JSX, test projects, the page declaration (Task 1) |
| `src/admin/index.tsx` | The `pages` export (Task 1 stub, Task 15 final; `fields` if Task 13 runs) |
| `src/admin/i18n.ts`, `src/admin/api-error.ts`, `src/admin/types.ts`, `src/admin/limits.ts` | `Msg`, `useT`; `ApiError`, `readError`; the client's schema and sample types; the mirrored constants (Task 1) |
| `tests/admin/setup.ts`, `tests/admin/harness.tsx`, `tests/admin/fixtures.ts` | jest-dom, cleanup, `renderAdmin`, `mockRoutes`, `withRects`, site fixtures (Task 1) |
| `src/admin/api.ts`, `src/admin/queries.ts` | One function per route; React Query hooks (Task 2) |
| `src/admin/wizard/state.ts`, `sample.ts`, `url.ts`, `context.tsx`, `StepFooter.tsx` | The reducer, the draft ↔ template conversion, owner and job input, sample columns, URL state, the provider, Back/Next (Task 3) |
| `src/admin/errors.ts`, `src/admin/run-driver.ts` | Code → sentence tables; `driveJob` and `useJobDriver` (Task 4) |
| `src/admin/wizard/Wizard.tsx`, `StepBar.tsx`, `messages.ts` | The shell (Task 5) |
| `src/admin/wizard/source/*` | Source step (Task 6) |
| `src/admin/wizard/target/*` | Target step (Task 7) |
| `src/admin/wizard/map/detail/*` | Detail panel and key picker (Task 8) |
| `src/admin/wizard/map/new-fields/*` | Proposed fields and the schema-diff dialog (Task 9) |
| `src/admin/wizard/options/*` | Options step (Task 10) |
| `src/admin/wizard/preview/*` | Preview step (Task 11) |
| `src/admin/wizard/run/*` | Run step (Task 12) |
| `src/admin/fields/SourceIdField.tsx`, `src/emdash/schema.ts`, `tests/unit/schema.test.ts` | The `flux_source_id` widget (Task 13, gated) |
| `src/admin/wizard/map/MapStep.tsx`, `KeysPane.tsx`, `FieldsPane.tsx`, `useSuggestions.ts`, `messages.ts` | The Map step's composition (Task 14) |
| `tests/admin/flow.test.tsx` | Whole-wizard flows (Task 15) |
| `docs/superpowers/notes/2026-11-23-m7a-review.md`, the spec, the roadmap | The review (Task 16) |

Every test file is new: `tests/unit/admin-*.test.ts` (node) and `tests/admin/*.test.tsx` (happy-dom), named in each task. The exception is `tests/unit/definition.test.ts` (Task 1) and, if Task 13 runs, `tests/unit/schema.test.ts`.

## Parallel execution

| Task | Depends on (produced interface) | Touches | Suggested model |
| --- | --- | --- | --- |
| 0. Verify | — | nothing (results above) | — |
| 1. Package, harness, guards | — | manifests, lockfile, configs, `src/index.ts`, `definition.ts`, `src/admin/{index.tsx,i18n.ts,api-error.ts,types.ts,limits.ts}`, `tests/admin/{setup.ts,harness.tsx,fixtures.ts,index.test.tsx}`, `tests/unit/{admin-package,admin-boundary,admin-i18n,admin-limits,definition}.test.ts` | opus |
| 2. API adapters, queries | 1 | `src/admin/{api,queries}.ts`, `tests/unit/admin-api.test.ts`, `tests/admin/queries.test.tsx` | sonnet |
| 3. Wizard state | 1 | `src/admin/wizard/{state.ts,sample.ts,url.ts,context.tsx,StepFooter.tsx}`, `tests/unit/admin-{state,sample}.test.ts` | opus |
| 4. Errors, run driver | 1 | `src/admin/{errors,run-driver}.ts`, `tests/unit/admin-{errors,driver}.test.ts` | opus |
| 5. Shell | 1-4 | `src/admin/wizard/{Wizard.tsx,StepBar.tsx,messages.ts}`, `tests/admin/wizard.test.tsx` | sonnet |
| 6. Source | 1-4 | `src/admin/wizard/source/*`, `tests/admin/source.test.tsx` | opus |
| 7. Target | 1-3 | `src/admin/wizard/target/*`, `tests/admin/target.test.tsx` | sonnet |
| 8. Detail panel | 1, 3 | `src/admin/wizard/map/detail/*`, `tests/admin/detail.test.tsx` | opus |
| 9. New fields, schema diff | 1-4 | `src/admin/wizard/map/new-fields/*`, `tests/unit/admin-infer.test.ts`, `tests/admin/new-fields.test.tsx` | sonnet |
| 10. Options | 1-4 | `src/admin/wizard/options/*`, `tests/admin/options.test.tsx` | opus |
| 11. Preview | 1-4 | `src/admin/wizard/preview/*`, `tests/admin/preview.test.tsx` | sonnet |
| 12. Run | 1-4 | `src/admin/wizard/run/*`, `tests/admin/run.test.tsx` | opus |
| 13. Field widget (gated) | 1, Ruling 1 | `src/admin/fields/SourceIdField.tsx`, `src/emdash/schema.ts`, `tests/unit/schema.test.ts`, `tests/admin/source-id-field.test.tsx` | sonnet |
| 14. Map | 1-4, 8, 9 | `src/admin/wizard/map/{MapStep.tsx,KeysPane.tsx,FieldsPane.tsx,useSuggestions.ts,messages.ts}`, `tests/admin/map.test.tsx` | opus |
| 15. Assembly | 5-14 | `src/admin/index.tsx`, `tests/admin/{index,flow}.test.tsx` | opus |
| 16. Review | 0-15 | the note, the spec, the roadmap; temporary scratch only | opus |

The waves:
1. **1** alone: it installs every package the rest compiles against.
2. **2 ∥ 3 ∥ 4.** No shared file. Each consumes only Task 1's `types.ts`, `limits.ts`, `api-error.ts` and `i18n.ts`.
3. **5 ∥ 6 ∥ 7 ∥ 8 ∥ 9 ∥ 10 ∥ 11 ∥ 12 ∥ 13.** Each owns its own directory and imports only wave-1 and wave-2 files: the helpers several of them share (`deriveOwner`, `ownerOf`, `jobInput`, `readUrl`, `writeUrl`) are Task 3's. The shell (Task 5) takes the step components as props, so it imports no step. Task 13 runs only on the coordinator's "yes".
4. **14** (composes 8 and 9).
5. **15** (wires every step into `index.tsx`).
6. **16.**

Files touched by more than one task, merged in numeric order: `src/admin/index.tsx` (Tasks 1, 15), `tests/admin/index.test.tsx` (Tasks 1, 15). Neither is touched by two tasks of one wave.

---

### Task 0: Verify the unconfirmed facts (V1-V9)

**Files:** none.

**Interfaces:**
- Consumes: the installed EmDash 1.2.0 and admin 1.2.0, the docs, and the probes described above.
- Produces: Facts V1-V9 and D1-D13, and plan Rulings 1-6 and 9-12. Rulings 7, 8 and 13-17 come from writing Tasks 2-12. Task 16's note records the results from the Facts table.

- [x] **V1** schema reads; **V2** one copy of each shared library; **V4** no sample-conversion route; **V5** Lingui fallback; **V6** `apiFetch`, upload and log; **V7** mounting; **V8** types; **V9** DOM tests. All proven.
- [x] **V3**: the field widget is possible only with a server change; the coordinator approved it (plan Ruling 1).

### Task 1: Package wiring, the test harness and the guards

**Files:**
- Modify: `packages/flux-import/package.json` (`exports`, `dependencies`, `peerDependencies`, `devDependencies`), `pnpm-lock.yaml`, `packages/flux-import/tsconfig.json` (`"jsx": "react-jsx"`), `packages/flux-import/vitest.config.ts`, `src/index.ts` (`adminEntry`), `src/plugin/definition.ts` (`admin.entry`, `admin.pages`), `src/meta.ts` (`FLUX_IMPORT_VERSION` `"0.6.0"`; `tests/unit/definition.test.ts` asserts it)
- Create: `src/admin/index.tsx`, `src/admin/i18n.ts`, `src/admin/api-error.ts`, `src/admin/types.ts`, `src/admin/limits.ts`, `tests/admin/setup.ts`, `tests/admin/harness.tsx`, `tests/admin/fixtures.ts`, `tests/admin/index.test.tsx`
- Test: `tests/unit/admin-package.test.ts`, `tests/unit/admin-boundary.test.ts`, `tests/unit/admin-i18n.test.ts`, `tests/unit/admin-limits.test.ts`; modify `tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/admin/i18n.ts
  export interface Msg { readonly id: string; readonly message: string }
  export type Values = Readonly<Record<string, string | number>>;
  export function interpolate(message: string, values?: Values): string; // "{name}" → values.name; a missing value stays "{name}"
  export function translate(i18n: I18n, msg: Msg, values?: Values): string; // Ruling 2
  export function useT(): (msg: Msg, values?: Values) => string; // useLingui().i18n + translate
  // src/admin/api-error.ts
  export class ApiError extends Error { readonly code: string; readonly status: number; readonly details: unknown }
  export async function readError(res: Response): Promise<ApiError>; // Ruling 3
  export function isRetryable(e: unknown): boolean; // TypeError, or ApiError with status 429 or >= 500
  // src/admin/types.ts — the browser's view of EmDash's reads (Fact V1) and of a sample
  export interface SchemaField { slug: string; label: string; type: string; required: boolean; options?: string[] }
  export interface CollectionInfo { slug: string; label: string; hidden: boolean }
  export interface TaxonomyInfo { name: string; label: string; hierarchical: boolean; collections: string[] }
  export interface SiteInfo { collections: CollectionInfo[]; locales: string[]; defaultLocale: string; taxonomies: TaxonomyInfo[] }
  export interface SampleColumn { key: string; values: unknown[] } // values: one per sampled record, `undefined` where absent
  export interface CreateJobInput { uploadId: string; dryRun: boolean; template?: unknown; templateId?: string; templateRevision?: number; publish: boolean; batchSize?: number; journal: true; missing?: false | { maxPercent: number } }
  // src/admin/limits.ts — Ruling 8; values equal the server's
  export const PASTE_MAX_BYTES = 1_048_576, SAMPLE_MAX = 20, MAX_APPLY_FIELDS = 100, TEMPLATE_NAME_MAX = 100,
    MAX_UPDATE_FIELDS = 200, BATCH_SIZE_MAX = 500;
  export const OWNER_PATTERN: RegExp; // /^[A-Za-z0-9._:-]{1,100}$/
  export const SOURCE_FORMATS: readonly ("csv" | "json" | "jsonl" | "xml" | "xlsx")[];
  export const APPLY_FIELD_TYPES: readonly string[]; // the 14 of schema-apply.ts:22-37, same order
  export const COMPATIBLE: Readonly<Record<MappingType, readonly string[]>>; // template.ts:1196-1209
  export type MappingType = "text" | "number" | "date" | "boolean" | "select" | "multiSelect" | "json" | "slug" | "reference" | "image" | "file" | "portableText";
  export const KEYS_SHOWN = 200; // Review Focus 4
  // tests/admin/harness.tsx
  export interface RouteCall { method: string; path: string; route: string; body: unknown }
  export type RouteHandler = (body: unknown, call: RouteCall) => unknown; // a plain value → { success: true, data }; a Response passes through
  export function mockRoutes(table: Record<string, RouteHandler>): { calls: RouteCall[] };
  //   keys: a plugin route name ("jobs/next"), "upload", "GET manifest", "GET collection:<slug>", "GET log.csv"
  //   throws on any unknown request, and on any request without X-EmDash-Request: 1; unstubbed in afterEach by setup.ts
  export function fail(code: string, message: string, status: number, details?: unknown): Response;
  export function renderAdmin(ui: ReactElement): RenderResult & { user: UserEvent; queryClient: QueryClient };
  //   wraps in I18nProvider(setupI18n en) and QueryClientProvider (retry: false)
  export function withRects(rects: Record<string, DOMRect>): () => void; // by data-testid; returns restore
  // tests/admin/fixtures.ts
  export const MANIFEST: unknown; export const POSTS: unknown; // shaped exactly as Fact V1, from sites/dev
  export function job(over?: Partial<Job>): Job; export function sampleCsv(keys: string[], rows: string[][]): unknown;
  ```
  `src/admin/index.tsx` exports `pages: PluginAdminExports["pages"] = { "/import": ImportPage }`, where `ImportPage` is a stub that renders `<h1>` "Import" until Task 15.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-package.test.ts`:
```ts
it("declares the admin export, the host peers and the admin's @dnd-kit ranges", () => {
	expect(pkg.exports["./admin"]).toBe("./src/admin/index.tsx");
	expect(pkg.peerDependencies).toMatchObject({ "@cloudflare/kumo": "2.6.0", "@emdash-cms/admin": "*",
		"@lingui/core": "*", "@lingui/react": "*", "@tanstack/react-query": "*", react: "^18.0.0 || ^19.0.0" });
	expect(pkg.dependencies["@dnd-kit/core"]).toBe(adminPkg.dependencies["@dnd-kit/core"]); // "^6.3.1"
	expect(pkg.dependencies["@dnd-kit/utilities"]).toBe(adminPkg.dependencies["@dnd-kit/utilities"]);
	expect(pkg.devDependencies["@cloudflare/kumo"]).toBe(adminPkg.dependencies["@cloudflare/kumo"]); // "2.6.0"
	expect(pkg.dependencies["@dnd-kit/sortable"]).toBeUndefined();
});
it.each(["@cloudflare/kumo", "@lingui/core", "@lingui/react", "@tanstack/react-query", "@dnd-kit/core",
	"@dnd-kit/utilities", "react", "react-dom"])("resolves %s to the admin's own copy (Fact V2)", (name) => {
	// realpath(packages/flux-import/node_modules/<name>) === realpath(<admin realpath>/../../<name>)
});
```
`tests/unit/admin-boundary.test.ts` (TypeScript AST via `typescript`; walks the graph from `src/admin/index.tsx`, and also every file under `src/admin/`):
```ts
it("imports server code and emdash with whole-clause import type only", …);  // relative paths leaving src/admin/, and "emdash": importClause.isTypeOnly
it("imports at runtime only the allowed packages", …);  // the list in Global Constraints
it("declares every runtime package as a peer, except @dnd-kit/*, which are dependencies", …);
it("uses only class names the admin's prebuilt CSS defines (Ruling 9)", …);  // every className literal token: `.${cssEscape(token)}` occurs in admin dist/styles.css
it("keeps message IDs unique, well-formed and free of ICU syntax (Ruling 2)", …);  // imports every src/admin/**/messages.ts and errors.ts; values are Msg; ID pattern; placeholders /\{[A-Za-z]+\}/ only
```
`tests/unit/admin-i18n.test.ts`:
```ts
it("interpolates English when the catalog has no entry, without calling i18n._", () => {
	const i18n = setupI18n({ locale: "fr", messages: { fr: {} } }); const spy = vi.spyOn(i18n, "_");
	expect(translate(i18n, { id: "flux-import.t.n", message: "Imported {count} of {total}" }, { count: 3, total: 10 }))
		.toBe("Imported 3 of 10");
	expect(spy).not.toHaveBeenCalled();
});
it("uses a loaded catalog entry", …);  // i18n.load("fr", { "flux-import.t.n": ["Importé ", ["count"]] }) → "Importé 3"
it("reads code, message, status and details from an error envelope; HTTP_<status> otherwise", …);  // readError
it("treats TypeError, 429 and 5xx as retryable, other 4xx not", …);  // isRetryable
```
`tests/unit/admin-limits.test.ts`: each constant in `limits.ts` equals the server's (`PASTE_MAX_BYTES`, `SAMPLE_MAX` from `src/plugin/service.ts`; `MAX_APPLY_FIELDS`, `APPLY_FIELD_TYPES` from `schema-apply.ts`; `TEMPLATE_NAME_MAX` from `templates.ts`; `OWNER_PATTERN.source`, `COMPATIBLE`, `MAX_UPDATE_FIELDS` from `engine/template.ts`; `SOURCE_FORMATS` from `sources/reader.ts`; `BATCH_SIZE_MAX` from `engine/types.ts`).
`tests/unit/definition.test.ts`, one new `it`: `fluxImport().adminEntry === "flux-import/admin"`, `createPlugin().admin.entry === "flux-import/admin"`, `admin.pages` equals `[{ path: "/import", label: "Import", icon: "upload-simple" }]`.
`tests/admin/index.test.tsx`: `renderAdmin(<pages["/import"] />)` shows a heading "Import"; `mockRoutes` rejects a request without the CSRF header.

- [ ] **Step 2: See them fail**

Run (from `packages/flux-import`): `pnpm exec vitest run tests/unit/admin-package.test.ts tests/unit/definition.test.ts`
Expected: FAIL (no `./admin` export; `adminEntry` undefined).

- [ ] **Step 3: Dependencies**

From the repo root: `pnpm install --frozen-lockfile`, then
```bash
pnpm --filter flux-import add @dnd-kit/core@^6.3.1 @dnd-kit/utilities@^3.2.2
pnpm --filter flux-import add -D --save-exact @cloudflare/kumo@2.6.0 @emdash-cms/admin@1.2.0 @lingui/core@5.9.5 @lingui/react@5.9.5 @tanstack/react-query@5.90.21 @types/react@19.3.0 @types/react-dom@19.3.0 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.8 @testing-library/jest-dom@7.0.1 happy-dom@21.0.4
```
Then add `peerDependencies` and the `./admin` export by hand, run `pnpm install`, then `pnpm install --frozen-lockfile`. Expected: "Done", and a lockfile diff of about +660/−20 lines (Fact V9). The missing `prosemirror-*` peer warnings were already there. If pnpm resolves any other version of a package named above, stop and report.

- [ ] **Step 4: Config, declarations, the four modules and the harness**

- `vitest.config.ts`: `test.projects`: `{ extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } }` and `{ extends: true, test: { name: "admin", include: ["tests/admin/**/*.test.{ts,tsx}"], environment: "happy-dom", setupFiles: ["tests/admin/setup.ts"] } }`.
- `tests/admin/setup.ts`: `import "@testing-library/jest-dom/vitest"`; `afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); })`.
- `src/index.ts`: `adminEntry: "flux-import/admin"` in the descriptor. `definition.ts`: `entry` and `pages` first in `admin`, with a comment citing the docs.
- The four modules as in Interfaces. `limits.ts` holds literal copies; no import from outside `src/admin/`.

- [ ] **Step 5: See them pass**

Run: `pnpm exec vitest run tests/unit/admin-package.test.ts tests/unit/admin-boundary.test.ts tests/unit/admin-i18n.test.ts tests/unit/admin-limits.test.ts tests/unit/definition.test.ts` and `pnpm exec vitest run --project admin`
Expected: PASS. Mutation checks:
- `import { templateSchema } from "../engine/template.js"` in `index.tsx` fails the boundary test;
- `className="grid-cols-[1fr_2fr]"` fails the class test;
- a duplicate message ID fails the message test.

- [ ] **Step 6: Commit**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add pnpm-lock.yaml packages/flux-import
git commit -m "Add the admin entry, its host peers and @dnd-kit, the DOM test project and the admin guards"
```

### Task 2: API adapters and queries

**Files:**
- Create: `src/admin/api.ts`, `src/admin/queries.ts`
- Test: `tests/unit/admin-api.test.ts` (node, `fetch` stubbed), `tests/admin/queries.test.tsx`

**Interfaces:**
- Consumes: Task 1's `ApiError`, `readError`, `SiteInfo`, `SchemaField`, `SampleColumn` types and `limits.ts`; server types by `import type` only (`Job`, `RecordRow`, `RecordStatus` from `engine/types.ts`; `Template`, `TemplateSource` from `engine/template.ts`; `SuggestReply` from `plugin/suggest.ts`; `SavedTemplate`, `SavedResult`, `TemplateSummary` from `plugin/templates.ts`; `SourceRow`, `FetchOutcome` from `plugin/sources.ts`; `CredentialInfo` from `plugin/credentials.ts`; `ApplyResult`, `FieldRequest` from `plugin/schema-apply.ts`; `Page` from `plugin/service.ts`; `CsvSample` from `sources/csv.ts`; `ValueSample` from `sources/reader.ts`).
- Produces:
  ```ts
  export const PLUGIN_BASE = "/_emdash/api/plugins/flux-import";
  export const UPLOAD_URL = "/_emdash/api/flux-import/uploads";
  export async function callRoute<T>(route: string, input: unknown, signal?: AbortSignal): Promise<T>; // POST JSON via apiFetch
  export function uploadFile(file: File, opts?: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal }): Promise<{ uploadId: string; bytes: number }>;
  export const api: { // createJob takes Task 1's CreateJobInput
  	sample(i: { uploadId: string; n?: number; source?: TemplateSource }): Promise<CsvSample | ValueSample>;
  	paste(i: { format: Exclude<SourceFormat, "xlsx">; text: string }): Promise<{ uploadId: string; bytes: number }>;
  	credentials(): Promise<CredentialInfo[]>;
  	createSource(i: { name: string; url: string; credential?: string }): Promise<SourceRow>;
  	fetchSource(i: { id: string; force?: boolean }): Promise<FetchOutcome>;
  	listSources(i: { cursor?: string }): Promise<Page<SourceRow>>;
  	listTemplates(i: { collection?: string; cursor?: string }): Promise<Page<TemplateSummary>>;
  	getTemplate(i: { id: string }): Promise<SavedTemplate>;
  	createTemplate(i: { name: string; template: unknown }): Promise<SavedResult>;
  	updateTemplate(i: { id: string; revision: number; template: unknown }): Promise<SavedResult>;
  	suggest(i: { collection: string; locale: string; uploadId: string; source?: TemplateSource }): Promise<SuggestReply>; // never sends `ai` (spec)
  	applySchema(i: { collection: string; fields: FieldRequest[]; dryRun: boolean }): Promise<ApplyResult>;
  	createJob(i: CreateJobInput): Promise<Job>;
  	next(i: { id: string }): Promise<Job>; getJob(i: { id: string }): Promise<Job>;
  	pause(i: { id: string }): Promise<Job>; resume(…): …; cancel(…): …; retry(…): …;
  	records(i: { id: string; status?: RecordStatus; cursor?: string }): Promise<Page<RecordRow>>;
  	site(): Promise<SiteInfo>;                        // GET /_emdash/api/manifest, mapped (Ruling 5)
  	collection(slug: string): Promise<SchemaField[]>; // GET …/schema/collections/<slug>?includeFields=true, sorted by sortOrder, without flux_source_id; options from validation.options
  };
  export async function downloadLog(id: string, status?: "failed"): Promise<void>; // Ruling 4
  // queries.ts — keys under ["flux-import", …]
  export function useSite(): UseQueryResult<SiteInfo>;
  export function useFields(collection: string | null): UseQueryResult<SchemaField[]>;
  export function useCredentials(): UseQueryResult<CredentialInfo[]>;
  export function useAllSources(): UseQueryResult<SourceRow[]>;            // follows cursors to the end
  export function useAllTemplates(collection?: string): UseQueryResult<TemplateSummary[]>; // follows cursors
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-api.test.ts`:
```ts
it("posts JSON to /_emdash/api/plugins/flux-import/<route> with the CSRF header and unwraps data", …);
it("throws ApiError with code, status and details from an error envelope", async () => {
	stub(400, { success: false, error: { code: "INVALID_TEMPLATE", message: "m", details: { problems: ["p"] } } });
	await expect(api.createJob(input)).rejects.toMatchObject({ code: "INVALID_TEMPLATE", status: 400, details: { problems: ["p"] } });
});
it.each(Object.keys(ROUTE_INPUTS))("sends %s an input its route schema accepts", (route) => {
	// ROUTE_INPUTS: one sample call per api function; parse the recorded body with the route's own
	// schema from src/plugin/routes.ts (routes[route].input.safeParse(body).success === true)
});
it("never sends `ai` to templates/suggest", …);
it("maps the manifest to SiteInfo: locales from i18n, else [contentLocale.defaultLocale]", …);  // both branches, MANIFEST fixture
it("reads fields in sortOrder without flux_source_id, options from validation.options", …);
it("uploads with XMLHttpRequest: filename query, CSRF header, progress, 201 data", …);  // fake XHR class via vi.stubGlobal
it("rejects an upload with ApiError from the error envelope (UNSUPPORTED_SOURCE 415)", …);
it("downloads the log through apiFetch as a blob, named from content-disposition", …);  // GET …/jobs/log.csv?id=J&status=failed with the header; anchor.download === "flux-import-J.csv"; URL.revokeObjectURL called
```
`tests/admin/queries.test.tsx`: `useAllTemplates("posts")` follows `cursor` across two pages and returns 10 items; `useFields(null)` makes no request.

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run tests/unit/admin-api.test.ts && pnpm exec vitest run --project admin tests/admin/queries.test.tsx`
Expected: FAIL, `Cannot find module '../../src/admin/api.js'`.

- [ ] **Step 3: Implement `api.ts` and `queries.ts`**

`callRoute`: `apiFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal })`. `!res.ok` → `throw await readError(res)`, else `parseApiResponse<T>(res)`. `uploadFile`: `XMLHttpRequest`, `open("POST", \`${UPLOAD_URL}?filename=${encodeURIComponent(file.name)}\`)`, `setRequestHeader("X-EmDash-Request", "1")`, `upload.onprogress`, abort on `signal`, then parse the envelope from `responseText`. A network error rejects with `TypeError`.

- [ ] **Step 4: See them pass**

Same commands. Expected: PASS. Mutation check: send `ai: false` from `api.suggest`, and "never sends `ai`" fails.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/api.ts packages/flux-import/src/admin/queries.ts packages/flux-import/tests/unit/admin-api.test.ts packages/flux-import/tests/admin/queries.test.tsx
git commit -m "Add the admin's route adapters and schema, source and template queries"
```

### Task 3: Wizard state, sample columns and the draft template

**Files:**
- Create: `src/admin/wizard/state.ts`, `src/admin/wizard/sample.ts`, `src/admin/wizard/url.ts`, `src/admin/wizard/context.tsx`, `src/admin/wizard/StepFooter.tsx`
- Test: `tests/unit/admin-state.test.ts`, `tests/unit/admin-sample.test.ts`

These pure helpers live here, not in the step tasks, because several wave-3 tasks share them: `deriveOwner` (Options, Preview, Run), `jobInput` (Preview, Run), `readUrl`/`writeUrl` (shell, Run).

**Interfaces:**
- Consumes: Task 1's types (`CreateJobInput`, `SchemaField`, `SampleColumn`), `limits.ts`, `Msg`/`useT`; server types by `import type` (`Template`, `FieldMapping`, `TemplateSource`, `TemplateRules` from `engine/template.ts`; `SuggestReply`, `SuggestWarning`).
- Produces:
  ```ts
  export type StepId = "source" | "target" | "map" | "options" | "preview" | "run";
  export const STEPS: readonly StepId[]; // in that order
  export type RowId = "key" | "slug" | "publishAt" | "translationOf" | "bylines" | `field:${string}` | `taxonomy:${string}`;
  export type ValueSource = { from: string } | { expr: string };
  export type RowMapping = ValueSource & Record<string, unknown>; // a field's FieldMapping, a taxonomy's or bylines' options, or a bare ValueSource
  export interface RowMeta { origin: "ai" | "name" | "template" | "user"; confidence?: number; rationale?: string; check: boolean }
  export interface SourceChoice { kind: "upload" | "url" | "paste" | "saved"; uploadId: string; label: string }
  export interface ProposedField { key: string; slug: string; label: string; type: string; translatable: boolean; searchable: boolean }
  export interface Options {
  	mode: "upsert" | "create" | "update"; updateFields: string[]; protectEdited: boolean;
  	status: "publish" | "draft" | "schedule";
  	schedule: { kind: "fixed"; at: string } | { kind: "feed"; from: string; format?: string; tz?: string } | null;
  	missing: { action: "trash" | "unpublish"; maxPercent: number } | null;
  	owner: string | null;   // null: derived (Ruling 15)
  	batchSize: number | null;
  	save: { kind: "none" } | { kind: "new"; name: string } | { kind: "update" }; // "update" only with a base
  }
  export interface WizardState {
  	step: StepId; source: SourceChoice | null; sourceBlock: TemplateSource; columns: SampleColumn[] | null;
  	base: { id: string; revision: number; name: string; template: Template } | null;
  	target: { collection: string; locale: string; translationLocale: string | null } | null;
  	rows: Partial<Record<RowId, RowMapping>>; meta: Partial<Record<RowId, RowMeta>>;
  	suggestion: { status: "idle" | "loading" | "done" | "error"; reply?: SuggestReply; error?: unknown; dismissed: boolean };
  	newFields: ProposedField[]; options: Options;
  	savedRevision: number | null;   // set by Ruling 13's update on leaving Options
  	dryRun: { jobId: string; uploadId: string; total: number | null } | null;
  	run: { jobId: string } | null; dirty: boolean;
  }
  export type WizardAction =
  	| { type: "stepChanged"; step: StepId }
  	| { type: "sourceReady"; source: SourceChoice; sourceBlock: TemplateSource; columns: SampleColumn[] }
  	| { type: "sourceBlockChanged"; sourceBlock: TemplateSource; columns: SampleColumn[] | null }
  	| { type: "templateLoaded"; base: NonNullable<WizardState["base"]> }   // fills target, rows, meta(origin template), options; step → preview
  	| { type: "targetChosen"; collection: string; locale: string; translationLocale: string | null }
  	| { type: "suggestionStarted" } | { type: "suggestionFailed"; error: unknown }
  	| { type: "suggestionReceived"; reply: SuggestReply; overwriteUserRows: boolean }
  	| { type: "warningsDismissed" }
  	| { type: "rowSet"; row: RowId; mapping: RowMapping } | { type: "rowCleared"; row: RowId }
  	| { type: "fieldProposed"; field: ProposedField } | { type: "fieldChanged"; slug: string; patch: Partial<ProposedField> }
  	| { type: "fieldRemoved"; slug: string } | { type: "fieldsApplied"; slugs: string[] }
  	| { type: "optionsChanged"; patch: Partial<Options> } | { type: "templateSaved"; revision: number }
  	| { type: "dryRunStarted"; jobId: string; uploadId: string } | { type: "dryRunFinished"; total: number }
  	| { type: "runStarted"; jobId: string } | { type: "jobReopened"; jobId: string };
  export const initialState: WizardState;
  export function reducer(state: WizardState, action: WizardAction): WizardState;
  export function toTemplate(state: WizardState, owner: string): unknown;        // version 1, source, collection, locale, key, slug?, translationOf?, fields, taxonomies?, bylines?, publishAt?, rules (owner always; missing only when set)
  export function fromTemplate(t: Template): Pick<WizardState, "rows" | "meta"> & { options: Partial<Options>; target: NonNullable<WizardState["target"]> };
  export function isEdited(state: WizardState): boolean;                          // toTemplate(state) deep-differs from base.template (with the same owner)
  export type Blocker = { row: RowId | null; msg: Msg; values?: Values };
  export function mapBlockers(state: WizardState, fields: readonly SchemaField[]): Blocker[]; // key unmapped; required field unmapped; required field unmappable (Review Focus 5); proposed fields not applied
  export function mappable(field: SchemaField): boolean;                           // some COMPATIBLE list includes field.type; reference only with a target
  export function reachable(state: WizardState, step: StepId): boolean;            // a step is reachable when every earlier step is complete
  export function deriveOwner(p: { templateName: string | null; collection: string; locale: string }): string; // Ruling 15
  export function ownerOf(state: WizardState): string; // options.owner ?? deriveOwner(save name or base name, target)
  export function jobInput(state: WizardState, dryRun: boolean): CreateJobInput;
  // uploadId: dryRun ? source.uploadId : dryRun's uploadId (Coordinator's call 2); templateId + templateRevision when running
  // a saved template unedited or after Ruling 13's update (savedRevision), else template: toTemplate(state, ownerOf(state));
  // publish: status !== "draft"; batchSize when set; journal: true
  // url.ts (Ruling 12)
  export function readUrl(search: string): { step: StepId | null; job: string | null };
  export function writeUrl(patch: { step?: StepId; job?: string | null }): void; // history.replaceState(history.state, "", url)
  // sample.ts
  export function resolvePath(value: unknown, path: string, format: SourceFormat): unknown; // copy of src/sources/paths.ts:61-91 (Ruling 8)
  export function sampleColumns(sample: { headers: string[]; rows: string[][] } | { records: unknown[]; paths: string[] }, format: SourceFormat): SampleColumn[];
  // context.tsx
  export function WizardProvider(props: { initial?: Partial<WizardState>; children: ReactNode }): JSX.Element;
  export function useWizard(): { state: WizardState; dispatch: Dispatch<WizardAction> };
  // StepFooter.tsx
  export function StepFooter(props: { canNext: boolean; reason?: string; nextLabel?: string; onNext(): void | Promise<void>; busy?: boolean }): JSX.Element; // Back (when not the first step) and Next; the reason is shown as text beside a disabled Next
  ```
  Default `Options`: `mode: "upsert"`, `updateFields: []`, `protectEdited: false`, `status: "publish"`, `schedule: null`, `missing: null`, `owner: null`, `batchSize: null`, `save: { kind: "none" }`. Default `sourceBlock`: `{ format: "csv" }`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-state.test.ts`, as a table of transitions plus targeted cases:
```ts
it.each([
	["sourceReady", "clears columns' dependants: rows' suggestion, dryRun; keeps target"],
	["sourceBlockChanged", "replaces columns, clears suggestion and dryRun"],
	["targetChosen (new collection)", "clears rows, meta, newFields, suggestion and dryRun"],
	["targetChosen (same collection, new locale)", "keeps rows; clears dryRun"],
	["rowSet", "sets meta.origin user; clears dryRun; dirty"],
	["optionsChanged", "clears dryRun"],
	["fieldsApplied", "removes the applied slugs from newFields"],
	["templateLoaded", "fills target, rows, options; meta origin template; step preview"],
	["dryRunStarted/Finished", "keep rows; set dryRun"],
	["stepChanged", "keeps dryRun"],
	["jobReopened", "step run, run.jobId set, dirty false"],
])("%s: %s", …);
it("fills only rows the user has not set; overwriteUserRows replaces them too", …);
it("marks a suggestion 'check' below 0.5 or when a format warning names the field", …);
it("builds a template that the engine's templateSchema accepts, with rules.owner always", () => {
	// import { templateSchema } from "../../src/engine/template.js" in the TEST (allowed: tests are not src/admin)
	expect(templateSchema.safeParse(toTemplate(filled, "wizard-posts-en")).success).toBe(true);
});
it("writes missing only with an owner, publishAt with publish, the fixed date as a JSON string expr with tz site (Ruling 16)", …);
it("round-trips fromTemplate(toTemplate(s)) and isEdited is false until a row changes", …);
it("blocks Map on an unmapped key, a required unmapped field, a required unmappable field, an unapplied proposal", …);
it("derives the owner from the template name, else wizard-<collection>-<locale>", …);  // "Products feed" → "products-feed"; "!!!" → "wizard-posts-en"; 150 letters → cut to 100
it("builds a dry run's job input from the draft with journal true, and the real run's from the dry run's upload", …);
it("builds the job input from the saved template's id and revision when unedited or just saved", …);
it("reads ?step and ?job, and writes them with replaceState keeping history.state", …);  // stub window.history
```
`tests/unit/admin-sample.test.ts`:
```ts
it.each(cases)("resolvePath agrees with the engine on %s", (_, value, path, format) =>
	expect(resolvePath(value, path, format)).toEqual(engineResolvePath(value, path, format)));
	// cases: JSON nested, JSON null, array stop, XML attribute, XML #text, XML text element, CSV dotted header
it("builds CSV columns from headers and rows, undefined for short rows", …);
it("builds JSON/XML columns from paths and records", …);
```

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run tests/unit/admin-state.test.ts tests/unit/admin-sample.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

The reducer is pure. Every action except `stepChanged`, `warningsDismissed`, `dryRun*`, `runStarted`, `jobReopened` and `templateSaved` sets `dryRun: null` and `dirty: true`.
`suggestionReceived` maps `reply.key`, `reply.slug` and `reply.fields[i]` (`from` and `mapping`, plus the draft's options for that field, from `reply.template.fields[field]`) into `rows` and `meta`. Origin: `fallback` → `"name"`. Rows with `from: null` are left empty.

- [ ] **Step 4: See them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard packages/flux-import/tests/unit/admin-state.test.ts packages/flux-import/tests/unit/admin-sample.test.ts
git commit -m "Add the wizard reducer, the draft template conversion and sample columns"
```

### Task 4: The error tables and the run driver

**Files:**
- Create: `src/admin/errors.ts`, `src/admin/run-driver.ts`
- Test: `tests/unit/admin-errors.test.ts`, `tests/unit/admin-driver.test.ts`

**Interfaces:**
- Consumes: Task 1's `Msg`, `Values`, `ApiError`, `isRetryable`; `Job` by `import type`.
- Produces:
  ```ts
  // errors.ts
  export const WIZARD_ERROR_CODES: readonly string[];   // pinned list below
  export const SUGGEST_WARNING_CODES: readonly string[]; // pinned list below
  export const ERROR_MESSAGES: Readonly<Record<string, Msg>>;   // one per WIZARD_ERROR_CODES, plus "offline" and "unknown"
  export const WARNING_MESSAGES: Readonly<Record<string, Msg>>; // one per SUGGEST_WARNING_CODES
  export function describeError(e: unknown): { msg: Msg; values?: Values; detail?: string; problems?: string[] };
  //   ApiError with a known code → its Msg (values from details: count, name); unknown code → ERROR_MESSAGES.unknown + detail = e.message;
  //   status 403 (any code) → the admin-only Msg "Only administrators can import."; TypeError → offline; details.problems → problems
  export function describeWarning(w: { code: string; count?: number; fields?: string[] }): { msg: Msg; values: Values };
  // run-driver.ts (Ruling 14)
  export const RETRY_DELAYS_MS: readonly number[]; // [1000, 3000, 9000]
  export const LEASE_WAIT_MS = 2000; export const IDLE_WAIT_MS = 500;
  export type DriveEvent =
  	| { kind: "progress"; job: Job } | { kind: "waiting"; job: Job } | { kind: "retrying"; attempt: number; error: unknown }
  	| { kind: "stopped"; job: Job } | { kind: "error"; error: unknown };
  export async function driveJob(o: { id: string; next(id: string): Promise<Job>; sleep(ms: number, signal: AbortSignal): Promise<void>; signal: AbortSignal; onEvent(e: DriveEvent): void }): Promise<void>;
  export function useJobDriver(id: string | null, next: (i: { id: string }) => Promise<Job>): { // callers pass Task 2's api.next
  	job: Job | null; phase: "idle" | "driving" | "waiting" | "retrying" | "stopped" | "error"; error: unknown;
  	recordsPerSecond: number | null; start(): void; stop(): void; // start() after resume/retry; stop() on pause/cancel/unmount
  };
  ```
  `WIZARD_ERROR_CODES`, with one sentence each (the codes the wizard's routes and EmDash can answer; verify each with `grep -rn '"<CODE>"' src` before writing it):
  - EmDash: `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_REJECTED`, `VALIDATION_ERROR`, `INVALID_PLUGIN_REQUEST`, `NOT_FOUND`, `INTERNAL_ERROR`.
  - Upload route: `UNSUPPORTED_SOURCE`, `TOO_LARGE`, `LENGTH_REQUIRED`, `EMPTY_BODY`, `NOT_CONFIGURED`.
  - Sources: `INVALID_FORMAT`, `INVALID_SOURCE`, `UPLOAD_NOT_FOUND`, `NO_SOURCE_KEYS`, `SOURCE_NOT_FOUND`, `CREDENTIAL_MISSING`, `CREDENTIALS_UNAVAILABLE`, `URL_BLOCKED`, `FETCH_FAILED`, `HTTP_ERROR`, `TOO_MANY_REDIRECTS`, `CONFLICT`.
  - Templates: `NAME_TAKEN`, `INVALID_TEMPLATE`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_CHANGED`, `TEMPLATE_TOO_LARGE`, `COLLECTION_NOT_FOUND`, `COLLECTION_MISMATCH`, `INVALID_CURSOR`.
  - Jobs: `INVALID_OPTIONS`, `INVALID_TRANSITION`, `LOG_TOO_LARGE`.

  `SUGGEST_WARNING_CODES`: the M6d spec's warnings table (`2026-11-19-flux-import-m6d-ai-mapping-design.md`, "Errors and warnings"):
  - `ai_not_configured`, `ai_key_unavailable`, `ai_url_blocked`, `ai_payload_too_large`, `ai_rate_limited`, `ai_timeout`;
  - `ai_auth_failed`, `ai_billing`, `ai_provider_rate_limited`, `ai_provider_rejected`, `ai_provider_error`, `ai_refused`, `ai_truncated`, `ai_invalid_output`;
  - `ai_unknown_field`, `ai_duplicate_field`, `ai_unknown_key`, `ai_duplicate_key`, `ai_option_dropped`, `ai_draft_invalid`;
  - `sample_trimmed`, `keys_not_matched`, `keys_not_sent`, `fields_not_sent`;
  - `required_unmapped`, `reference_not_suggested`, `fields_not_eligible`, `date_format_ambiguous`, `number_format_ambiguous`;
  - `key_guessed`, `key_not_unique_in_sample`, `no_field_matched`, `sample_empty`.

  Sentences are plain words, never provider text. Use `{count}` and `{fields}` (comma-joined) where the warning carries them.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-errors.test.ts`:
```ts
it("has a sentence for every code the wizard can meet", () => {
	for (const c of WIZARD_ERROR_CODES) expect(ERROR_MESSAGES[c]?.message).toMatch(/\.$/);
	for (const c of SUGGEST_WARNING_CODES) expect(WARNING_MESSAGES[c]?.message).toMatch(/\.$/);
});
it("says 'Only administrators can import.' for any 403", () =>
	expect(describeError(new ApiError("FORBIDDEN", "Insufficient permissions", 403)).msg.message).toBe("Only administrators can import."));
it("shows the route's message for an unknown code", …);   // detail === e.message
it("lists INVALID_TEMPLATE problems", …);
it("fills {count} and {fields} from a warning", …);
it("calls the network offline, not unknown", …);           // new TypeError("Failed to fetch")
```
`tests/unit/admin-driver.test.ts` (fake `next` script, `sleep` records its delays and resolves at once):
```ts
it("drives until completed and reports each step's progress", …);          // running → running → completed: 3 calls, events progress, progress, stopped
it.each(["paused", "cancelled", "failed"])("stops on %s", …);
it("stops without another call once aborted", …);
it("waits LEASE_WAIT_MS while another holder's lease is live, then drives on (Review Focus 1)", …);  // same cursor + lease → waiting; sleep(2000); then progress
it("waits IDLE_WAIT_MS after a reply with no progress and no lease", …);
it("retries TypeError, 429 and 503 after 1000, 3000 and 9000 ms, then reports the error", …);
it("does not retry a 4xx: reports 403 and 409 at once (Review Focus 2)", …);
it("resets the retry count after a success", …);
```

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run tests/unit/admin-errors.test.ts tests/unit/admin-driver.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`useJobDriver` wraps `driveJob` with the `next` it is given, an `AbortController` per start, a `setTimeout`-based `sleep` and `useEffect` cleanup (abort on unmount). It computes `recordsPerSecond` from the counter-sum delta over wall time between progress events (`null` until two exist). Nothing here imports `api.ts`, which Task 2 writes in the same wave.

- [ ] **Step 4: See them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/errors.ts packages/flux-import/src/admin/run-driver.ts packages/flux-import/tests/unit/admin-errors.test.ts packages/flux-import/tests/unit/admin-driver.test.ts
git commit -m "Add the wizard's error and warning sentences and the jobs/next driver"
```

### Task 5: The wizard shell

**Files:**
- Create: `src/admin/wizard/Wizard.tsx`, `src/admin/wizard/StepBar.tsx`, `src/admin/wizard/messages.ts`
- Test: `tests/admin/wizard.test.tsx`

**Interfaces:**
- Consumes: Task 3's `WizardProvider`, `useWizard`, `STEPS`, `reachable`, `readUrl`, `writeUrl`; Task 2's `useCredentials`; Task 4's `describeError`; Task 1's `useT`.
- Produces:
  ```ts
  export type StepComponents = Readonly<Record<StepId, ComponentType>>;
  export function Wizard(props: { steps: StepComponents }): JSX.Element;
  export function useUnloadGuard(active: boolean): void; // beforeunload preventDefault while active
  ```
  Behaviour:
  - On mount: `useCredentials()` (the access probe, Ruling 17). Its loading state is a Kumo `Loader`. A 403 renders only the administrators-only state; any other failure shows `describeError` with "Try again".
  - `?job=<id>` → `jobReopened`. `?step=` shows that step only when `reachable`; otherwise it shows Source and rewrites the URL.
  - The `<h1>` reads "Import". The step heading is an `<h2 tabIndex={-1}>`, focused on every step change.
  - The `StepBar` is `<ol>` → `<li><a href="?step=…" aria-current="step"?>`. Unreachable steps are `aria-disabled` and not links.
  - `useUnloadGuard(state.dirty && state.run === null)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the administrators-only state when the access probe answers 403 (Review Focus 2)", async () => {
	mockRoutes({ "credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
	renderAdmin(<Wizard steps={DUMMY} />);
	expect(await screen.findByText("Only administrators can import.")).toBeVisible();
	expect(screen.queryByRole("list", { name: /steps/i })).toBeNull();
});
it("renders six steps as a list of links with aria-current=step on the current one", …);
it("moves focus to the step heading on a step change and mirrors ?step= in the URL", …);  // history.replaceState spy keeps history.state
it("reopens ?job=<id> on the Run step", …);
it("falls back to Source for an unreachable ?step=", …);
it("warns before unload while a draft is dirty and not after Run starts", …);  // dispatch a beforeunload Event; defaultPrevented
```

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run --project admin tests/admin/wizard.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the shell as above**

- [ ] **Step 4: See them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/Wizard.tsx packages/flux-import/src/admin/wizard/StepBar.tsx packages/flux-import/src/admin/wizard/messages.ts packages/flux-import/tests/admin/wizard.test.tsx
git commit -m "Add the wizard shell: step bar, URL state, focus, unload guard and the administrators-only state"
```

### Task 6: Source

**Files:**
- Create: `src/admin/wizard/source/{SourceStep.tsx,UploadTab.tsx,UrlTab.tsx,PasteTab.tsx,SavedSourceTab.tsx,SourceSettings.tsx,SamplePreview.tsx,TemplatePicker.tsx,messages.ts}`
- Test: `tests/admin/source.test.tsx`

**Interfaces:**
- Consumes: Task 2's `api.uploadFile`, `api.paste`, `api.createSource`, `api.fetchSource`, `api.sample`, `api.getTemplate`, `useCredentials`, `useAllSources`, `useAllTemplates`; Task 3's `useWizard`, `sampleColumns`, `StepFooter`; Task 4's `describeError`; Task 1's `PASTE_MAX_BYTES`, `SOURCE_FORMATS`.
- Produces: `export function SourceStep(): JSX.Element`.
  - **Tabs:** Upload file, From URL, Paste, Saved source (Kumo `Tabs`).
  - **Upload:** a file input accepting `.csv,.json,.jsonl,.ndjson,.xml,.xlsx`, with a `Meter` showing progress.
  - **From URL:** a name derived from the URL host and path (editable), the URL, and a credential select from `useCredentials`. Then `createSource` → `fetchSource`. A 409 `CONFLICT` offers "Use the saved source" (Fact D7).
  - **Paste:** a format select without XLSX, and a byte counter. Over `PASTE_MAX_BYTES`, Next is disabled with the reason.
  - **Saved source:** a list → `fetchSource { id }`.
  - **Format:** detected from the extension (`.ndjson` and `.jsonl` → `jsonl`) and overridable. **Settings** (`SourceSettings`): `records` for JSON and XML, with the syntax hint "dot-separated keys, e.g. data.products" or "element names from the root, e.g. feed/item"; `sheet` and `headerRow` for XLSX; `filter` (JSONata) for every format.
  - **Sample:** `sample { uploadId, n: 5, source }` → `sampleColumns` → `sourceReady`. A settings change re-samples (`sourceBlockChanged`).
  - **Saved template:** `TemplatePicker` (`useAllTemplates()`) → `getTemplate` → `templateLoaded`.
  - A link to EmDash's WordPress importer.
  - **Next** is enabled when `columns` has at least one key.

- [ ] **Step 1: Write the failing tests**

```ts
it("uploads a file with its name, the CSRF header and progress, then samples it", …);  // fake XHR; calls: upload then sources/sample { uploadId, n: 5, source: { format: "csv" } }
it("refuses a .txt file before sending it", …);
it("creates and fetches a URL source, then samples the fetched upload", …);  // createSource { name, url, credential? } → fetchSource { id } → sample { uploadId }
it("offers the saved source when the name is taken (CONFLICT 409)", …);
it("does not offer XLSX for Paste and disables Next past 1 MiB of UTF-8", …);
it("shows sheet and header row for XLSX, records path for JSON and XML", …);
it("re-samples when the records path changes", …);
it("blocks Next with an empty state when the sample has no records (Review Focus 3)", async () => {
	mockRoutes({ upload: …, "sources/sample": () => ({ records: [], paths: [] }) });
	// …upload "empty.json"
	expect(await screen.findByText(/no records/i)).toBeVisible();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});
it("shows INVALID_SOURCE and NO_SOURCE_KEYS as their sentences, inline", …);
it("loads a saved template and opens Preview", …);  // templates/get → state.step === "preview", target and rows filled
it("never shows the upload ID", …);  // the uploadId string is absent from the document
it("shows empty states for no saved sources and no saved templates, and a Loader while each list loads", …);
```

- [ ] **Step 2: See them fail**

Run: `pnpm exec vitest run --project admin tests/admin/source.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/source packages/flux-import/tests/admin/source.test.tsx
git commit -m "Add the wizard's Source step: upload, URL, paste, saved source, sample and saved template"
```

### Task 7: Target

**Files:**
- Create: `src/admin/wizard/target/{TargetStep.tsx,messages.ts}`
- Test: `tests/admin/target.test.tsx`

**Interfaces:**
- Consumes: Task 2's `useSite`, `useFields`; Task 3's `useWizard`, `StepFooter`; Task 4's `describeError`.
- Produces: `export function TargetStep(): JSX.Element`.
  - A collection `Select` (label, plus "(hidden)" for hidden collections).
  - A locale `Select`, defaulting to `SiteInfo.defaultLocale`. With one locale it is shown as text.
  - "These records translate entries in": a checkbox and a locale select, offered only when the locale is not the default. It sets `translationLocale`; the key column of the original is mapped in Map's `translationOf` row.
  - Fields are prefetched with `useFields(collection)`.
  - Next dispatches `targetChosen` and moves to `map`.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists the manifest's collections and preselects the default locale", …);
it("shows one locale as text on a single-locale site", …);       // manifest without i18n
it("offers 'translate entries in' only for a non-default locale", …);
it("shows the empty state when the site has no collections", …);
it("shows a schema read error as a sentence with Try again", …);  // GET collection → 500
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/target.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/target packages/flux-import/tests/admin/target.test.tsx
git commit -m "Add the wizard's Target step: collection, locale and translation locale"
```

### Task 8: The Map detail panel and the key picker

**Files:**
- Create: `src/admin/wizard/map/detail/{DetailPanel.tsx,KeyPicker.tsx,settings.tsx,messages.ts}`
- Test: `tests/admin/detail.test.tsx`

**Interfaces:**
- Consumes: Task 3's `RowId`, `RowMapping`, `RowMeta`; Task 1's `SchemaField`, `TaxonomyInfo`, `SampleColumn`, `COMPATIBLE`, `MappingType`, `KEYS_SHOWN`, `useT`.
- Produces:
  ```ts
  export interface DetailRow { id: RowId; label: string; kind: "key" | "slug" | "field" | "taxonomy" | "bylines" | "publishAt" | "translationOf"; field?: SchemaField; taxonomy?: TaxonomyInfo }
  export function DetailPanel(p: { row: DetailRow; mapping: RowMapping | undefined; meta: RowMeta | undefined; columns: readonly SampleColumn[]; onChange(m: RowMapping | null): void }): JSX.Element;
  export function KeyPicker(p: { columns: readonly SampleColumn[]; value: string | null; onPick(key: string): void; label: string }): JSX.Element; // Kumo Combobox; filter by substring, case-insensitive; no row cap while filtering
  ```
  The panel shows:
  - the key picker (the keyboard path, the same effect as a drop: `{ ...mapping, from: key }` without `expr`);
  - a "Source key / Expression" switch, where an expression replaces the key (`{ expr }`, never both);
  - for fields, the mapping type among those whose `COMPATIBLE` list holds `field.type`, defaulting to the first.

  Settings per type, exactly the template grammar (`engine/template.ts:132-282`):
  - `number`: `decimal` and `thousands`, which must differ.
  - `date`: `format`, `tz` (default "UTC", or "site") and `output`.
  - `boolean`: `true`/`false` token lists.
  - `select` and `multiSelect`: `map` (source value → option, with option choices from `field.options`) and `ignoreCase`; plus `separator` for `multiSelect`.
  - `json`: `parse`. `reference`: `match` (id, slug, key) and `separator`. `image`: `alt` (key or expression) and `refresh`. `file`: `refresh`.
  - `portableText`: `format` (html, markdown, text; required), `baseUrl`, `images`, `imageErrors` and `unknownMarkup`.
  - Taxonomy rows: `match` (slug, label), `separator`, `hierarchy` and `create`. Bylines: `match` (slug, name) and `separator`. `publishAt`: `format` and `tz`.

  Then the raw sample values of the chosen key (up to 5) with the line "Converted values show in Preview" (Ruling 6), and the suggestion's rationale with its origin and confidence. Inputs not set by the user are omitted from the mapping, not written as `undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
it("maps a key without dragging: pick with the keyboard, Enter sets from", …);   // user.keyboard("{ArrowDown}{Enter}"); onChange({ type: "text", from: "Name" })
it("finds a key past the first 200 by typing (Review Focus 4)", …);             // 1,000 columns; type "key-999" → one option
it("switches to Expression and drops from", …);                                  // onChange({ type: "text", expr: "$uppercase(Name)" })
it("offers only mapping types compatible with the field type", …);               // datetime → date; string → text, date, slug
it("writes date format and tz, and number decimal and thousands", …);
it("refuses thousands equal to decimal with a message", …);
it("maps select values onto the field's options", …);
it("writes portableText format, required", …);
it("shows raw sample values and says conversions show in Preview", …);
it("shows the rationale with 'AI · high' as text", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/detail.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/map/detail packages/flux-import/tests/admin/detail.test.tsx
git commit -m "Add the Map detail panel: key picker, expression switch and type settings"
```

### Task 9: Proposed fields and the schema-diff dialog

**Files:**
- Create: `src/admin/wizard/map/new-fields/{NewFields.tsx,SchemaDiffDialog.tsx,infer.ts,messages.ts}`
- Test: `tests/unit/admin-infer.test.ts`, `tests/admin/new-fields.test.tsx`

**Interfaces:**
- Consumes: Task 2's `api.applySchema`; Task 3's `ProposedField`; Task 4's `describeError`; Task 1's `APPLY_FIELD_TYPES`, `MAX_APPLY_FIELDS`, `SampleColumn`.
- Produces:
  ```ts
  export function inferFieldType(values: readonly unknown[]): string; // non-empty values only: all integers → "integer"; all numbers → "number"; all true/false/yes/no/1/0 → "boolean"; all ISO 8601 or dd/MM/yyyy dates → "datetime"; all http(s) URLs → "url"; any over 200 characters → "text"; else "string"; none → "string"
  export function proposeField(column: SampleColumn, taken: readonly string[]): ProposedField; // slug: lower-case, runs outside [a-z0-9] → "_", trimmed, "f_" prefix when not starting with a letter, max 63, "_2", "_3"… when taken; label from the key; translatable true, searchable false
  export function NewFields(p: { fields: readonly ProposedField[]; onChange(slug: string, patch: Partial<ProposedField>): void; onRemove(slug: string): void }): JSX.Element; // the type select offers APPLY_FIELD_TYPES
  export function SchemaDiffDialog(p: { collection: string; fields: readonly ProposedField[]; open: boolean; onApplied(slugs: string[]): void; onCancel(): void }): JSX.Element;
  ```
  The dialog:
  - On open, it calls `applySchema { collection, fields: [{ slug, type, label, translatable, searchable }], dryRun: true }` and lists each change (create, conflict with its message, unchanged).
  - Confirm is disabled while any change is a conflict. Confirm sends the same body with `dryRun: false`, then calls `onApplied(result.applied)`. A non-null `result.error` is shown, and the dialog stays open.
  - Cancel writes nothing. Over `MAX_APPLY_FIELDS` the dialog says so and does not call.

- [ ] **Step 1: Write the failing tests**

`tests/unit/admin-infer.test.ts`: a table of value lists → types (including `["01/03/2026"]` → `datetime`, `["9.5", "10"]` → `number`, `["1", "0"]` → `boolean`, `[]` → `string`); slugs (`"Released"` → `released`, `"2nd price"` → `f_2nd_price`, taken → `_2`).
`tests/admin/new-fields.test.tsx`:
```ts
it("plans with dryRun true on open and lists the changes", …);       // exact body
it("disables Confirm while a change is a conflict", …);
it("applies with dryRun false on Confirm and reports the applied slugs", …);
it("shows result.error and stays open", …);
it("writes nothing on Cancel", …);                                    // calls: only the dryRun:true one
it("lets the user change a proposed field's type among APPLY_FIELD_TYPES", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run tests/unit/admin-infer.test.ts && pnpm exec vitest run --project admin tests/admin/new-fields.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same commands. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/map/new-fields packages/flux-import/tests/unit/admin-infer.test.ts packages/flux-import/tests/admin/new-fields.test.tsx
git commit -m "Add proposed fields and the confirmed schema diff"
```

### Task 10: Options

**Files:**
- Create: `src/admin/wizard/options/{OptionsStep.tsx,owner.ts,messages.ts}`
- Test: `tests/admin/options.test.tsx`

**Interfaces:**
- Consumes: Task 2's `api.updateTemplate`, `useAllTemplates`; Task 3's `useWizard`, `Options`, `toTemplate`, `isEdited`, `deriveOwner`, `ownerOf`, `StepFooter`; Task 4's `describeError`; Task 1's `OWNER_PATTERN`, `TEMPLATE_NAME_MAX`, `BATCH_SIZE_MAX`, `MAX_UPDATE_FIELDS`.
- Produces:
  ```ts
  export function ownerClash(owner: string, locale: string, others: readonly TemplateSummary[], selfId: string | null): TemplateSummary | null; // owner.ts
  export function OptionsStep(): JSX.Element;
  ```
  Controls, each with one line of help:
  - **Records:** create and update / create only / update only. "Update only these fields": a multi-select of mapped fields, at most `MAX_UPDATE_FIELDS`. "Never overwrite fields edited in the admin".
  - **Status:** Publish / Draft / Schedule. Schedule offers "The same date for every record" (Kumo `DatePicker` with a time) or "A date from the feed" (a key picker, with the date `format` and `tz` inputs) (Coordinator's call 4).
  - **Missing from the feed:** leave / unpublish / trash, plus the stop threshold (%, 0-100, default 25). Enabled only with "Save as template" or a base template (Coordinator's call 1). Without one, the reason reads "Saved templates only: a one-off run has nothing to find missing".
  - **Save as template:** off by default. Name checked against `useAllTemplates()` as typed; a clash shows "A template with this name exists". Length ≤ `TEMPLATE_NAME_MAX`.
  - **Base template edited** (`isEdited`): the three choices of Coordinator's call 3, default "Run with these changes without saving them". "Save the changes to <name>" runs `templates/update { id, revision, template }` on Next (Ruling 13), then `templateSaved`, and keeps `check.warnings` for Preview.
  - **Advanced** (a Kumo `Collapsible`): the owner, derived and editable, validated by `OWNER_PATTERN`, with the clash warning. The batch size (1-`BATCH_SIZE_MAX`, empty = the engine's).
  - Journal: not offered; always `journal: true` (spec).

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the derived owner under Advanced and follows the template name as it is typed", …);
it("warns when another template of the collection and locale has the same owner", …);
it("offers Missing only with Save as template", …);
it("writes rules.mode, updateFields and protectEdited into the draft", …);           // toTemplate(state, owner).rules
it("writes Schedule as a fixed expr with tz site, or as a feed key with format", …);
it("checks the template name against the saved ones as it is typed", …);
it("defaults an edited base template to running without saving", …);
it("saves the changes to the template on Next and keeps its warnings", …);            // templates/update { id, revision, template }; TEMPLATE_CHANGED → sentence, stays on Options
it("refuses an owner outside OWNER_PATTERN", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/options.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/options packages/flux-import/tests/admin/options.test.tsx
git commit -m "Add the wizard's Options step: record rules, status, missing entries, owner and saving"
```

### Task 11: Preview

**Files:**
- Create: `src/admin/wizard/preview/{PreviewStep.tsx,RecordsTable.tsx,messages.ts}`
- Test: `tests/admin/preview.test.tsx`

**Interfaces:**
- Consumes: Task 2's `api.createJob`, `api.records`, `api.next`; Task 3's `useWizard`, `jobInput`; Task 4's `useJobDriver`, `describeError`.
- Produces:
  ```ts
  export function PreviewStep(): JSX.Element;
  export function RecordsTable(p: { jobId: string }): JSX.Element; // jobs/records paged by cursor (Pagination), filter: All, Would change (planned), Failed, Conflicts, Locked, Filtered, Missing (removed)
  ```
  Behaviour:
  - On entry without `state.dryRun`: `createJob(jobInput(state, true))` → `dryRunStarted`, then drive with `useJobDriver(id, api.next)`. The progress is indeterminate, with counters.
  - On `completed`: `dryRunFinished { total }`, where total is the sum of `created`, `updated`, `unchanged`, `locked`, `conflict`, `failed` and `filtered`.
  - Show the counts per action (Create, Update, Unchanged, Failed, Conflict, Locked, Filtered, and "Missing → <action>" from `removed`) and the records table. A row shows its source key, action, changes (`field: before → after`, values cut to 120 characters) and errors in plain words (`field`: message).
  - Template warnings from Options sit above the counts.
  - `INVALID_TEMPLATE` shows its problems with "Back to Map".
  - "Back to Map" keeps the mapping. "Run import" → `stepChanged("run")`. It is disabled while driving or when the total is 0.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates a dry run from the draft with journal true and drives it to completion", …);  // body: { uploadId, dryRun: true, template: {…rules.owner…}, publish: true, journal: true }
it("creates the dry run from the saved template by id and revision when unedited", …);
it("shows counts and a records table with changes and errors in plain words", …);         // Fact D5 rows
it("filters records by status and pages with the cursor", …);
it("shows No records and disables Run for a dry run with zero records (Review Focus 3)", …);
it("shows INVALID_TEMPLATE problems with Back to Map", …);                                 // Fact D6 problem text
it("discards the dry run when the user goes back and changes the mapping", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/preview.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/preview packages/flux-import/tests/admin/preview.test.tsx
git commit -m "Add the wizard's Preview step: the dry run, its counts and its records"
```

### Task 12: Run

**Files:**
- Create: `src/admin/wizard/run/{RunStep.tsx,messages.ts}`
- Test: `tests/admin/run.test.tsx`

**Interfaces:**
- Consumes: Task 2's `api.createJob`, `api.createTemplate`, `api.getJob`, `api.next`, `api.pause`, `api.resume`, `api.cancel`, `api.retry`, `downloadLog`; Task 3's `useWizard`, `jobInput`, `toTemplate`, `ownerOf`, `writeUrl`; Task 4's `useJobDriver`, `describeError`.
- Produces: `export function RunStep(): JSX.Element`.
  - **Start:** without `state.run`, when `options.save` is `new`: `createTemplate { name, template: toTemplate(state, ownerOf(state)) }` first, then `templateSaved`, and the job runs from the returned ID and revision (Ruling 13). Then `createJob(jobInput(state, false))` → `runStarted`, `writeUrl({ job })`, drive with `useJobDriver(id, api.next)`.
  - **Reopened** (`?job=`): `getJob` then drive. The total is unknown, so the bar is indeterminate (Coordinator's call 5).
  - Always shown: counters and records per second. With a known total (the dry run's), a determinate `Meter` and the time left.
  - While the driver is `waiting`: "Waiting for the previous batch to finish". While `retrying`: "Connection lost; retrying (n of 3)".
  - **Controls:** Pause (`jobs/pause`, then stop driving), Resume (`jobs/resume`, then start), Cancel (a confirming `Dialog`, then `jobs/cancel`), Download log (all, or failed only).
  - The line "Leaving this page pauses nothing: the import stays open and you can come back to it at this address."
  - **On `completed`:** a summary of counts, Download log, a link to `/_emdash/admin/content/<collection>`, and "Retry failed records" (`jobs/retry`, then start) when `failed` > 0. A dry-run job reopened by URL shows its counts and no Retry.
  - **On `failed`:** `job.error.message`, and Resume. **On a driver error:** the sentence and "Try again", which restarts the driver.

- [ ] **Step 1: Write the failing tests**

```ts
it("runs exactly the previewed upload: jobs/create with the dry run's uploadId, not a sourceId", …);  // Coordinator's call 2
it("saves a new template first and runs from its id and revision", …);
it("puts ?job=<id> in the URL and shows a determinate bar from the dry run's total", …);
it("reopens ?job= with a live lease: waits, then counts (Review Focus 1)", …);  // next: same cursor + lease ×2, then progress; "Waiting for the previous batch" visible; no error
it("shows an indeterminate bar for a reopened job", …);
it("pauses, resumes and cancels with confirmation", …);                         // calls in order; cancel needs the dialog's confirm
it("downloads the failed-records log through apiFetch", …);                     // GET log.csv with status=failed and the header
it("offers Retry failed records after completion with failures", …);
it("shows the error and Try again after the driver gives up", …);              // fake timers; 503 ×4
it("stops driving and shows the administrators-only sentence on a 403", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/run.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/run packages/flux-import/tests/admin/run.test.tsx
git commit -m "Add the wizard's Run step: driven progress, pause, resume, cancel, log and retry"
```

### Task 13: The `flux_source_id` field widget (gated by plan Ruling 1)

Plan Ruling 1 was answered yes: run this task in its wave.

**Files:**
- Create: `src/admin/fields/SourceIdField.tsx`, `tests/admin/source-id-field.test.tsx`
- Modify: `src/emdash/schema.ts` (`ensureSourceIdField`, `SchemaRegistryLike`), `tests/unit/schema.test.ts`

**Interfaces:**
- Consumes: Task 1's `useT`.
- Produces:
  - `export const SOURCE_ID_WIDGET = "source-id"` and `export function SourceIdField(p: { value: unknown; onChange(v: unknown): void; label: string; id: string }): JSX.Element`. It shows the label and a collapsed disclosure ("Import ID") that reveals the value as read-only text. It never calls `onChange`.
  - In `src/emdash/schema.ts`, the widget name `"flux-import:source-id"` is set on create. An existing field with `widget` null or undefined gets it through `updateField`; any other widget is left alone.
  - `SchemaRegistryLike.getField` returns `widget?: string | null`, and `createField`/`updateField` inputs gain `widget?: string`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/schema.test.ts`:
```ts
it("creates flux_source_id with the flux-import:source-id widget", …);
it("sets the widget on an existing field that has none, with indexed in the same update", …);
it("leaves a widget someone else set", …);
```
`tests/admin/source-id-field.test.tsx`: it renders the label and a collapsed control; expanding shows the value read-only; there is no editable textbox; `onChange` is never called.

- [ ] **Step 2: See them fail** — `pnpm exec vitest run tests/unit/schema.test.ts && pnpm exec vitest run --project admin tests/admin/source-id-field.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces** (Task 15 adds `fields: { [SOURCE_ID_WIDGET]: SourceIdField }` to `index.tsx`).

- [ ] **Step 4: See them pass** — same commands, plus `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/e2e.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/fields packages/flux-import/src/emdash/schema.ts packages/flux-import/tests/unit/schema.test.ts packages/flux-import/tests/admin/source-id-field.test.tsx
git commit -m "Show flux_source_id read-only and collapsed through a field widget"
```

### Task 14: The Map step

**Files:**
- Create: `src/admin/wizard/map/{MapStep.tsx,KeysPane.tsx,FieldsPane.tsx,useSuggestions.ts,messages.ts}`
- Test: `tests/admin/map.test.tsx`

**Interfaces:**
- Consumes: Task 8's `DetailPanel`, `DetailRow`; Task 9's `NewFields`, `SchemaDiffDialog`, `proposeField`; Task 2's `api.suggest`, `useFields`, `useSite`; Task 3's `useWizard`, `mapBlockers`, `mappable`, `StepFooter`; Task 4's `describeWarning`, `describeError`; Task 1's `KEYS_SHOWN`.
- Produces: `export function MapStep(): JSX.Element` and `export function useSuggestions(): { ask(overwrite: boolean): Promise<void>; status; reply }`.

  **Layout:** three panes in a `grid gap-4 md:grid-cols-3` (Ruling 9).

  **Keys pane** (`KeysPane`):
  - One draggable row per column (`useDraggable({ id: "key:" + key })`) with one sample value.
  - Used keys are dimmed (`opacity-50`) but still draggable.
  - A filter `Input`. At most `KEYS_SHOWN` rows, with "Showing {shown} of {total} keys".
  - Long names are truncated, with `title` and accessible text holding the full name.

  **Fields pane** (`FieldsPane`), with rows in this order:
  - Key and Slug; one row per field from `useFields`; one per taxonomy assigned to the collection (`SiteInfo.taxonomies`); Bylines; `publishAt` (only with status Schedule from the feed; otherwise hidden); `translationOf` (only with a translation locale).
  - Each row is a drop target (`useDroppable({ id: row })`) and a button that selects it for the detail panel.
  - A row shows the label, a required mark, the type, the mapped key as a chip with a remove button ("Remove <key> from <field>"), and the badge.
  - An unmappable row (`!mappable`) is disabled, is no drop target, and shows its reason.
  - Last row: "+ Add a new field", a drop target that calls `proposeField` and dispatches `fieldProposed`.

  **@dnd-kit:** `DndContext` with `PointerSensor` and `KeyboardSensor`, and screen-reader `announcements` built from messages (picked up, over <field>, dropped on <field>, cancelled).

  **Suggestions** (`useSuggestions`):
  - On entry, when `rows` is empty and the suggestion is idle: `api.suggest({ collection, locale, uploadId, source })` → `suggestionReceived`.
  - The status line: "AI (<provider>) · {filled} filled, {check} to check" when `method === "ai"`; "Name matching" otherwise; plus "AI unavailable" when `ai.available` is false and a provider was expected.
  - Warnings show as a dismissible `Banner` of sentences (`describeWarning`).
  - "Ask again": when the user has set any row, a confirm `Dialog` asks whether to replace their choices. No → `overwriteUserRows: false`; Yes → `true`.

  **Next:** `mapBlockers` shows each blocker by its row. With proposed fields, `SchemaDiffDialog` opens first. On applied: `fieldsApplied`, the `useFields` query is invalidated, and the proposed rows are mapped to their new fields. Then `stepChanged("options")`.

- [ ] **Step 1: Write the failing tests**

```ts
it("asks for suggestions on entry with collection, locale, uploadId and source, and no ai flag", …);
it("fills rows with badges: 'AI · high', 'Name · medium', 'check'", …);
it("shows the method and counts in the status line, and warnings as sentences", …);
it("maps by dragging a key onto a field with the keyboard sensor", async () => {
	const restore = withRects({ "key:Name": new DOMRect(0, 0, 100, 20), "field:title": new DOMRect(0, 50, 100, 20) });
	screen.getByRole("button", { name: /Name/ }).focus();
	await user.keyboard(" {ArrowDown}{ArrowDown} ");
	expect(within(row("title")).getByText("Name")).toBeVisible();
	restore();
});
it("maps by picking a key in the detail panel without dragging", …);
it("dims used keys but still lets one key feed a second field", …);
it("never overwrites a hand-set row on Ask again unless confirmed", …);
it("caps the Keys pane at 200 rows with a filter, and finds the 1,000th key (Review Focus 4)", …);
it("disables an unmappable field and blocks Next when it is required (Review Focus 5)", …);  // a "blocks" field required; drop does nothing; Next disabled with the sentence
it("blocks Next while the key is unmapped", …);
it("opens the schema diff before leaving when fields are proposed, then refetches fields", …);
it("shows taxonomy rows for the collection's taxonomies only", …);
```

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/map.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement as in Interfaces**

- [ ] **Step 4: See them pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`
```bash
git add packages/flux-import/src/admin/wizard/map/MapStep.tsx packages/flux-import/src/admin/wizard/map/KeysPane.tsx packages/flux-import/src/admin/wizard/map/FieldsPane.tsx packages/flux-import/src/admin/wizard/map/useSuggestions.ts packages/flux-import/src/admin/wizard/map/messages.ts packages/flux-import/tests/admin/map.test.tsx
git commit -m "Add the wizard's Map step: keys, fields, drag and drop, suggestions and validation"
```

### Task 15: Assembly and whole-wizard flows

**Files:**
- Modify: `src/admin/index.tsx`, `tests/admin/index.test.tsx`
- Create: `tests/admin/flow.test.tsx`

**Interfaces:**
- Consumes: every step component; Task 5's `Wizard`; Task 13's `SourceIdField` if it ran.
- Produces: `ImportPage = () => <Wizard steps={{ source: SourceStep, target: TargetStep, map: MapStep, options: OptionsStep, preview: PreviewStep, run: RunStep }} />`, `pages: { "/import": ImportPage }`, and `fields: { "source-id": SourceIdField }` only if Task 13 ran.

- [ ] **Step 1: Write the failing tests**

`tests/admin/flow.test.tsx` (all routes mocked; one `mockRoutes` table per flow):
```ts
it("imports a CSV from upload to a completed run with one new field", …);
// upload → sample → Target posts/en → suggest → map Released to a proposed `released` field
// → schema diff dry run + apply → Options default → Preview (dry run 10 records) → Run
// → completed; the call order is asserted
it("starts from a saved template, runs it unedited by id and revision", …);
it("runs an edited saved template inline by default", …);
it("clears the mapping when the collection changes, and the dry run when an option changes", …);
it("never sends a request without X-EmDash-Request", …);  // the harness's own check over the whole flow
```
`tests/admin/index.test.tsx`: `pages["/import"]` renders the wizard's Source step heading; `fields` is exported exactly when Task 13 ran.

- [ ] **Step 2: See them fail** — `pnpm exec vitest run --project admin tests/admin/flow.test.tsx tests/admin/index.test.tsx`. Expected: FAIL (the stub page).

- [ ] **Step 3: Wire `index.tsx`**

- [ ] **Step 4: See them pass**, then run the whole suite: `pnpm format && pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS, with the boundary test still green over the full graph.

- [ ] **Step 5: Commit**

```bash
git add packages/flux-import/src/admin/index.tsx packages/flux-import/tests/admin/index.test.tsx packages/flux-import/tests/admin/flow.test.tsx
git commit -m "Wire the six wizard steps into the Import page"
```

### Task 16: Polish, acceptance, the review note and the roadmap

**Files:**
- Create: `docs/superpowers/notes/2026-11-23-m7a-review.md`
- Modify: `docs/superpowers/specs/2026-11-23-flux-import-m7a-admin-wizard-design.md` (amendments, open issues), `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md` (row 7 and a "Milestone 7 split" section), and any `src/admin/**` file the polish pass fixes (with its tests)
- Temporarily (never committed): scripts in `.superpowers/wt/scratch-m7a-review/`, a scratch database, and screenshots under `.superpowers/wt/scratch-m7a-review/shots/`

**Interfaces:**
- Consumes: everything above.
- Produces: the review note, with the acceptance run and screenshots; the spec's amendments for plan Rulings 1-17; the roadmap rows.

- [ ] **Step 1: The design critique and polish pass**

Invoke the `impeccable:impeccable` skill on the built screens: critique, then polish, in the admin's light and dark themes, at 1280 px and 768 px. Use Step 3's running site and headless Chromium for screenshots (Fact D12).
- Check hierarchy, spacing and Kumo consistency with the admin's own screens. Check the empty, loading and error states, the copy (plain words, one sentence per error), WCAG AA contrast and text size, focus order and visible focus.
- Fix each finding in its own small commit, with the owning task's tests updated (`pnpm format && pnpm typecheck && pnpm lint && pnpm test` before each).
- Findings not fixed go to the note's "Design findings" with the reason.
- The polish may not add a dependency, a route, or a class outside the admin's CSS (Task 1's test).

- [ ] **Step 2: Every suite**

Run (repo root): `pnpm format && pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: PASS: 114 node files and 12 happy-dom files (13 with Task 13), every integration and parity test. Record the counts, the run times and any flake (Facts F1, F3) in the note's "Checks". `translations.test.ts` and `retention.test.ts` may need a rerun alone (F3).

- [ ] **Step 3: The manual end-to-end acceptance run (spec "Success")**

Set-up:
- `.superpowers/wt/scratch-m7a-review/` holds a script, bundled with esbuild as in the M6d review. It starts `FakeAiServer` (`tests/integration/fake-ai.ts`), with `fake.reply` set to pair `posts`' fields with the products keys (same shape as `FAKE_REPLY`), and a `FeedServer` (`tests/integration/feed-server.ts`) serving `productsJson(10)` (`tests/fixtures/formats.ts`). Both on free ports.
- Start `sites/dev` with `pnpm dev` (or `pnpm exec astro dev --port <free>`) with `FLUX_DEV_ALLOW_PRIVATE_NETWORK=1`, a scratch `FLUX_DEV_DB` and `FLUX_DEV_UPLOADS`. Never ports 4392, 4396 or 4397.
- Set the plugin settings through `PUT /_emdash/api/admin/plugins/flux-import/settings`, with a dev-bypass PAT held in memory: `aiProvider: "openai-compatible"`, `aiBaseUrl: <fake>/v1`, `aiModel: "local-model"`, and a random `aiApiKey` (as `tests/integration/suggest.test.ts:15-40`). Clear them all at the end.
- Open the admin in headless Chromium through `setup/dev-bypass?redirect=/_emdash/admin/plugins/flux-import/import` (Fact D12), and press "Get Started" on the welcome dialog (Fact D11).

Then, as an Administrator who never touches the API, with a screenshot of each step:
1. Upload `productsCsv(10)` (written to a file) → Target `posts`, `en`. AI suggestions appear with badges and the status line "AI (OpenAI-compatible) · …".
2. Map `sku` to Key and `Handle` to Slug. Map `Released` to a new field `released` (datetime) through "+ Add a new field", and confirm the schema diff. Map the date with format `dd/MM/yyyy`. One mapping is done with the keyboard picker only.
3. Options: defaults. Advanced shows the owner `wizard-posts-en`. Preview shows 10 creates with their changes and no `flux_source_id` change (a dry run creates no field).
4. Run. Pause, check that the counters stop, Resume, let it complete, and download the log (all, then failed only).
5. A second import: From URL (the feed server), records path empty, `price.currency` → the `tag` taxonomy with create on. Preview, then Run to completion.
6. Reload `/import?job=<id>` during a run (start a third, larger run with `productsCsv(500)`): it shows "Waiting for the previous batch to finish" and then continues (Review Focus 1).
7. Open the Map step and the Run screen on `sites/dev-cf` (`pnpm exec astro dev` there, on a free port) and screenshot them.

Record each step, its screenshot path (kept outside git, in the scratch folder), and anything that did not behave as the spec says. Record the network requests of one page load: one URL each for Kumo, Lingui, React Query and @dnd-kit (Fact V2). Stop every server (`pnpm exec astro dev stop`), clear the settings, restore `sites/dev/emdash-env.d.ts` and `sites/dev-cf/emdash-env.d.ts` with `git checkout --` if changed, and remove the scratch folder. `git status` shows only the intended files.

- [ ] **Step 4: The review note**

Create `docs/superpowers/notes/2026-11-23-m7a-review.md`, structured as the M6d note:
````markdown
# M7a review: the import wizard in the EmDash admin

Branch `m7a-admin-wizard`, plan `docs/superpowers/plans/2026-11-23-flux-import-m7a-admin-wizard.md`,
spec `docs/superpowers/specs/2026-11-23-flux-import-m7a-admin-wizard-design.md`.

Date: … · Commit: `…` · Node: v22.23.1 · EmDash 1.2.0 · Kumo 2.6.0

## Checks
(the six commands, counts, run times, flakes)

## Facts V1-V9
(each fact's result from the plan's Task 0 table, and whether the acceptance run confirmed it)

## Review Focus
(the plan's five items, each with the test that answers it and what the acceptance run showed)

## The acceptance run
(Step 3, step by step, with screenshot names)

## Design findings
(Step 1: fixed, with commits; not fixed, with reasons)

## Rulings
(plan Rulings 1-17, each with what the code does now; Ruling 1 with the coordinator's answer)

## Deviations from the plan
(anything the implementation changed, with the reason)

## Open issues
(the spec's, carried forward; the M6 carry-overs relevant to M7b: jobs/list returns whole rows, the transfer fence, unfinished agent dry runs; plus anything new, and the flux_source_id widget if Ruling 1 was declined)
````
Fill every section from the runs; leave no placeholder.

- [ ] **Step 5: The spec's amendments and the roadmap**

In the spec, add an "Amendments from the plan and review" list, one line each naming the plan ruling or fact:
- messages per module and `useT` (Ruling 2, Fact V5);
- error codes read from the envelope (Ruling 3, Fact D1);
- the log downloaded through `apiFetch` (Ruling 4, Fact D2);
- the schema read from the manifest and schema API (Ruling 5, Fact V1);
- raw samples in the panel (Ruling 6, Fact V4);
- every source an upload ID (Ruling 7);
- mirrored constants (Ruling 8);
- admin CSS classes only (Ruling 9, Fact D3);
- routes mocked under `apiFetch` (Ruling 11);
- template-save timing (Ruling 13);
- driver policy (Ruling 14);
- owner derivation (Ruling 15);
- the fixed schedule date (Ruling 16);
- the access probe (Ruling 17);
- Ruling 1's outcome.

Add the review's open issues to "Open issues".

In the roadmap:
- Row 7's milestone cell becomes "React admin wizard (split into M7a–M7b, see [Milestone 7 split](#milestone-7-split))".
- Add a "Milestone 7 split" section, modelled on the M6 split: one paragraph on the split (spec "Decided by the user", Scope B), and a table with M7a's row (link to the spec, what shipped in the M6d row's style, last cell `Done ([review](../notes/2026-11-23-m7a-review.md))`) and M7b's row ("The Imports home: Jobs, Templates, Sources and Schedules tabs and a New import button; rollback and scheduling from the admin", last cell `Next`).

- [ ] **Step 6: Commit**

Run (repo root): `pnpm format && pnpm lint`, then `git status`: only the note, the spec, the roadmap and any polish files already committed in Step 1.
```bash
git add docs/superpowers/notes/2026-11-23-m7a-review.md docs/superpowers/specs/2026-11-23-flux-import-m7a-admin-wizard-design.md docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md
git commit -m "Add the Milestone 7a review results, amend the spec and mark M7a done in the roadmap"
```

## After this plan

M7a is done when Task 16's commit is in and the tree is clean. Open the pull request into `claude/adoring-hawking-y7zfj2`, with the summary of the note's Checks, Rulings and acceptance run, and its test plan (the six commands and the manual run). No attribution trailer. Next is M7b, the Imports home.
