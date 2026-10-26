# Flux Import M3c: URL sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import from saved URL sources (recurring supplier and partner feeds) with every upload guarantee (bounded memory, exact byte-offset resume, idempotent batches, crash repair), plus credentials kept encrypted, an SSRF guard, and re-runs skipped when the feed has not changed. M3c triggers runs by hand; M6 adds cron on the same pieces.

**Architecture:** Download, then import. `src/sources/net.ts` is the SSRF guard: it parses a source URL (http or https, no userinfo, at most 2,048 characters), blocks internal hostnames and non-public IP literals, resolves every other host (`node:dns` `lookup(…, { all: true })` on Node, DNS over HTTPS on Workers) and blocks any non-public answer, then GETs with `redirect: "manual"`, re-checking each of at most five hops and dropping the credential header once a hop leaves the original origin. `src/sources/fetcher.ts` sends `If-None-Match`/`If-Modified-Since` from the last fetch, enforces the 15 s header and 120 s download timeouts and `maxSourceBytes`, and streams the body into the existing upload store through `stageUpload` (which hashes it); on Workers a body of unknown length, or a compressed one, is buffered up to 32 MiB first because R2 needs the length. A `304`, or a body whose SHA-256 equals the last one, is an unchanged *fetch* while the previous staged file still exists (no new copy is staged); whether `jobs/create { sourceId }` skips is decided separately against `lastImport`, the content of the last real (not dry-run) job created from the source. `src/plugin/credentials.ts` keeps named credentials as one JSON object in a declared `secret` plugin setting, which EmDash encrypts; `src/plugin/sources.ts` stores sources in a new `sources` plugin storage collection, saves each fetch as `lastFetch` or `lastError`, records `lastImport` when a real job is created from a fetch, and builds `jobs/create { sourceId }` on top of the unchanged `startJob`. Each source's latest staged file is kept by the job release path and by the daily purge. Nothing in the engine changes.

**Tech Stack:** Node 22 (`.nvmrc` 22.23.1), pnpm 10 workspace, TypeScript 5.9 strict ESM, Vitest 4, `astro/zod` (routes), Biome 2, EmDash 1.2.0, Astro 7.3; workerd parity through `@astrojs/cloudflare` 14 and Wrangler 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-26-flux-import-m3c-url-sources-design.md` (all sections). Roadmap: `docs/superpowers/specs/2026-10-07-flux-import-roadmap-design.md`. Previous plan: `docs/superpowers/plans/2026-10-14-flux-import-m3b-selection-transforms.md`; its review: `docs/superpowers/notes/2026-10-14-m3b-review.md`.

Every code block in Tasks 1 to 6 was written, type-checked, linted and run while this plan was drafted (unit suite, the Node integration suite and the new workerd parity test on its own), then replayed task by task from `7e1d97c`'s tree plus the design commit; results are in "Verification while drafting". EmDash line numbers below refer to `node_modules/emdash/src/` in EmDash 1.2.0.

## Global Constraints

- Plugin ID `flux-import`. Package exports stay `fluxImport()`, `fluxImportRoutes()`, `createPlugin()`; `FluxImportRoutesOptions` gains `allowPrivateNetwork`.
- Node `>=22.16`. Run `nvm use` (reads `.nvmrc`) before any command; in agent shells prefix every command with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` (the default node is v16).
- In this shell `cat` is an alias for `cat -n`. Write files with the editor tools only, never `cat >`, `cat >>` or heredocs through `cat`.
- TypeScript strict ESM with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `import type` for types; `.js` extensions on internal imports. Plugin route input schemas import `z` from `"astro/zod"`.
- EmDash APIs only as documented or as read in `node_modules/emdash` (cited by file and line). No raw SQL in plugin code: sources and credentials go through plugin storage and `ctx.settings`.
- Fetch with the runtime's own `fetch()` (not `ctx.http.fetch()`, whose 8 MiB buffered limit is below the 50 MiB source limit). No new capability; the capability comment says why.
- Every outbound request of a fetch goes through `guardedFetch` (scheme, userinfo, hostname, literal and resolved-address checks on every hop). The DNS-over-HTTPS lookup itself goes to the fixed `https://cloudflare-dns.com/dns-query`.
- `allowPrivateNetwork` is honoured only when `import.meta.env.DEV` is true; scheme, userinfo and length checks apply whatever its value.
- Credential values never appear in a route response, an error message, `lastError`, a log line or a test snapshot; routes return `{ name, header }` only.
- Error codes, exactly: `URL_BLOCKED`, `CREDENTIAL_MISSING`, `FETCH_FAILED`, `HTTP_ERROR`, `TOO_MANY_REDIRECTS`, `TOO_LARGE`, `LENGTH_REQUIRED`, `NOT_FOUND`, `CONFLICT`, plus `CREDENTIALS_UNAVAILABLE` (encryption key missing or malformed) and EmDash's own `VALIDATION_ERROR` for bad input.
- Limits are fixed in code: 15 s to response headers, 120 s per download, five redirects, 32 MiB Workers buffer; the size limit is `maxSourceBytes` (default 50 MiB).
- The template's `source.format` decides parsing; `Content-Type` is ignored. GET only.
- Commits are signed through the configured 1Password SSH signer (`commit.gpgsign=true`). If signing fails, stop and report; never pass `--no-gpg-sign`. Commit messages end at the body: no `Co-Authored-By` or other AI attribution, anywhere.
- Done means `pnpm typecheck && pnpm lint && pnpm test` pass from the repo root; Task 5 also passes `pnpm test:integration` (about 7 minutes) and Task 6 the targeted workerd test (about 35 s); Task 7 runs everything, `pnpm test:cf` included (about 18 minutes).

## Review Focus

1. A host that resolves to a private address, or a redirect to one (the cloud metadata address above all), must never be connected to — tests in Task 1 ("blocks a host that resolves to a private address before connecting", "checks every redirect target and blocks one that points to a private host") and Task 5 ("refuses a loopback URL with URL_BLOCKED").
2. A credential must not follow a redirect to another origin and must never come back out: not in a route result, an error or the database's plaintext — tests in Task 1 ("keeps the credential on same-origin hops and drops it for good once the origin changes"), Task 3 ("never echoes a credential value in a validation error") and Task 5 ("imports a feed through a bearer credential that no route returns", which reads the stored setting and finds an encrypted envelope).
3. "Unchanged" must never point a job at a staged file that is gone: without the previous file the fetch is unconditional and always changed — test in Task 2 ("fetches in full when the previous upload is gone, even if the body is the same").
4. A finished job must not delete its source's latest staged file, or every re-run becomes a full download and import — tests in Task 4 ("keeps a file that a URL source still names as its latest fetch") and Task 5 ("skips a re-run when the server answers 304, keeping the staged file").
5. On Workers a body of unknown length, or a compressed one (its `Content-Length` is the compressed size), must be buffered with a hard cap rather than streamed into R2 under a wrong length — tests in Task 2 ("buffers a compressed body, whose Content-Length is not its length", "fails with LENGTH_REQUIRED past the buffer limit and stages nothing") and Task 6 (the chunked workerd import).

## Facts this plan relies on

Found while writing this plan, on Node v22.23.1, EmDash 1.2.0 and local workerd (Wrangler 4, `compatibility_date` 2026-02-24, `nodejs_compat`); tasks cite them by number.

| # | Fact | Evidence |
| --- | --- | --- |
| S1 | For a native plugin, `ctx.settings.set`, `compareAndSet` and `getVersioned` on a key declared `type: "secret"` in `admin.settingsSchema` encrypt and decrypt: the options row `plugin:flux-import:settings:credentials` holds `{"$emdash":"plugin-setting","v":1,"kid":…,"iv":…,"ciphertext":…}` and `getVersioned` returns the JSON text. `createContext` passes `plugin.admin.settingsSchema` to `createSettingsAccess`. Verified on `sites/dev` (SQLite) and `sites/dev-cf` (D1). | `plugins/context.ts:1683-1689`, `plugins/settings.ts:231-310`; probe route while drafting |
| S2 | Without `EMDASH_ENCRYPTION_KEY`, writing a secret setting throws `PluginSettingEncryptionError` code `PLUGIN_SETTING_ENCRYPTION_KEY_MISSING` ("Plugin secret settings require EMDASH_ENCRYPTION_KEY"); reading an absent setting returns `null`. The key is read only from `process.env` (`config/secrets.ts:540-570`); `astro dev` copies it from the site's `.env` only when unset (`astro/integration/dev-env.ts`). This checkout's `sites/dev/.env` has a key, but it is gitignored, so fresh clones and worktrees have none; `sites/dev-cf` has none (`.dev.vars` is gitignored and absent). Under workerd a `.dev.vars` entry reaches `process.env`. | probe on both sites, with and without the key |
| S3 | A declared secret field appears on the admin plugin settings page: GET reports only `secretsSet.credentials`, PUT accepts any string or `null`. An administrator can therefore overwrite the JSON with other text. | `api/handlers/plugin-settings.ts:59-75`, `:167-260`; admin settings GET while drafting |
| S4 | `ctx.settings` has `getVersioned` and `compareAndSet`; `compareAndSet(key, null, v)` creates only when absent and returns `{ applied: false }` on a lost race. | `plugins/types.ts:351-363`, `database/repositories/options.ts:114-139` |
| S5 | EmDash answers invalid plugin route input with `VALIDATION_ERROR` and `details: z.formatError(error)`, which carries messages, not input values. | `plugins/routes.ts:244-257` |
| W1 | Node's `fetch` (undici) and local workerd both decode a gzip body and keep the original `Content-Length` (9,690 for 29,789 decoded bytes); a chunked response has no `Content-Length`; `redirect: "manual"` returns the `302` with its `Location`. Node sends `accept-encoding: gzip, deflate`; local workerd sends none. | probe route fetching a local server on both sites |
| W2 | On Workers `stageUpload` needs a declared length (R2 through `FixedLengthStream`) and throws `LengthRequiredError` without one. | `src/emdash/uploads.ts` (`stageUpload`) |
| W3 | Under workerd `node:dns/promises` imports (`nodejs_compat`) but `lookup` fails with `ENOTFOUND` even for `localhost`; `fetch("https://cloudflare-dns.com/dns-query?…", { accept: application/dns-json })` answers. On Node `lookup(…, { all: true })` works inside a plugin route. | probe route on both sites |
| W4 | `AbortSignal.any` and `AbortSignal.timeout` exist on Node 22 and on workerd (the Task 6 parity test uses both). Local workerd fetches `http://127.0.0.1:<port>` served by the test process. | Task 6 run |
| A1 | A Vite `define` from `fluxImportRoutes()` reaches plugin route modules too (not only the injected upload route), and `import.meta.env.DEV` is `true` under `astro dev` on both sites. The package needs `/// <reference types="astro/client" />` for `import.meta.env` to type-check (TS2339 otherwise). In Vitest the define is absent, so `allowPrivateNetwork()` is `false`. | probe route; `tsc` while drafting |
| A2 | `URL` normalises IPv4 forms before any check: `http://2130706433/`, `http://0x7f.1/`, `http://0177.0.0.1/` and `http://127.1/` all have the host `127.0.0.1`; `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`. | `net.test.ts` |
| F1 | On this WSL2 machine the wall clock sometimes steps back about 5.4 s while the integration servers restart. When that happens during `crash.test.ts` (CSV), a `jobs/next` in flight is not cut off by the kill and the test's precondition throws. Reproduced on the code before this plan (1 of 4 CSV-only runs, with the same message) and on this plan's code with the old `server.ts`. | instrumented runs while drafting |
| A3 | `Storage` has `exists(key)`; plugin storage queries may filter and sort only on declared index fields, so the latest staged files are found by paging through `sources` (no index on `lastFetch.uploadId`). | `storage/types.ts:207-210`, `plugins/storage-query.ts:113-137` |

## Rulings this plan makes

- **Facts that differ from the spec.** (1) Node also keeps a compressed body's `Content-Length` (W1), so the length is ignored whenever `Content-Encoding` is set, on Node too, and the early `TOO_LARGE` check applies only to an unencoded length. (2) The `credentials` secret is visible (write-only) on the admin settings page (S3); text there that is not the credentials JSON reads as "no credentials", and the field's description says so. (3) Development sites need `EMDASH_ENCRYPTION_KEY` (S2): the Node integration server gets a random key per test process; the workerd parity test uses no credential, so `sites/dev-cf` needs none.
- **Address rules.** IPv4: exactly the spec's ranges. IPv6: only global unicast `2000::/3` is public, minus Teredo `2001::/32`, documentation `2001:db8::/32` and 6to4 `2002::/16` (which embeds IPv4); `::/96`, `::ffff:0:0/96` and NAT64 `64:ff9b::/96` are judged by their embedded IPv4 (so `::` and `::1` fall in `0.0.0.0/8`). This covers every spec range. An answer that does not parse as an address (a zone ID, a name) blocks the request.
- **Hostname rules.** Blocked: `localhost`, `metadata`, `metadata.google`, `metadata.google.internal`, `instance-data`, and any name ending in `.localhost`, `.local`, `.internal` or `.home.arpa`, compared lower-case without trailing dots.
- **`allowPrivateNetwork` skips hostname and address checks** (so `localhost` works in tests); scheme, userinfo and length checks always apply.
- **When checks run.** `sources/create` and `sources/update` check the URL without DNS (`URL_BLOCKED`, 400) and store `URL.href`; every fetch checks again with DNS. DNS failure or no addresses is `FETCH_FAILED`; any non-public address is `URL_BLOCKED`.
- **Redirects.** 301, 302, 303, 307 and 308 with a `Location` are followed (relative locations resolved against the current URL); any other status, `304` included, is the response. Redirect bodies are cancelled. Once a hop changes origin (scheme, host or port) the credential header is removed for the rest of the chain, even if a later hop returns. The conditional headers are kept on every hop.
- **Timeouts.** One 15 s budget covers DNS, redirects and the final response's headers; 120 s covers the whole fetch. Both end as `FETCH_FAILED` ("No response within 15 s", "The download did not finish within 120 s"), and a partial staged file is deleted.
- **`304`.** Unchanged only when conditional headers were sent (a previous staged file exists and no `force`); otherwise it is `HTTP_ERROR`. Validators that come with a `304` replace the stored ones.
- **Unchanged by hash** keeps the old `uploadId` and updates `at`, `status` and the validators; the new copy is deleted.
- **Workers buffering.** A body without a usable length is read into memory up to `min(maxSourceBytes, 32 MiB)`: past `maxSourceBytes` it is `TOO_LARGE`, else past 32 MiB `LENGTH_REQUIRED`. A body with a usable length streams through `FixedLengthStream`.
- **An empty 2xx body is staged** like any other; job creation reports the empty source as it does for uploads.
- **HTTP statuses.** `URL_BLOCKED` 400, `NOT_FOUND` 404, `CONFLICT` 409, `CREDENTIAL_MISSING` 409, `TOO_LARGE` 413, `FETCH_FAILED`/`HTTP_ERROR`/`TOO_MANY_REDIRECTS`/`LENGTH_REQUIRED` 502 (an upstream problem, not the caller's request), `CREDENTIALS_UNAVAILABLE` 500.
- **Credential rules beyond the spec.** Header names are HTTP tokens of at most 100 characters; besides the spec's list, `Keep-Alive`, `Proxy-Connection`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Upgrade`, `If-None-Match` and `If-Modified-Since` are refused (the last two are the fetcher's). Values are printable ASCII and tab (stricter than "no CR or LF", so no runtime header error can quote a value). Setting and deleting use `compareAndSet` (five attempts, then `CONFLICT`). A missing or malformed key gives `CREDENTIALS_UNAVAILABLE` with EmDash's message, which never contains the value.
- **Unknown credentials.** `sources/create` and `sources/update` naming a credential that does not exist answer `NOT_FOUND`; a fetch whose credential was deleted later is `CREDENTIAL_MISSING`.
- **`sources/update`.** Changing the URL or the credential (to a different value, or `null`) clears `lastFetch` and `lastError`; the former latest file is no longer kept and expires under retention. `updatedAt` moves on create and update only, not on fetch. Names are unique by exact match; two concurrent creates of one name are not prevented (plugin storage has no unique index).
- **Concurrency.** A fetch saves its result with `compareAndSet` on the row it read. A concurrent rename or fetch only moves the revision, so the save is retried on the newer row (last fetch wins; a file left unreferenced is purged by retention). A source deleted or given another URL or credential during the fetch is left alone: the new file is deleted and the fetch answers `CONFLICT`.
- **File lifecycle.** A changed fetch deletes the previous latest file unless a job may still read it. `sources/delete` deletes the latest file under the same rule. A finished or cancelled job keeps its file when a source names it as latest (`UploadKeeper`), and the daily purge skips every source's latest file (`keepUploads`).
- **`lastError`** is saved for every coded failure of a fetch (the spec's codes and `CREDENTIALS_UNAVAILABLE`); an unexpected error (storage down) answers 500 and is not saved.
- **`jobs/create` skips against the last import, not the last fetch** (controller ruling). Exactly one of `uploadId` and `sourceId`; `force` with `uploadId` is ignored. With `sourceId` the fetch runs as `sources/fetch` does (conditional GET and hash decide whether a new copy is staged; `sources/fetch` keeps reporting `changed` against `lastFetch`). The job is skipped (`{ skipped: "unchanged" }`) only when there is no `force`, the job is not a dry run, and the fetched SHA-256 equals `lastImport.sha256`. `lastImport { sha256, uploadId, jobId, at }` is written (compare-and-set, best effort, not over a source deleted or reconfigured meanwhile) only after a real job is created; dry runs are never skipped and never write it, and a failed creation writes nothing, so a real run after a dry run, and a retry after a failed creation, need no `force`. Changing the URL or credential clears `lastImport` too. `lastImport.uploadId` gets no retention protection of its own: its file stays while a job uses it or while it is also `lastFetch`'s.
- **Listing.** `sources/list` pages newest first, 50 per page, like `jobs/list`; `credentials/list` takes `{}` and sorts by name.

## Verification while drafting

Run on Node v22.23.1, EmDash 1.2.0, with the code below in place:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors (flux-import, `sites/dev`, `sites/dev-cf`) |
| `pnpm lint` | clean (97 files; the one Biome info about `recommended` is unchanged) |
| `pnpm test` | 31 files / 765 tests pass (27 files / 603 tests before this plan) in about 16 s |
| Task-by-task replay | A clean worktree at the design commit, with each task's steps applied in order by a script that copies these code blocks and applies these replacements (each must match exactly once): every Step 2 failed exactly as written, and after each task `pnpm typecheck`, `pnpm lint` and `pnpm test` passed with the counts in its passing-run step; the result was byte-identical to the prototype |
| `pnpm test:integration` | 8 files / 42 tests passed in 416 s (was 7 files / 34 tests) before the `lastImport` ruling; after it, `url-sources.test.ts` was re-run on its own: 9 tests pass in about 13 s with its server start (the full suite, now 43 tests, was not repeated). An earlier run failed `crash.test.ts` (CSV) with "Only 1 of 2 kills cut off a jobs/next call in flight"; the same failure reproduced on the unchanged code (1 of 4 runs, Fact F1), so it is not caused by this plan |
| `vitest run --config vitest.cf.config.ts -t "URL feed"` | the new parity test passes (2.3 s test, 31 s with server start), also after the `lastImport` ruling; the rest of `pnpm test:cf` was not re-run |
| Probes (Facts S1-S3, W1, W3, A1) | a temporary `probe/run` route and a local HTTP server on both sites; removed |

## File map

| File | Responsibility |
| --- | --- |
| `src/sources/net.ts` (new) | SSRF guard: URL rules, hostname and address tables, resolvers (Node, DNS over HTTPS), `guardedFetch` with manual redirects and credential stripping, `UrlSourceError` |
| `src/astro/config.ts`, `src/astro/integration.ts`, `src/astro/env.d.ts` | `allowPrivateNetwork` option, its define and the DEV-only reader; `import.meta.env` types |
| `src/sources/fetcher.ts` (new) | `downloadSource`: conditional GET, timeouts, size limit, staging (Workers buffering), change detection |
| `src/emdash/uploads.ts` | `UploadStorage` gains `exists`; `EmDashUploads.exists` |
| `src/plugin/credentials.ts` (new) | Credentials in the `credentials` secret setting: set, delete, list, get; validation constants |
| `src/plugin/sources.ts` (new) | `SourceRow`, CRUD, `fetchSource` (`lastFetch`/`lastError`), `jobFromSource` (skip against `lastImport`, record it after a real job), `latestSourceUploads` |
| `src/plugin/service.ts` | `uploadInUse`, `UploadKeeper` on the release path, exported `page` |
| `src/plugin/retention.ts` | `keepUploads` |
| `src/plugin/routes.ts` | `credentials/*`, `sources/*` routes; `jobs/create` with `sourceId`/`force`; the keeper on `jobs/next` and transitions |
| `src/plugin/definition.ts` | `sources` storage, `credentials` secret setting, capability comment, purge keeps latest files |
| `tests/integration/feed-server.ts` (new), `tests/integration/server.ts`, `sites/dev/astro.config.mjs`, `sites/dev-cf/astro.config.mjs` | Local feed server; test key and `allowPrivateNetwork` for test servers |

`src/engine/**` and the readers under `src/sources/` other than the two new files do not change.

---

### Task 1: SSRF guard and `allowPrivateNetwork`

**Files:**
- Create: `packages/flux-import/src/sources/net.ts`
- Modify: `packages/flux-import/src/astro/config.ts`, `packages/flux-import/src/astro/integration.ts`, `packages/flux-import/src/astro/env.d.ts`
- Test: `packages/flux-import/tests/unit/net.test.ts` (new), `packages/flux-import/tests/unit/integration.test.ts`

**Interfaces:**
- Consumes: `onWorkers()` (`src/emdash/workers.ts`); `node:dns/promises` `lookup(host, { all: true, verbatim: true })` (W3); WHATWG `URL` normalisation (A2); Vite `define` and `import.meta.env.DEV` (A1).
- Produces (`src/sources/net.ts`):
  - `const MAX_REDIRECTS = 5`, `const URL_MAX_LENGTH = 2048`
  - `type UrlSourceErrorCode = "URL_BLOCKED" | "FETCH_FAILED" | "HTTP_ERROR" | "TOO_MANY_REDIRECTS" | "TOO_LARGE" | "LENGTH_REQUIRED"`; `class UrlSourceError extends Error { readonly code: UrlSourceErrorCode }`
  - `type Resolver = (hostname: string) => Promise<string[]>`; `interface NetOptions { resolver: Resolver; allowPrivateNetwork: boolean; fetch: typeof globalThis.fetch }`
  - `parseSourceUrl(text: string): URL`; `hostOf(url: URL): string`; `isBlockedHostname(host: string): boolean`; `isPublicAddress(text: string): boolean | null` (`null`: not an address); `checkHost(url: URL, allowPrivateNetwork: boolean): void`
  - `whenAborted(signal: AbortSignal): Promise<never>`; `fetchError(e: unknown, signal: AbortSignal, context: string): UrlSourceError`
  - `interface GuardedRequest { headers: Headers; credentialHeader?: string; signal: AbortSignal }`; `guardedFetch(start: string, request: GuardedRequest, net: NetOptions): Promise<Response>`
  - `nodeResolver: Resolver`; `dohResolver(fetchFn?: typeof globalThis.fetch): Resolver`; `defaultResolver(): Resolver`
- Produces (`src/astro/config.ts`): `allowPrivateNetwork(requested?: boolean, dev?: boolean): boolean`; (`src/astro/integration.ts`) `FluxImportRoutesOptions.allowPrivateNetwork?: boolean` and the define `__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__`.

Why first: every later request goes through `guardedFetch`, and Review Focus 1 and 2 live here.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/net.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { allowPrivateNetwork } from "../../src/astro/config.js";
import {
	checkHost,
	dohResolver,
	guardedFetch,
	isBlockedHostname,
	isPublicAddress,
	MAX_REDIRECTS,
	type NetOptions,
	nodeResolver,
	parseSourceUrl,
	type Resolver,
	URL_MAX_LENGTH,
	UrlSourceError,
} from "../../src/sources/net.js";

interface Sent {
	url: string;
	headers: Record<string, string>;
	redirect: RequestRedirect | undefined;
}

/** A fetch that answers from `routes` by URL and records every request. */
function fakeNet(
	routes: Record<string, () => Response>,
	resolver: Resolver = async () => ["93.184.215.14"],
	allowPrivate = false,
) {
	const sent: Sent[] = [];
	const resolved: string[] = [];
	const net: NetOptions = {
		allowPrivateNetwork: allowPrivate,
		resolver: async (host) => {
			resolved.push(host);
			return resolver(host);
		},
		fetch: async (input, init) => {
			const url = String(input);
			sent.push({
				url,
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				redirect: init?.redirect,
			});
			const answer = routes[url];
			if (!answer) throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
			return answer();
		},
	};
	return { net, sent, resolved };
}

const redirect =
	(location: string, status = 302) =>
	() =>
		new Response("moved", { status, headers: { location } });
const ok =
	(body = "a,b\n1,2\n") =>
	() =>
		new Response(body, { status: 200 });

function request(headers: Record<string, string> = {}, credentialHeader?: string) {
	return {
		headers: new Headers(headers),
		signal: new AbortController().signal,
		...(credentialHeader === undefined ? {} : { credentialHeader }),
	};
}

async function failure(promise: Promise<unknown>): Promise<UrlSourceError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(UrlSourceError);
	return error as UrlSourceError;
}

describe("parseSourceUrl", () => {
	it("accepts http and https URLs", () => {
		expect(parseSourceUrl("https://feeds.example.com/a.csv?x=1").href).toBe(
			"https://feeds.example.com/a.csv?x=1",
		);
		expect(parseSourceUrl("http://example.com").href).toBe("http://example.com/");
	});

	it.each([
		["ftp://example.com/a.csv", 'The URL scheme "ftp:" is not allowed; use http or https'],
		["file:///etc/passwd", 'The URL scheme "file:" is not allowed; use http or https'],
		["data:text/csv,a", 'The URL scheme "data:" is not allowed; use http or https'],
		["https://user@example.com/", "URLs cannot contain a user name or password; use a credential"],
		["https://:pw@example.com/", "URLs cannot contain a user name or password; use a credential"],
		["not a url", "The URL is not valid"],
		[`https://example.com/${"a".repeat(URL_MAX_LENGTH)}`, "URLs are limited to 2048 characters"],
	])("rejects %s", (text, message) => {
		expect(() => parseSourceUrl(text)).toThrow(new UrlSourceError("URL_BLOCKED", message));
	});
});

describe("isPublicAddress", () => {
	it.each([
		"0.0.0.0",
		"0.255.255.255",
		"10.0.0.1",
		"10.255.255.255",
		"100.64.0.1",
		"100.127.255.255",
		"127.0.0.1",
		"127.255.255.254",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.8",
		"192.168.1.1",
		"198.18.0.1",
		"198.19.255.255",
		"224.0.0.1",
		"239.255.255.250",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"febf::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:10.1.2.3",
		"::ffff:a9fe:a9fe",
		"::127.0.0.1",
		"64:ff9b::10.0.0.1",
		"64:ff9b::a00:1",
		"64:ff9b::7f00:1",
		"2001::1",
		"2001:db8::1",
		"2002:7f00:1::1",
	])("blocks %s", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"93.184.215.14",
		"100.63.255.255",
		"100.128.0.0",
		"172.15.255.255",
		"172.32.0.0",
		"192.0.1.1",
		"198.17.255.255",
		"198.20.0.0",
		"223.255.255.255",
		"2606:4700:4700::1111",
		"2a00:1450:4001:80b::200e",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
	])("allows %s", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});

	it.each([
		"example.com",
		"1.2.3",
		"1.2.3.4.5",
		"01.2.3.4",
		"256.1.1.1",
		"1::2::3",
		"fe80::1%eth0",
		"12345::",
		"1:2:3:4:5:6:7:8:9",
	])("does not read %s as an address", (text) => {
		expect(isPublicAddress(text)).toBeNull();
	});
});

describe("checkHost", () => {
	it.each([
		"http://localhost/",
		"http://LOCALHOST./feed",
		"http://api.localhost/",
		"http://printer.local/",
		"http://db.internal/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://metadata/",
		"http://nas.home.arpa/",
	])("blocks the host of %s", (text) => {
		expect(() => checkHost(new URL(text), false)).toThrow(UrlSourceError);
	});

	it.each([
		["http://2130706433/", "127.0.0.1"],
		["http://0x7f.1/", "127.0.0.1"],
		["http://0177.0.0.1/", "127.0.0.1"],
		["http://127.1/", "127.0.0.1"],
		["http://0xa9fea9fe/", "169.254.169.254"],
		["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
		["http://[64:ff9b::10.0.0.1]/", "64:ff9b::a00:1"],
		["http://[::1]:8080/", "::1"],
	])("blocks %s, which URL normalises to %s", (text, host) => {
		expect(() => checkHost(new URL(text), false)).toThrow(
			new UrlSourceError("URL_BLOCKED", `The address ${host} is not public`),
		);
	});

	it("allows public hosts and addresses, and anything when private networks are allowed", () => {
		for (const text of ["https://example.com/", "http://8.8.8.8/", "http://[2606:4700::1]/"]) {
			expect(() => checkHost(new URL(text), false)).not.toThrow();
		}
		for (const text of ["http://localhost/", "http://127.0.0.1:4000/", "http://[::1]/"]) {
			expect(() => checkHost(new URL(text), true)).not.toThrow();
		}
		expect(isBlockedHostname("localhost.example.com")).toBe(false);
		expect(isBlockedHostname("internal.example.com")).toBe(false);
	});
});

describe("guardedFetch", () => {
	it("resolves the host, then fetches with manual redirects", async () => {
		const { net, sent, resolved } = fakeNet({ "https://feeds.example.com/a.csv": ok() });
		const response = await guardedFetch("https://feeds.example.com/a.csv", request(), net);
		expect(await response.text()).toBe("a,b\n1,2\n");
		expect(resolved).toEqual(["feeds.example.com"]);
		expect(sent).toEqual([
			{ url: "https://feeds.example.com/a.csv", headers: {}, redirect: "manual" },
		]);
	});

	it("blocks a host that resolves to a private address before connecting", async () => {
		const { net, sent } = fakeNet({}, async () => ["93.184.215.14", "10.0.0.5"]);
		const error = await failure(guardedFetch("https://evil.example.com/", request(), net));
		expect(error).toMatchObject({
			code: "URL_BLOCKED",
			message: "evil.example.com resolves to an address that is not public",
		});
		expect(sent).toEqual([]);
	});

	it("fails with FETCH_FAILED when DNS fails or gives no address", async () => {
		const down = fakeNet({}, async () => {
			throw new Error("getaddrinfo ENOTFOUND nowhere.example");
		});
		expect(await failure(guardedFetch("https://nowhere.example/", request(), down.net))).toEqual(
			new UrlSourceError(
				"FETCH_FAILED",
				"Could not resolve nowhere.example: getaddrinfo ENOTFOUND nowhere.example",
			),
		);
		const empty = fakeNet({}, async () => []);
		expect(await failure(guardedFetch("https://empty.example/", request(), empty.net))).toEqual(
			new UrlSourceError("FETCH_FAILED", "empty.example has no addresses"),
		);
	});

	it("fails with FETCH_FAILED when the connection fails, naming the host only", async () => {
		const { net } = fakeNet({});
		expect(
			await failure(guardedFetch("https://down.example/feed?key=SECRET", request(), net)),
		).toEqual(
			new UrlSourceError(
				"FETCH_FAILED",
				"Could not fetch from down.example: fetch failed: ECONNREFUSED",
			),
		);
	});

	it("checks every redirect target and blocks one that points to a private host", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/feed": redirect("http://169.254.169.254/latest/meta-data/"),
		});
		expect(await failure(guardedFetch("https://a.example/feed", request(), net))).toEqual(
			new UrlSourceError("URL_BLOCKED", "The address 169.254.169.254 is not public"),
		);
		expect(sent.map((s) => s.url)).toEqual(["https://a.example/feed"]);
	});

	it("blocks a redirect to another scheme or to a URL with a user name", async () => {
		const ftp = fakeNet({ "https://a.example/": redirect("ftp://a.example/x") });
		expect((await failure(guardedFetch("https://a.example/", request(), ftp.net))).code).toBe(
			"URL_BLOCKED",
		);
		const user = fakeNet({ "https://a.example/": redirect("https://u:p@b.example/") });
		expect((await failure(guardedFetch("https://a.example/", request(), user.net))).code).toBe(
			"URL_BLOCKED",
		);
	});

	it("keeps the credential on same-origin hops and drops it for good once the origin changes", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/1": redirect("/2", 301),
			"https://a.example/2": redirect("https://b.example/3", 307),
			"https://b.example/3": redirect("https://a.example/4", 308),
			"https://a.example/4": ok(),
		});
		const response = await guardedFetch(
			"https://a.example/1",
			request({ "x-api-key": "k1", "if-none-match": '"v1"' }, "x-api-key"),
			net,
		);
		expect(response.status).toBe(200);
		expect(sent.map((s) => [s.url, s.headers["x-api-key"], s.headers["if-none-match"]])).toEqual([
			["https://a.example/1", "k1", '"v1"'],
			["https://a.example/2", "k1", '"v1"'],
			["https://b.example/3", undefined, '"v1"'],
			["https://a.example/4", undefined, '"v1"'],
		]);
	});

	it("drops the credential when a redirect moves from https to http on the same host", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/": redirect("http://a.example/"),
			"http://a.example/": ok(),
		});
		await guardedFetch(
			"https://a.example/",
			request({ authorization: "Bearer t" }, "authorization"),
			net,
		);
		expect(sent.map((s) => s.headers.authorization)).toEqual(["Bearer t", undefined]);
	});

	it(`follows ${MAX_REDIRECTS} redirects and fails on the next one`, async () => {
		const chain = (hops: number) =>
			Object.fromEntries(
				Array.from({ length: hops + 1 }, (_, i) => [
					`https://a.example/${i}`,
					i < hops ? redirect(`/${i + 1}`) : ok(),
				]),
			);
		const five = fakeNet(chain(MAX_REDIRECTS));
		expect((await guardedFetch("https://a.example/0", request(), five.net)).status).toBe(200);
		expect(five.sent).toHaveLength(6);
		const six = fakeNet(chain(MAX_REDIRECTS + 1));
		expect(await failure(guardedFetch("https://a.example/0", request(), six.net))).toEqual(
			new UrlSourceError("TOO_MANY_REDIRECTS", "More than 5 redirects"),
		);
		expect(six.sent).toHaveLength(6);
	});

	it("returns a redirect status without a Location, and a 304, as the response", async () => {
		const { net } = fakeNet({
			"https://a.example/300": () => new Response(null, { status: 300 }),
			"https://a.example/304": () => new Response(null, { status: 304 }),
		});
		expect((await guardedFetch("https://a.example/300", request(), net)).status).toBe(300);
		expect((await guardedFetch("https://a.example/304", request(), net)).status).toBe(304);
	});

	it("skips host and address checks, but not the scheme, when private networks are allowed", async () => {
		const { net, resolved } = fakeNet(
			{
				"http://127.0.0.1:4000/feed": redirect("http://localhost:4000/x"),
				"http://localhost:4000/x": ok(),
			},
			async () => ["127.0.0.1"],
			true,
		);
		expect((await guardedFetch("http://127.0.0.1:4000/feed", request(), net)).status).toBe(200);
		expect(resolved).toEqual([]);
		expect((await failure(guardedFetch("ftp://127.0.0.1/", request(), net))).code).toBe(
			"URL_BLOCKED",
		);
	});

	it("rejects with the abort reason when the signal aborts during DNS", async () => {
		const controller = new AbortController();
		const { net } = fakeNet({}, () => new Promise<string[]>(() => {}));
		const pending = guardedFetch(
			"https://slow-dns.example/",
			{ headers: new Headers(), signal: controller.signal },
			net,
		);
		const reason = new UrlSourceError("FETCH_FAILED", "No response headers within 15 s");
		controller.abort(reason);
		expect(await failure(pending)).toBe(reason);
	});
});

describe("resolvers", () => {
	it("dohResolver asks for A and AAAA records and keeps only addresses of that type", async () => {
		const asked: string[] = [];
		const resolve = dohResolver(async (input, init) => {
			asked.push(`${String(input)} ${new Headers(init?.headers).get("accept")}`);
			const type = new URL(String(input)).searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer:
					type === "A"
						? [
								{ name: "feeds.example.com", type: 5, data: "cdn.example.net." },
								{ name: "cdn.example.net", type: 1, data: "93.184.215.14" },
							]
						: [
								{
									name: "cdn.example.net",
									type: 28,
									data: "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
								},
							],
			});
		});
		expect(await resolve("feeds.example.com")).toEqual([
			"93.184.215.14",
			"2606:2800:21f:cb07:6820:80da:af6b:8b2c",
		]);
		expect(asked).toEqual([
			"https://cloudflare-dns.com/dns-query?name=feeds.example.com&type=A application/dns-json",
			"https://cloudflare-dns.com/dns-query?name=feeds.example.com&type=AAAA application/dns-json",
		]);
	});

	it("dohResolver gives no addresses for NXDOMAIN and rejects other failures", async () => {
		expect(await dohResolver(async () => Response.json({ Status: 3 }))("nx.example")).toEqual([]);
		await expect(
			dohResolver(async () => Response.json({ Status: 2 }))("x.example"),
		).rejects.toThrow("DNS over HTTPS failed with status 2");
		await expect(
			dohResolver(async () => new Response("no", { status: 503 }))("x.example"),
		).rejects.toThrow("DNS over HTTPS answered 503");
	});

	it("nodeResolver returns every address from the system resolver", async () => {
		const addresses = await nodeResolver("localhost");
		expect(addresses.length).toBeGreaterThan(0);
		expect(addresses.every((a) => isPublicAddress(a) === false)).toBe(true);
	});
});

describe("allowPrivateNetwork", () => {
	it("is honoured only in development", () => {
		expect(allowPrivateNetwork(true, true)).toBe(true);
		expect(allowPrivateNetwork(true, false)).toBe(false);
		expect(allowPrivateNetwork(false, true)).toBe(false);
	});

	it("is off when fluxImportRoutes() did not set it", () => {
		expect(allowPrivateNetwork()).toBe(false);
	});
});
```

In `packages/flux-import/tests/unit/integration.test.ts`, replace
```ts
		expect(configs).toEqual([{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: "1234" } } }]);
	});
```
with:
```ts
		expect(configs).toEqual([
			{
				vite: {
					define: {
						__FLUX_IMPORT_MAX_SOURCE_BYTES__: "1234",
						__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "false",
					},
				},
			},
		]);
	});

	it("passes allowPrivateNetwork to the build", () => {
		expect(runSetup({ allowPrivateNetwork: true }).configs).toEqual([
			{
				vite: {
					define: {
						__FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT),
						__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "true",
					},
				},
			},
		]);
	});
```
then replace
```ts
			{ vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT) } } },
```
with:
```ts
			{
				vite: {
					define: {
						__FLUX_IMPORT_MAX_SOURCE_BYTES__: String(MAX_SOURCE_BYTES_DEFAULT),
						__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: "false",
					},
				},
			},
```


- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/net.test.ts tests/unit/integration.test.ts`
Expected: FAIL — `net.test.ts` cannot load `../../src/sources/net.js` (it does not exist yet), and `integration.test.ts` fails 3 of its 4 tests because the define has no `__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__` yet.

- [ ] **Step 3: Implement the guard**

Create `packages/flux-import/src/sources/net.ts`:
```ts
import { onWorkers } from "../emdash/workers.js";

/**
 * The SSRF guard for URL sources, modelled on EmDash core's internal `ssrfSafeFetch`
 * (`emdash` src/security/ssrf.ts), which is not exported. Sources are fetched with the runtime's
 * own `fetch()`, not `ctx.http.fetch()` (8 MiB buffered limit), so this module is the only check.
 *
 * Known gap, as in EmDash core: DNS can change between the check and the connection. On Workers,
 * Cloudflare's network refuses private ranges itself.
 */

export const MAX_REDIRECTS = 5;
export const URL_MAX_LENGTH = 2048;
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type UrlSourceErrorCode =
	| "URL_BLOCKED"
	| "FETCH_FAILED"
	| "HTTP_ERROR"
	| "TOO_MANY_REDIRECTS"
	| "TOO_LARGE"
	| "LENGTH_REQUIRED";

/** A fetch failure with its route error code. Messages never contain header values. */
export class UrlSourceError extends Error {
	constructor(
		readonly code: UrlSourceErrorCode,
		message: string,
	) {
		super(message);
		this.name = "UrlSourceError";
	}
}

/** Maps a hostname to its IPv4 and IPv6 addresses. */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface NetOptions {
	resolver: Resolver;
	/** Skips the hostname and address checks (development only; see `allowPrivateNetwork()`). */
	allowPrivateNetwork: boolean;
	fetch: typeof globalThis.fetch;
}

const blocked = (message: string) => new UrlSourceError("URL_BLOCKED", message);

/** Parses a source URL: `http:` or `https:`, no user name or password, at most 2,048 characters. */
export function parseSourceUrl(text: string): URL {
	if (text.length > URL_MAX_LENGTH) {
		throw blocked(`URLs are limited to ${URL_MAX_LENGTH} characters`);
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw blocked("The URL is not valid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw blocked(`The URL scheme "${url.protocol}" is not allowed; use http or https`);
	}
	if (url.username !== "" || url.password !== "") {
		throw blocked("URLs cannot contain a user name or password; use a credential");
	}
	if (url.href.length > URL_MAX_LENGTH) {
		throw blocked(`URLs are limited to ${URL_MAX_LENGTH} characters`);
	}
	return url;
}

const BLOCKED_NAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google",
	"metadata.google.internal",
	"instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** The URL's host without IPv6 brackets or trailing dots, lower-cased. */
export function hostOf(url: URL): string {
	return url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase();
}

export function isBlockedHostname(host: string): boolean {
	return BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Dotted-decimal IPv4 as an unsigned number; other forms are not addresses here. */
function parseIpv4(text: string): number | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (!match) return null;
	let value = 0;
	for (const part of match.slice(1) as string[]) {
		const n = Number(part);
		if (n > 255 || (part.length > 1 && part.startsWith("0"))) return null;
		value = value * 256 + n;
	}
	return value;
}

/** IPv6 as eight 16-bit groups, with an optional dotted IPv4 tail; zone IDs are not accepted. */
function parseIpv6(text: string): number[] | null {
	let rest = text;
	const tail: number[] = [];
	if (rest.includes(".")) {
		const colon = rest.lastIndexOf(":");
		const v4 = colon < 0 ? null : parseIpv4(rest.slice(colon + 1));
		if (v4 === null) return null;
		tail.push(Math.floor(v4 / 65536), v4 % 65536);
		rest = rest.slice(0, colon + 1);
		if (!rest.endsWith("::")) rest = rest.slice(0, -1);
	}
	const halves = rest.split("::");
	if (halves.length > 2) return null;
	const groups = (part: string) => (part === "" ? [] : part.split(":"));
	const head = groups(halves[0] ?? "");
	const after = halves.length === 2 ? groups(halves[1] ?? "") : [];
	if (![...head, ...after].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
	const count = head.length + after.length + tail.length;
	if (halves.length === 2 ? count > 7 : count !== 8) return null;
	const hex = (g: string) => Number.parseInt(g, 16);
	const zeros = new Array<number>(halves.length === 2 ? 8 - count : 0).fill(0);
	return [...head.map(hex), ...zeros, ...after.map(hex), ...tail];
}

/** [first address, prefix length] */
const BLOCKED_V4: Array<[number, number]> = [
	[0x00000000, 8], // 0.0.0.0/8
	[0x0a000000, 8], // 10/8
	[0x64400000, 10], // 100.64/10
	[0x7f000000, 8], // 127/8
	[0xa9fe0000, 16], // 169.254/16
	[0xac100000, 12], // 172.16/12
	[0xc0000000, 24], // 192.0.0/24
	[0xc0a80000, 16], // 192.168/16
	[0xc6120000, 15], // 198.18/15
	[0xe0000000, 3], // 224/4 and everything above it
];

function isPublicV4(address: number): boolean {
	return !BLOCKED_V4.some(([base, bits]) => {
		const size = 2 ** (32 - bits);
		return Math.floor(address / size) === Math.floor(base / size);
	});
}

/** The IPv4 address inside `::a.b.c.d`, `::ffff:a.b.c.d` and NAT64 `64:ff9b::a.b.c.d`. */
function embeddedV4(g: number[]): number | null {
	const zeroHead = g.slice(0, 5).every((x) => x === 0);
	const mapped = zeroHead && (g[5] === 0xffff || g[5] === 0);
	const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
	return mapped || nat64 ? (g[6] ?? 0) * 65536 + (g[7] ?? 0) : null;
}

function isPublicV6(g: number[]): boolean {
	// `::` and `::1` embed 0.0.0.0 and 0.0.0.1, both in 0.0.0.0/8.
	const v4 = embeddedV4(g);
	if (v4 !== null) return isPublicV4(v4);
	const first = g[0] ?? 0;
	// Only global unicast (2000::/3) is public: this excludes fc00::/7, fe80::/10 and ff00::/8.
	if ((first & 0xe000) !== 0x2000) return false;
	// Teredo (2001::/32) and 6to4 (2002::/16) carry IPv4 addresses; 2001:db8::/32 is documentation.
	if (first === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return false;
	return first !== 0x2002;
}

/** Whether `text` is an IP address (`null` when it is not one). */
export function isPublicAddress(text: string): boolean | null {
	const v4 = parseIpv4(text);
	if (v4 !== null) return isPublicV4(v4);
	const v6 = parseIpv6(text);
	return v6 === null ? null : isPublicV6(v6);
}

/**
 * The checks that need no DNS: hostname rules and IP literals. `URL` has already normalised
 * decimal, octal and hex IPv4 forms (`http://2130706433/` has the host `127.0.0.1`).
 */
export function checkHost(url: URL, allowPrivateNetwork: boolean): void {
	if (allowPrivateNetwork) return;
	const host = hostOf(url);
	if (isBlockedHostname(host)) throw blocked(`The host ${host} is not allowed`);
	if (isPublicAddress(host) === false) throw blocked(`The address ${host} is not public`);
}

async function checkAddresses(url: URL, net: NetOptions): Promise<void> {
	checkHost(url, net.allowPrivateNetwork);
	const host = hostOf(url);
	if (net.allowPrivateNetwork || isPublicAddress(host) !== null) return;
	let addresses: string[];
	try {
		addresses = await net.resolver(host);
	} catch (e) {
		throw new UrlSourceError("FETCH_FAILED", `Could not resolve ${host}: ${errorText(e)}`);
	}
	if (addresses.length === 0) {
		throw new UrlSourceError("FETCH_FAILED", `${host} has no addresses`);
	}
	if (!addresses.every((a) => isPublicAddress(a) === true)) {
		throw blocked(`${host} resolves to an address that is not public`);
	}
}

function errorText(e: unknown): string {
	const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
	return `${e instanceof Error ? e.message : String(e)}${cause}`;
}

/** Rejects with the abort reason when `signal` aborts; never resolves. */
export function whenAborted(signal: AbortSignal): Promise<never> {
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	aborted.catch(() => {});
	return aborted;
}

/** The abort reason when it is one of ours (a timeout), else a `FETCH_FAILED` for `e`. */
export function fetchError(e: unknown, signal: AbortSignal, context: string): UrlSourceError {
	if (e instanceof UrlSourceError) return e;
	if (signal.aborted && signal.reason instanceof UrlSourceError) return signal.reason;
	return new UrlSourceError("FETCH_FAILED", `${context}: ${errorText(e)}`);
}

export interface GuardedRequest {
	headers: Headers;
	/** Removed from the request once a redirect leaves the original origin. */
	credentialHeader?: string;
	signal: AbortSignal;
}

/**
 * GETs `start`, following at most five redirects by hand and checking every URL, its host and
 * every address it resolves to before connecting. Returns the first response that is not a
 * redirect with a `Location`.
 */
export async function guardedFetch(
	start: string,
	request: GuardedRequest,
	net: NetOptions,
): Promise<Response> {
	const headers = new Headers(request.headers);
	const aborted = whenAborted(request.signal);
	let url = parseSourceUrl(start);
	for (let hop = 0; ; hop++) {
		const host = hostOf(url);
		try {
			await Promise.race([checkAddresses(url, net), aborted]);
		} catch (e) {
			throw fetchError(e, request.signal, `Could not resolve ${host}`);
		}
		let response: Response;
		try {
			response = await net.fetch(url.href, {
				method: "GET",
				headers,
				redirect: "manual",
				signal: request.signal,
			});
		} catch (e) {
			throw fetchError(e, request.signal, `Could not fetch from ${host}`);
		}
		const location = REDIRECT_STATUSES.has(response.status)
			? response.headers.get("location")
			: null;
		if (location === null) return response;
		await response.body?.cancel().catch(() => {});
		if (hop === MAX_REDIRECTS) {
			throw new UrlSourceError("TOO_MANY_REDIRECTS", `More than ${MAX_REDIRECTS} redirects`);
		}
		let next: URL;
		try {
			next = parseSourceUrl(new URL(location, url).href);
		} catch (e) {
			throw e instanceof UrlSourceError ? e : blocked("A redirect points to an invalid URL");
		}
		if (request.credentialHeader !== undefined && next.origin !== url.origin) {
			headers.delete(request.credentialHeader);
		}
		url = next;
	}
}

/** Node: the system resolver, every address (`node:dns` `lookup(…, { all: true })`). */
export const nodeResolver: Resolver = async (hostname) => {
	const { lookup } = await import("node:dns/promises");
	const answers = await lookup(hostname, { all: true, verbatim: true });
	return answers.map((a) => a.address);
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Workers: DNS over HTTPS (`cloudflare-dns.com`, A and AAAA); `node:dns` lookups fail under
 * workerd. NXDOMAIN gives no addresses; any other failure rejects.
 */
export function dohResolver(
	fetchFn: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): Resolver {
	const query = async (name: string, type: "A" | "AAAA"): Promise<string[]> => {
		const response = await fetchFn(`${DOH_URL}?${new URLSearchParams({ name, type })}`, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`DNS over HTTPS answered ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body)) throw new Error("DNS over HTTPS gave an invalid answer");
		if (body.Status === 3) return [];
		if (body.Status !== 0) {
			throw new Error(`DNS over HTTPS failed with status ${String(body.Status)}`);
		}
		const want = type === "A" ? 1 : 28;
		const answers = Array.isArray(body.Answer) ? body.Answer : [];
		return answers.flatMap((a: unknown) =>
			isRecord(a) && a.type === want && typeof a.data === "string" ? [a.data] : [],
		);
	};
	return async (hostname) =>
		(await Promise.all([query(hostname, "A"), query(hostname, "AAAA")])).flat();
}

export function defaultResolver(): Resolver {
	return onWorkers() ? dohResolver() : nodeResolver;
}
```

- [ ] **Step 4: Add the option and its DEV-only reader**

In `packages/flux-import/src/astro/config.ts`, replace
```ts
declare const __FLUX_IMPORT_MAX_SOURCE_BYTES__: number | undefined;
```
with:
```ts
declare const __FLUX_IMPORT_MAX_SOURCE_BYTES__: number | undefined;
declare const __FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: boolean | undefined;
```
then replace
```ts
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}
```
with:
```ts
		? __FLUX_IMPORT_MAX_SOURCE_BYTES__
		: MAX_SOURCE_BYTES_DEFAULT;
}

/**
 * Whether URL sources may reach private and loopback hosts: only when `fluxImportRoutes()` was
 * given `allowPrivateNetwork: true` and the code runs in development. A production build replaces
 * `import.meta.env.DEV` with `false`, so the option is ignored there.
 */
export function allowPrivateNetwork(
	requested: boolean = typeof __FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__ === "boolean" &&
		__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__,
	dev: boolean = import.meta.env.DEV,
): boolean {
	return requested && dev;
}
```

In `packages/flux-import/src/astro/integration.ts`, replace
```ts
	maxSourceBytes?: number;
}
```
with:
```ts
	maxSourceBytes?: number;
	/**
	 * Lets URL sources reach private and loopback addresses, for development and tests. Honoured
	 * only when `import.meta.env.DEV` is true; production builds ignore it.
	 */
	allowPrivateNetwork?: boolean;
}
```
then replace
```ts
					vite: { define: { __FLUX_IMPORT_MAX_SOURCE_BYTES__: JSON.stringify(max) } },
```
with:
```ts
					vite: {
						define: {
							__FLUX_IMPORT_MAX_SOURCE_BYTES__: JSON.stringify(max),
							__FLUX_IMPORT_ALLOW_PRIVATE_NETWORK__: JSON.stringify(
								options.allowPrivateNetwork === true,
							),
						},
					},
```

In `packages/flux-import/src/astro/env.d.ts`, replace
```ts
/// <reference types="emdash/locals" />
```
with:
```ts
/// <reference types="emdash/locals" />
/// <reference types="astro/client" />
```


- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/net.test.ts tests/unit/integration.test.ts`
Expected: PASS (103 tests in `net.test.ts`, 4 in `integration.test.ts`). `nodeResolver("localhost")` uses the machine's resolver and needs no network. Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 28 files / 707 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/sources/net.ts packages/flux-import/src/astro packages/flux-import/tests/unit/net.test.ts packages/flux-import/tests/unit/integration.test.ts
git commit -m "Add the SSRF guard for URL sources and the development-only allowPrivateNetwork option"
```

### Task 2: Fetcher: conditional GET, limits and staging

**Files:**
- Create: `packages/flux-import/src/sources/fetcher.ts`
- Modify: `packages/flux-import/src/emdash/uploads.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/fetcher.test.ts` (new), `packages/flux-import/tests/unit/uploads.test.ts`

**Interfaces:**
- Consumes: Task 1 (`guardedFetch`, `NetOptions`, `UrlSourceError`, `whenAborted`, `fetchError`); `stageUpload(storage, body, maxBytes, declaredLength?)`, `UploadTooLargeError`, `EmDashUploads` (`src/emdash/uploads.ts`, W2); `Storage.exists` (A3); `FakeStorage`, `streamOf` (tests).
- Produces (`src/sources/fetcher.ts`):
  - `const MIB = 1024 * 1024`; `interface FetchLimits { maxBytes: number; headersMs: number; totalMs: number; bufferBytes: number }`; `const FETCH_LIMITS = { headersMs: 15_000, totalMs: 120_000, bufferBytes: 32 * MIB }`
  - `interface LastFetch { at: string; status: number; etag?: string; lastModified?: string; sha256: string; bytes: number; uploadId: string }`
  - `interface Credential { header: string; value: string }`
  - `interface DownloadInput { url: string; credential?: Credential; previous?: LastFetch; force: boolean }`; `interface DownloadResult { changed: boolean; fetch: LastFetch }`
  - `interface FetcherDeps { storage: UploadStorage; net: NetOptions; limits: FetchLimits; workers: boolean; now: () => number }`
  - `downloadSource(deps: FetcherDeps, input: DownloadInput): Promise<DownloadResult>`
- Produces (`src/emdash/uploads.ts`): `UploadStorage` adds `"exists"`; `EmDashUploads.exists(uploadId: string): Promise<boolean>` (throws `SourceMissingError` for a malformed ID, like `uploadKey`). `FakeStorage.exists(key)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/fetcher.test.ts`:
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { uploadKey } from "../../src/emdash/uploads.js";
import {
	type DownloadInput,
	downloadSource,
	type FetcherDeps,
	type FetchLimits,
	type LastFetch,
} from "../../src/sources/fetcher.js";
import { UrlSourceError } from "../../src/sources/net.js";
import { FakeStorage } from "./fakes.js";
import { streamOf } from "./helpers.js";

const URL_A = "https://feeds.example.com/products.csv";
const BODY = "sku,Name\nA,One\nB,Two\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const NOW = Date.parse("2026-10-26T09:00:00Z");

type Handler = (request: { headers: Headers; signal: AbortSignal }) => Response | Promise<Response>;

function setup(handler: Handler, opts: { workers?: boolean; limits?: Partial<FetchLimits> } = {}) {
	const storage = new FakeStorage();
	const requests: Headers[] = [];
	const deps: FetcherDeps = {
		storage,
		net: {
			allowPrivateNetwork: false,
			resolver: async () => ["93.184.215.14"],
			fetch: async (input, init) => {
				expect(String(input)).toBe(URL_A);
				const headers = new Headers(init?.headers);
				requests.push(headers);
				return handler({ headers, signal: init?.signal as AbortSignal });
			},
		},
		limits: {
			maxBytes: 1000,
			headersMs: 15_000,
			totalMs: 120_000,
			bufferBytes: 500,
			...opts.limits,
		},
		workers: opts.workers ?? false,
		now: () => NOW,
	};
	const staged = () =>
		[...storage.files.entries()].map(([key, file]) => [key, new TextDecoder().decode(file.bytes)]);
	return { deps, storage, requests, staged };
}

const csv = (body: string, headers: Record<string, string> = {}, status = 200) =>
	new Response(streamOf(body, 4), { status, headers });

/** Stages `text` as the previous fetch's upload, as an earlier fetch would have. */
async function previousFetch(
	deps: FetcherDeps,
	text: string,
	extra: Partial<LastFetch> = {},
): Promise<LastFetch> {
	const first = await downloadSource(
		{ ...deps, net: { ...deps.net, fetch: async () => new Response(text) } },
		{ url: URL_A, force: false },
	);
	return { ...first.fetch, ...extra };
}

const run = (deps: FetcherDeps, input: Partial<DownloadInput> = {}) =>
	downloadSource(deps, { url: URL_A, force: false, ...input });

async function failure(promise: Promise<unknown>): Promise<UrlSourceError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(UrlSourceError);
	return error as UrlSourceError;
}

describe("downloadSource", () => {
	it("stages the body with its hash, validators and status, sending the credential", async () => {
		const { deps, requests, staged } = setup(() =>
			csv(BODY, { etag: '"v1"', "last-modified": "Mon, 26 Oct 2026 08:00:00 GMT" }),
		);
		const result = await run(deps, {
			credential: { header: "Authorization", value: "Bearer t0k" },
		});
		expect(result).toEqual({
			changed: true,
			fetch: {
				at: "2026-10-26T09:00:00.000Z",
				status: 200,
				etag: '"v1"',
				lastModified: "Mon, 26 Oct 2026 08:00:00 GMT",
				sha256: sha(BODY),
				bytes: BODY.length,
				uploadId: expect.any(String),
			},
		});
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), BODY]]);
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({ authorization: "Bearer t0k" });
	});

	it("sends the validators of the last fetch and reports a 304 as unchanged", async () => {
		const { deps, requests, staged } = setup(() => new Response(null, { status: 304 }));
		const previous = await previousFetch(deps, BODY, {
			etag: 'W/"v1"',
			lastModified: "Mon, 26 Oct 2026 08:00:00 GMT",
		});
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({
			"if-none-match": 'W/"v1"',
			"if-modified-since": "Mon, 26 Oct 2026 08:00:00 GMT",
		});
		expect(result).toEqual({ changed: false, fetch: { ...previous, status: 304 } });
		expect(staged()).toHaveLength(1);
	});

	it("keeps a new validator that comes with a 304", async () => {
		const { deps } = setup(() => new Response(null, { status: 304, headers: { etag: '"v2"' } }));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		expect((await run(deps, { previous })).fetch.etag).toBe('"v2"');
	});

	it("reports the same body as unchanged and deletes the new copy", async () => {
		const { deps, requests, staged } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY);
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result).toEqual({ changed: false, fetch: { ...previous, status: 200 } });
		expect(staged()).toEqual([[uploadKey(previous.uploadId), BODY]]);
	});

	it("reports a different body as changed and keeps both files", async () => {
		const { deps, staged } = setup(() => csv(`${BODY}C,Three\n`));
		const previous = await previousFetch(deps, BODY);
		const result = await run(deps, { previous });
		expect(result.changed).toBe(true);
		expect(result.fetch.uploadId).not.toBe(previous.uploadId);
		expect(staged()).toHaveLength(2);
	});

	it("with force sends no validators and reports the same body as changed", async () => {
		const { deps, requests, staged } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		const result = await run(deps, { previous, force: true });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result.changed).toBe(true);
		expect(staged()).toHaveLength(2);
	});

	it("fetches in full when the previous upload is gone, even if the body is the same", async () => {
		const { deps, storage, requests } = setup(() => csv(BODY));
		const previous = await previousFetch(deps, BODY, { etag: '"v1"' });
		await storage.delete(uploadKey(previous.uploadId));
		const result = await run(deps, { previous });
		expect(Object.fromEntries(requests[0]!.entries())).toEqual({});
		expect(result.changed).toBe(true);
		expect(result.fetch.uploadId).not.toBe(previous.uploadId);
	});

	it("treats a 304 to an unconditional request as an HTTP error", async () => {
		const { deps } = setup(() => new Response(null, { status: 304 }));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("HTTP_ERROR", "The server answered HTTP 304"),
		);
	});

	it.each([404, 401, 500])("fails with HTTP_ERROR on %i and stages nothing", async (status) => {
		let cancelled = false;
		const body = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		const { deps, staged } = setup(() => new Response(body, { status }));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("HTTP_ERROR", `The server answered HTTP ${status}`),
		);
		expect(cancelled).toBe(true);
		expect(staged()).toEqual([]);
	});

	it("refuses a Content-Length over the limit before reading the body", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(10));
			},
		});
		const { deps, staged } = setup(
			() => new Response(body, { headers: { "content-length": "1001" } }),
		);
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("TOO_LARGE", "The response is larger than the limit of 1000 bytes"),
		);
		expect(pulls).toBeLessThanOrEqual(1);
		expect(staged()).toEqual([]);
	});

	it("cuts a body without a length at the limit and deletes the partial upload", async () => {
		const { deps, staged } = setup(() => csv("x".repeat(1001)));
		expect((await failure(run(deps))).code).toBe("TOO_LARGE");
		expect(staged()).toEqual([]);
	});

	it("ignores a Content-Length that comes with a Content-Encoding", async () => {
		// fetch() has already decoded the body, so the header gives the compressed size.
		const body = "y".repeat(900);
		const { deps, staged } = setup(() =>
			csv(body, { "content-encoding": "gzip", "content-length": "40" }),
		);
		const result = await run(deps);
		expect(result.fetch.bytes).toBe(900);
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), body]]);
	});

	it("fails with FETCH_FAILED when no response arrives in time", async () => {
		const { deps, staged } = setup(
			({ signal }) =>
				new Promise<Response>((_, reject) =>
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
				),
			{ limits: { headersMs: 30 } },
		);
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "No response within 0.03 s"),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with FETCH_FAILED when the download takes too long, and deletes the partial upload", async () => {
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("sku,Name\n"));
			},
			pull: () => new Promise(() => {}),
		});
		const { deps, staged } = setup(() => new Response(stalled), {
			limits: { headersMs: 20, totalMs: 60 },
		});
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download did not finish within 0.06 s"),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with FETCH_FAILED when the connection breaks mid-body", async () => {
		let sent = false;
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new TypeError("terminated"));
				else controller.enqueue(new TextEncoder().encode("sku,Name\n"));
				sent = true;
			},
		});
		const { deps, staged } = setup(() => new Response(broken));
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError("FETCH_FAILED", "The download failed: terminated"),
		);
		expect(staged()).toEqual([]);
	});
});

describe("downloadSource on Workers", () => {
	/** Records how much of the body had been read when storage received it. */
	function counted(text: string, headers: Record<string, string> = {}) {
		const state = {
			pulls: 0,
			done: false,
			atUpload: [] as Array<{ pulls: number; done: boolean }>,
		};
		const bytes = new TextEncoder().encode(text);
		const response = () => {
			let at = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						state.pulls++;
						if (at >= bytes.length) {
							state.done = true;
							controller.close();
							return;
						}
						controller.enqueue(bytes.slice(at, at + 50));
						at += 50;
					},
				}),
				{ headers },
			);
		};
		return { state, response };
	}

	function watch(
		storage: FakeStorage,
		state: { pulls: number; done: boolean; atUpload: Array<{ pulls: number; done: boolean }> },
	) {
		const upload = storage.upload.bind(storage);
		storage.upload = (options) => {
			state.atUpload.push({ pulls: state.pulls, done: state.done });
			return upload(options);
		};
	}

	it("buffers a body without a length, then stores it", async () => {
		const text = "z".repeat(420);
		const { state, response } = counted(text);
		const { deps, storage, staged } = setup(response, { workers: true });
		watch(storage, state);
		const result = await run(deps);
		expect(state.atUpload).toEqual([{ pulls: 10, done: true }]);
		expect(result.fetch.bytes).toBe(420);
		expect(staged()).toEqual([[uploadKey(result.fetch.uploadId), text]]);
	});

	it("buffers a compressed body, whose Content-Length is not its length", async () => {
		const { state, response } = counted("z".repeat(120), {
			"content-encoding": "gzip",
			"content-length": "30",
		});
		const { deps, storage } = setup(response, { workers: true });
		watch(storage, state);
		expect((await run(deps)).fetch.bytes).toBe(120);
		expect(state.atUpload[0]?.done).toBe(true);
	});

	it("streams a body with a usable Content-Length", async () => {
		const text = "z".repeat(420);
		const { state, response } = counted(text, { "content-length": "420" });
		const { deps, storage } = setup(response, { workers: true });
		watch(storage, state);
		expect((await run(deps)).fetch.bytes).toBe(420);
		// Storage got the stream before the body was read (Response pre-reads one chunk).
		expect(state.atUpload).toEqual([{ pulls: 1, done: false }]);
	});

	it("fails with LENGTH_REQUIRED past the buffer limit and stages nothing", async () => {
		const { response } = counted("z".repeat(501));
		const { deps, staged } = setup(response, { workers: true });
		expect(await failure(run(deps))).toEqual(
			new UrlSourceError(
				"LENGTH_REQUIRED",
				"The response has no usable Content-Length and is larger than 500 bytes, the most Workers can buffer",
			),
		);
		expect(staged()).toEqual([]);
	});

	it("fails with TOO_LARGE when the limit is below the buffer limit", async () => {
		const { response } = counted("z".repeat(301));
		const { deps } = setup(response, { workers: true, limits: { maxBytes: 300 } });
		expect((await failure(run(deps))).code).toBe("TOO_LARGE");
	});
});
```

In `packages/flux-import/tests/unit/uploads.test.ts`, replace
```ts
	it("maps a missing file or a malformed ID to SourceMissingError", async () => {
```
with:
```ts
	it("tells whether a staged file still exists", async () => {
		const { uploads, uploadId } = await staged("x");
		expect(await uploads.exists(uploadId)).toBe(true);
		await uploads.delete(uploadId);
		expect(await uploads.exists(uploadId)).toBe(false);
		expect(() => uploads.exists("../x")).toThrow(SourceMissingError);
	});

	it("maps a missing file or a malformed ID to SourceMissingError", async () => {
```

In `packages/flux-import/tests/unit/fakes.ts`, replace
```ts
	async delete(key: string) {
		this.files.delete(key);
	}
```
with:
```ts
	async delete(key: string) {
		this.files.delete(key);
	}

	async exists(key: string) {
		return this.files.has(key);
	}
```


- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/fetcher.test.ts tests/unit/uploads.test.ts`
Expected: FAIL — `fetcher.test.ts` cannot load `../../src/sources/fetcher.js`, and "tells whether a staged file still exists" fails with `uploads.exists is not a function`.

- [ ] **Step 3: Add `exists` to staged uploads**

In `packages/flux-import/src/emdash/uploads.ts`, replace
```ts
export type UploadStorage = Pick<Storage, "upload" | "download" | "delete" | "list">;
```
with:
```ts
export type UploadStorage = Pick<Storage, "upload" | "download" | "delete" | "list" | "exists">;
```
then replace
```ts
	async delete(uploadId: string): Promise<void> {
		try {
```
with:
```ts
	/** Whether the staged file is still in storage. */
	exists(uploadId: string): Promise<boolean> {
		return this.storage.exists(uploadKey(uploadId));
	}

	async delete(uploadId: string): Promise<void> {
		try {
```

- [ ] **Step 4: Implement the fetcher**

Create `packages/flux-import/src/sources/fetcher.ts`:
```ts
import {
	EmDashUploads,
	type StagedUpload,
	stageUpload,
	type UploadStorage,
	UploadTooLargeError,
} from "../emdash/uploads.js";
import { fetchError, guardedFetch, type NetOptions, UrlSourceError, whenAborted } from "./net.js";

export const MIB = 1024 * 1024;

export interface FetchLimits {
	/** `maxSourceBytes`, the upload limit. */
	maxBytes: number;
	/** Until the final response's headers arrive, DNS and redirects included. */
	headersMs: number;
	/** For the whole download. */
	totalMs: number;
	/** Workers only: the most a body of unknown length may be buffered to learn its length. */
	bufferBytes: number;
}

export const FETCH_LIMITS = {
	headersMs: 15_000,
	totalMs: 120_000,
	bufferBytes: 32 * MIB,
} as const satisfies Omit<FetchLimits, "maxBytes">;

/** What a successful fetch saves on the source. */
export interface LastFetch {
	at: string;
	/** HTTP status of the final response. */
	status: number;
	etag?: string;
	lastModified?: string;
	sha256: string;
	bytes: number;
	uploadId: string;
}

export interface Credential {
	header: string;
	value: string;
}

export interface DownloadInput {
	url: string;
	credential?: Credential;
	/** The source's last successful fetch. */
	previous?: LastFetch;
	/** Skip the conditional headers and the hash comparison. */
	force: boolean;
}

export interface DownloadResult {
	changed: boolean;
	fetch: LastFetch;
}

export interface FetcherDeps {
	storage: UploadStorage;
	net: NetOptions;
	limits: FetchLimits;
	/** Workers: storage needs the body's length up front (R2 through `FixedLengthStream`). */
	workers: boolean;
	now: () => number;
}

/** The declared length, or `undefined` when there is none or it does not describe the body. */
function bodyLength(headers: Headers): number | undefined {
	const encoding = headers.get("content-encoding");
	// fetch() decodes a compressed body, so its Content-Length no longer matches (Fact W1).
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
	const text = headers.get("content-length");
	if (text === null || !/^\d+$/.test(text.trim())) return undefined;
	const length = Number(text.trim());
	return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Passes `body` through until `signal` aborts. Any failure while reading becomes a
 * `UrlSourceError` (`FETCH_FAILED`, or the timeout that aborted the signal), so the caller can
 * tell a broken download from a storage error.
 */
function guardBody(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const aborted = whenAborted(signal);
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await Promise.race([reader.read(), aborted]);
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (e) {
					reader.cancel().catch(() => {});
					controller.error(fetchError(e, signal, "The download failed"));
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

const tooLarge = (limit: number) =>
	new UrlSourceError("TOO_LARGE", `The response is larger than the limit of ${limit} bytes`);

/**
 * Workers, unknown length: reads the body into memory (at most `bufferBytes`), then stages it
 * with its length. Larger bodies fail with `LENGTH_REQUIRED`, or `TOO_LARGE` past `maxBytes`.
 */
async function stageBuffered(
	storage: UploadStorage,
	body: ReadableStream<Uint8Array>,
	limits: FetchLimits,
): Promise<StagedUpload> {
	const reader = body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limits.maxBytes || total > limits.bufferBytes) {
			await reader.cancel().catch(() => {});
			if (total > limits.maxBytes) throw tooLarge(limits.maxBytes);
			throw new UrlSourceError(
				"LENGTH_REQUIRED",
				`The response has no usable Content-Length and is larger than ${limits.bufferBytes} bytes, the most Workers can buffer`,
			);
		}
		chunks.push(new Uint8Array(value));
	}
	return stageUpload(storage, new Blob(chunks).stream(), limits.maxBytes, total);
}

function validators(
	headers: Headers,
	previous?: LastFetch,
): Pick<LastFetch, "etag" | "lastModified"> {
	const etag = headers.get("etag") ?? previous?.etag;
	const lastModified = headers.get("last-modified") ?? previous?.lastModified;
	return {
		...(etag === null || etag === undefined ? {} : { etag }),
		...(lastModified === null || lastModified === undefined ? {} : { lastModified }),
	};
}

/**
 * Downloads `input.url` into a new staged upload, or reports it unchanged: a `304` to the
 * conditional request, or a body with the previous SHA-256. Either needs the previous staged
 * upload to still exist; without it (or with `force`) the fetch is unconditional and always
 * changed.
 */
export async function downloadSource(
	deps: FetcherDeps,
	input: DownloadInput,
): Promise<DownloadResult> {
	const { limits } = deps;
	const uploads = new EmDashUploads(deps.storage);
	const previous =
		input.previous && !input.force && (await uploads.exists(input.previous.uploadId))
			? input.previous
			: undefined;

	const headers = new Headers();
	if (previous?.etag !== undefined) headers.set("if-none-match", previous.etag);
	if (previous?.lastModified !== undefined) headers.set("if-modified-since", previous.lastModified);
	if (input.credential) headers.set(input.credential.header, input.credential.value);

	const total = new AbortController();
	const untilHeaders = new AbortController();
	const totalTimer = setTimeout(
		() =>
			total.abort(
				new UrlSourceError(
					"FETCH_FAILED",
					`The download did not finish within ${limits.totalMs / 1000} s`,
				),
			),
		limits.totalMs,
	);
	const headersTimer = setTimeout(
		() =>
			untilHeaders.abort(
				new UrlSourceError("FETCH_FAILED", `No response within ${limits.headersMs / 1000} s`),
			),
		limits.headersMs,
	);
	try {
		const response = await guardedFetch(
			input.url,
			{
				headers,
				signal: AbortSignal.any([total.signal, untilHeaders.signal]),
				...(input.credential ? { credentialHeader: input.credential.header } : {}),
			},
			deps.net,
		);
		clearTimeout(headersTimer);
		const at = new Date(deps.now()).toISOString();

		if (response.status === 304 && previous) {
			await response.body?.cancel().catch(() => {});
			return {
				changed: false,
				fetch: { ...previous, at, status: 304, ...validators(response.headers, previous) },
			};
		}
		if (response.status < 200 || response.status > 299) {
			await response.body?.cancel().catch(() => {});
			throw new UrlSourceError("HTTP_ERROR", `The server answered HTTP ${response.status}`);
		}

		const length = bodyLength(response.headers);
		if (length !== undefined && length > limits.maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw tooLarge(limits.maxBytes);
		}
		const body = guardBody(response.body ?? new Blob([]).stream(), total.signal);
		let staged: StagedUpload;
		try {
			staged =
				deps.workers && length === undefined
					? await stageBuffered(deps.storage, body, limits)
					: await stageUpload(deps.storage, body, limits.maxBytes, length);
		} catch (e) {
			if (e instanceof UploadTooLargeError) throw tooLarge(limits.maxBytes);
			throw e;
		}

		const fetched: LastFetch = {
			at,
			status: response.status,
			...validators(response.headers),
			sha256: staged.sha256,
			bytes: staged.bytes,
			uploadId: staged.uploadId,
		};
		if (
			previous &&
			staged.sha256 === previous.sha256 &&
			(await uploads.exists(previous.uploadId))
		) {
			await uploads.delete(staged.uploadId);
			return { changed: false, fetch: { ...fetched, uploadId: previous.uploadId } };
		}
		return { changed: true, fetch: fetched };
	} finally {
		clearTimeout(totalTimer);
		clearTimeout(headersTimer);
	}
}
```


- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/fetcher.test.ts tests/unit/uploads.test.ts`
Expected: PASS (22 tests in `fetcher.test.ts`, 16 in `uploads.test.ts`). The Workers tests set `workers: true` on Node: `stageUpload` still streams there (no `FixedLengthStream`), so they pin the order of reading and storing; Task 6 runs the real path. Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 29 files / 730 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/sources/fetcher.ts packages/flux-import/src/emdash/uploads.ts packages/flux-import/tests/unit/fetcher.test.ts packages/flux-import/tests/unit/uploads.test.ts packages/flux-import/tests/unit/fakes.ts
git commit -m "Fetch URL sources into staged uploads with conditional requests, limits and change detection"
```

### Task 3: Credentials store and routes

**Files:**
- Create: `packages/flux-import/src/plugin/credentials.ts`
- Modify: `packages/flux-import/src/plugin/definition.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/tests/unit/fakes.ts`
- Test: `packages/flux-import/tests/unit/credentials.test.ts` (new), `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: `PluginContext["settings"]` (`getVersioned`, `compareAndSet`; S1, S4); `emdashErrorCode` (`src/emdash/errors.ts`); `ServiceError` (`src/plugin/service.ts`); `Credential` (Task 2); `z.formatError` behaviour (S5).
- Produces (`src/plugin/credentials.ts`):
  - `const CREDENTIALS_SETTING = "credentials"`; `CREDENTIAL_NAME`, `HEADER_NAME`, `HEADER_VALUE` (`RegExp`); `FORBIDDEN_HEADERS: Set<string>` (lower-case)
  - `type CredentialSettings = Pick<PluginContext["settings"], "getVersioned" | "compareAndSet">`; `interface CredentialInfo { name: string; header: string }`
  - `setCredential(settings, name: string, credential: Credential): Promise<CredentialInfo>`; `deleteCredential(settings, name): Promise<{ deleted: true }>` (`NOT_FOUND` 404); `listCredentials(settings): Promise<CredentialInfo[]>`; `getCredential(settings, name): Promise<Credential | null>`
- Produces (routes): `credentials/set { name, header, value }` → `{ name, header }`; `credentials/delete { name }` → `{ deleted: true }`; `credentials/list {}` → `[{ name, header }]`. Setting `credentials` (`type: "secret"`) in `admin.settingsSchema`. Test fake `MemorySettings` (`tests/unit/fakes.ts`).

- [ ] **Step 1: Write the failing tests**

Create `packages/flux-import/tests/unit/credentials.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	CREDENTIALS_SETTING,
	deleteCredential,
	getCredential,
	listCredentials,
	setCredential,
} from "../../src/plugin/credentials.js";
import { ServiceError } from "../../src/plugin/service.js";
import { MemorySettings } from "./fakes.js";

const BEARER = { header: "Authorization", value: "Bearer s3cret-token" };
const API_KEY = { header: "X-Api-Key", value: "k-123" };

const stored = (settings: MemorySettings) =>
	JSON.parse(settings.values.get(CREDENTIALS_SETTING)?.value as string) as unknown;

describe("credentials", () => {
	it("stores credentials as one JSON setting and returns names and headers only", async () => {
		const settings = new MemorySettings();
		expect(await setCredential(settings, "supplier", BEARER)).toEqual({
			name: "supplier",
			header: "Authorization",
		});
		expect(await setCredential(settings, "partner-api", API_KEY)).toEqual({
			name: "partner-api",
			header: "X-Api-Key",
		});
		expect(await listCredentials(settings)).toEqual([
			{ name: "partner-api", header: "X-Api-Key" },
			{ name: "supplier", header: "Authorization" },
		]);
		expect(JSON.stringify(await listCredentials(settings))).not.toContain("s3cret");
		expect(stored(settings)).toEqual({ supplier: BEARER, "partner-api": API_KEY });
	});

	it("replaces a credential with the same name", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "supplier", BEARER);
		await setCredential(settings, "supplier", API_KEY);
		expect(await getCredential(settings, "supplier")).toEqual(API_KEY);
		expect(await listCredentials(settings)).toEqual([{ name: "supplier", header: "X-Api-Key" }]);
	});

	it("deletes a credential, and answers NOT_FOUND for an unknown one", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "supplier", BEARER);
		expect(await deleteCredential(settings, "supplier")).toEqual({ deleted: true });
		expect(await getCredential(settings, "supplier")).toBeNull();
		await expect(deleteCredential(settings, "supplier")).rejects.toEqual(
			new ServiceError("NOT_FOUND", 'Credential "supplier" not found', 404),
		);
	});

	it("reads no credentials before the first one is set", async () => {
		const settings = new MemorySettings();
		expect(await listCredentials(settings)).toEqual([]);
		expect(await getCredential(settings, "x")).toBeNull();
	});

	it("reads a value that is not the credentials JSON as none, and replaces it on the next set", async () => {
		const settings = new MemorySettings();
		for (const value of ["not json", "[1,2]", '"text"', '{"a": {"header": 1}}']) {
			settings.put(CREDENTIALS_SETTING, value);
			expect(await listCredentials(settings)).toEqual([]);
		}
		await setCredential(settings, "supplier", BEARER);
		expect(stored(settings)).toEqual({ supplier: BEARER });
	});

	it("retries when another writer changes the setting between read and write", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "first", BEARER);
		let concurrent = true;
		settings.beforeWrite = () => {
			if (!concurrent) return;
			concurrent = false;
			const current = JSON.parse(settings.values.get(CREDENTIALS_SETTING)!.value as string);
			settings.put(CREDENTIALS_SETTING, JSON.stringify({ ...current, other: API_KEY }));
		};
		await setCredential(settings, "second", API_KEY);
		expect(Object.keys(stored(settings) as object).sort()).toEqual(["first", "other", "second"]);
	});

	it("gives up with CONFLICT after five lost races", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => settings.put(CREDENTIALS_SETTING, "{}");
		await expect(setCredential(settings, "x", BEARER)).rejects.toEqual(
			new ServiceError("CONFLICT", "The credentials changed during the update; try again", 409),
		);
	});

	it("reports a missing encryption key as CREDENTIALS_UNAVAILABLE without the value", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => {
			throw Object.assign(new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY"), {
				code: "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING",
			});
		};
		const error = await setCredential(settings, "supplier", BEARER).catch((e: unknown) => e);
		expect(error).toEqual(
			new ServiceError(
				"CREDENTIALS_UNAVAILABLE",
				"Credentials are unavailable: Plugin secret settings require EMDASH_ENCRYPTION_KEY",
				500,
			),
		);
		expect(JSON.stringify(error)).not.toContain("s3cret");
		expect((error as Error).message).not.toContain("s3cret");
	});

	it("passes other errors through", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => {
			throw new Error("disk full");
		};
		await expect(setCredential(settings, "supplier", BEARER)).rejects.toThrow("disk full");
	});
});
```

In `packages/flux-import/tests/unit/fakes.ts`, replace
```ts
import type { EngineDeps, Job, LinkRow, RecordRow } from "../../src/engine/types.js";
```
with:
```ts
import type { EngineDeps, Job, LinkRow, RecordRow } from "../../src/engine/types.js";
import type { CredentialSettings } from "../../src/plugin/credentials.js";
```
then replace
```ts
		return start + limit < keys.length ? { files, nextCursor: String(start + limit) } : { files };
	}
}
```
with:
```ts
		return start + limit < keys.length ? { files, nextCursor: String(start + limit) } : { files };
	}
}

/**
 * `ctx.settings` for the credential functions: versioned values with compare-and-set, like
 * EmDash's options table. EmDash encrypts `secret` fields inside `set`/`compareAndSet`; this fake
 * stores what it is given.
 */
export class MemorySettings implements CredentialSettings {
	readonly values = new Map<string, { value: unknown; revision: number }>();
	private rev = 0;
	/** Called before each compareAndSet; use it to simulate a concurrent writer or a failure. */
	beforeWrite: () => void = () => {};

	async getVersioned<T>(key: string) {
		const row = this.values.get(key);
		return row ? { value: structuredClone(row.value) as T, revision: String(row.revision) } : null;
	}

	async compareAndSet(key: string, expected: string | null, value: unknown) {
		this.beforeWrite();
		const row = this.values.get(key);
		if ((row ? String(row.revision) : null) !== expected) return { applied: false as const };
		this.values.set(key, { value: structuredClone(value), revision: ++this.rev });
		return { applied: true as const, revision: String(this.rev) };
	}

	/** Writes a value directly, as the admin settings page would. */
	put(key: string, value: unknown) {
		this.values.set(key, { value, revision: ++this.rev });
	}
}
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
import type { RouteContext } from "emdash";
```
with:
```ts
import { z } from "astro/zod";
import type { RouteContext } from "emdash";
```
then replace
```ts
	"sources/paste",
```
with:
```ts
	"sources/paste",
	"credentials/set",
	"credentials/delete",
	"credentials/list",
```
then replace
```ts
			min: 0,
		});
```
with:
```ts
			min: 0,
		});
		expect(plugin.admin.settingsSchema?.credentials).toMatchObject({ type: "secret" });
```
then replace
```ts
	it("accepts and rejects the same source blocks as the template schema", () => {
```
with:
```ts
	it("validates credential input", () => {
		const set = plugin.routes["credentials/set"]!.input!;
		const ok = { name: "supplier-1", header: "Authorization", value: "Bearer abc" };
		expect(set.safeParse(ok).success).toBe(true);
		expect(set.safeParse({ ...ok, header: "X-Api-Key" }).success).toBe(true);
		for (const name of ["", "Supplier", "a_b", "a".repeat(65)]) {
			expect(set.safeParse({ ...ok, name }).success, name).toBe(false);
		}
		for (const header of [
			"Host",
			"cookie",
			"Content-Length",
			"Transfer-Encoding",
			"Connection",
			"Keep-Alive",
			"Upgrade",
			"TE",
			"Proxy-Authorization",
			"If-None-Match",
			"Bad Header",
			"X:Y",
			"",
		]) {
			expect(set.safeParse({ ...ok, header }).success, header).toBe(false);
		}
		for (const value of ["", "a\r\nX-Injected: 1", "line\nbreak", "a".repeat(4097), "tab\u0000"]) {
			expect(set.safeParse({ ...ok, value }).success, JSON.stringify(value)).toBe(false);
		}
		expect(set.safeParse({ ...ok, value: "a".repeat(4096) }).success).toBe(true);
	});

	it("never echoes a credential value in a validation error", () => {
		const set = plugin.routes["credentials/set"]!.input!;
		const result = set.safeParse({
			name: "supplier",
			header: "Authorization",
			value: "Bearer top-secret\n",
		});
		expect(result.success).toBe(false);
		// EmDash answers an invalid body with z.formatError(error) (emdash src/plugins/routes.ts:247-257).
		const body = JSON.stringify(z.formatError(result.error!));
		expect(body).toContain("printable ASCII");
		expect(body).not.toContain("top-secret");
	});

	it("accepts and rejects the same source blocks as the template schema", () => {
```


- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/credentials.test.ts tests/unit/definition.test.ts`
Expected: FAIL — `credentials.test.ts` cannot load `../../src/plugin/credentials.js`; in `definition.test.ts` "declares every API route with import:execute", "has the retention setting, …", "validates credential input" and "never echoes a credential value in a validation error" fail (no credential routes or setting yet).

- [ ] **Step 3: Implement the store**

Create `packages/flux-import/src/plugin/credentials.ts`:
```ts
import type { PluginContext } from "emdash";
import { emdashErrorCode } from "../emdash/errors.js";
import type { Credential } from "../sources/fetcher.js";
import { ServiceError } from "./service.js";

/**
 * Named credentials live as one JSON object in the `credentials` setting, declared
 * `type: "secret"` so EmDash stores it encrypted (AES-GCM, `EMDASH_ENCRYPTION_KEY`; Fact S1).
 * Nothing here returns a value to a caller outside the fetcher.
 */
export const CREDENTIALS_SETTING = "credentials";
export const CREDENTIAL_NAME = /^[a-z0-9-]{1,64}$/;
/** An HTTP token (RFC 9110 section 5.6.2). */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;
/** Printable ASCII, space and tab: no CR, LF or other control characters. */
export const HEADER_VALUE = /^[\t\x20-\x7e]{1,4096}$/;
/** Headers a credential may not set: framing, hop-by-hop, and the ones the fetcher owns. */
export const FORBIDDEN_HEADERS = new Set([
	"host",
	"cookie",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"upgrade",
	"if-none-match",
	"if-modified-since",
]);

const CAS_ATTEMPTS = 5;

export type CredentialSettings = Pick<PluginContext["settings"], "getVersioned" | "compareAndSet">;

export interface CredentialInfo {
	name: string;
	header: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the stored JSON. A value that is not that JSON (the admin settings page can overwrite
 * the field with any text) reads as no credentials, so the next `credentials/set` replaces it.
 */
function parse(value: unknown): Map<string, Credential> {
	const out = new Map<string, Credential>();
	if (typeof value !== "string") return out;
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return out;
	}
	if (!isRecord(data)) return out;
	for (const [name, entry] of Object.entries(data)) {
		if (isRecord(entry) && typeof entry.header === "string" && typeof entry.value === "string") {
			out.set(name, { header: entry.header, value: entry.value });
		}
	}
	return out;
}

/** EmDash's encryption errors (a missing or malformed key) become a 500 without the value. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		const code = emdashErrorCode(e) ?? "";
		if (code.startsWith("PLUGIN_SETTING_") || code === "INVALID_ENCRYPTION_KEY") {
			const message = e instanceof Error ? e.message : code;
			throw new ServiceError(
				"CREDENTIALS_UNAVAILABLE",
				`Credentials are unavailable: ${message}`,
				500,
			);
		}
		throw e;
	}
}

async function read(
	settings: CredentialSettings,
): Promise<{ credentials: Map<string, Credential>; revision: string | null }> {
	const current = await guarded(() => settings.getVersioned<string>(CREDENTIALS_SETTING));
	return { credentials: parse(current?.value), revision: current?.revision ?? null };
}

async function update(
	settings: CredentialSettings,
	change: (credentials: Map<string, Credential>) => void,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const { credentials, revision } = await read(settings);
		change(credentials);
		const value = JSON.stringify(Object.fromEntries(credentials));
		const result = await guarded(() =>
			settings.compareAndSet(CREDENTIALS_SETTING, revision, value),
		);
		if (result.applied) return;
	}
	throw new ServiceError("CONFLICT", "The credentials changed during the update; try again", 409);
}

/** Adds or replaces a credential. Returns its name and header, never its value. */
export async function setCredential(
	settings: CredentialSettings,
	name: string,
	credential: Credential,
): Promise<CredentialInfo> {
	await update(settings, (credentials) => {
		credentials.set(name, { header: credential.header, value: credential.value });
	});
	return { name, header: credential.header };
}

export async function deleteCredential(
	settings: CredentialSettings,
	name: string,
): Promise<{ deleted: true }> {
	let found = false;
	await update(settings, (credentials) => {
		found = credentials.delete(name);
	});
	if (!found) throw new ServiceError("NOT_FOUND", `Credential "${name}" not found`, 404);
	return { deleted: true };
}

export async function listCredentials(settings: CredentialSettings): Promise<CredentialInfo[]> {
	const { credentials } = await read(settings);
	return [...credentials.entries()]
		.map(([name, { header }]) => ({ name, header }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The credential with its value, for the fetcher only; `null` when there is none. */
export async function getCredential(
	settings: CredentialSettings,
	name: string,
): Promise<Credential | null> {
	return (await read(settings)).credentials.get(name) ?? null;
}
```

- [ ] **Step 4: Declare the setting and the routes**

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
			settingsSchema: {
				retentionDays: {
```
with:
```ts
			settingsSchema: {
				credentials: {
					type: "secret",
					label: "URL source credentials",
					description:
						"Managed through the credentials routes (one encrypted JSON object). Saving other text here removes every credential.",
				},
				retentionDays: {
```

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { SOURCE_FORMATS } from "../sources/reader.js";
```
with:
```ts
import { SOURCE_FORMATS } from "../sources/reader.js";
import {
	CREDENTIAL_NAME,
	deleteCredential,
	FORBIDDEN_HEADERS,
	HEADER_NAME,
	HEADER_VALUE,
	listCredentials,
	setCredential,
} from "./credentials.js";
```
then replace
```ts
const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
```
with:
```ts
const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
const credentialName = z
	.string()
	.regex(CREDENTIAL_NAME, "Credential names are 1-64 characters from a-z, 0-9 and -");
const headerName = z
	.string()
	.regex(HEADER_NAME, "The header must be a valid HTTP header name")
	.refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), "This header cannot hold a credential");
const headerValue = z
	.string()
	.regex(HEADER_VALUE, "Header values are 1-4,096 printable ASCII characters, without CR or LF");
```
then replace
```ts
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},

```
with:
```ts
		request: { body: "json", maxBytes: PASTE_MAX_BYTES },
	},

	"credentials/set": route(
		z.object({ name: credentialName, header: headerName, value: headerValue }),
		(ctx) =>
			withServices(ctx, () =>
				setCredential(ctx.settings, ctx.input.name, {
					header: ctx.input.header,
					value: ctx.input.value,
				}),
			),
	),

	"credentials/delete": route(z.object({ name: credentialName }), (ctx) =>
		withServices(ctx, () => deleteCredential(ctx.settings, ctx.input.name)),
	),

	"credentials/list": route(z.object({}), (ctx) =>
		withServices(ctx, () => listCredentials(ctx.settings)),
	),

```


- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/credentials.test.ts tests/unit/definition.test.ts`
Expected: PASS (9 tests in `credentials.test.ts`, 10 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 30 files / 741 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/src/plugin/credentials.ts packages/flux-import/src/plugin/definition.ts packages/flux-import/src/plugin/routes.ts packages/flux-import/tests/unit/credentials.test.ts packages/flux-import/tests/unit/definition.test.ts packages/flux-import/tests/unit/fakes.ts
git commit -m "Keep URL source credentials in an encrypted plugin setting behind routes that never return values"
```

### Task 4: Sources, `sources/fetch`, `jobs/create` with `sourceId`, and retention

**Files:**
- Create: `packages/flux-import/src/plugin/sources.ts`
- Modify: `packages/flux-import/src/plugin/service.ts`, `packages/flux-import/src/plugin/retention.ts`, `packages/flux-import/src/plugin/routes.ts`, `packages/flux-import/src/plugin/definition.ts`
- Test: `packages/flux-import/tests/unit/sources.test.ts` (new), `packages/flux-import/tests/unit/service.test.ts`, `packages/flux-import/tests/unit/retention.test.ts`, `packages/flux-import/tests/unit/definition.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseSourceUrl`, `checkHost`, `defaultResolver`, `NetOptions`, `UrlSourceError`), Task 2 (`downloadSource`, `FETCH_LIMITS`, `LastFetch`, `EmDashUploads.exists`), Task 3 (`getCredential`, `CredentialSettings`); `kvCollection` (`src/emdash/storage.ts`); `startJob`, `uploadNeeded`, `ServiceError` (`src/plugin/service.ts`); `maxSourceBytes()`, `allowPrivateNetwork()` (`src/astro/config.ts`); `onWorkers()`; `MemoryKv`, `FakeStorage`, `MemorySettings` (tests).
- Produces (`src/plugin/sources.ts`):
  - `interface SourceRow { id; name; url; credential?; lastFetch?: LastFetch; lastError?: { at; code; message }; lastImport?: LastImport; createdAt; updatedAt }` (spec "Storage"); `interface LastImport { sha256: string; uploadId: string; jobId: string; at: string }`
  - `interface SourceDeps { sources: KvCollection<SourceRow>; jobs: KvCollection<Job>; settings: CredentialSettings; storage: UploadStorage; net: NetOptions; limits: FetchLimits; workers: boolean; now: () => number; newId: () => string }`
  - `sourcesCollection(storage): KvCollection<SourceRow>`; `createSource(deps, { name, url, credential? }): Promise<SourceRow>`; `updateSource(deps, { id, name?, url?, credential?: string | null }): Promise<SourceRow>`; `deleteSource(deps, id): Promise<{ deleted: true }>`; `getSource(deps, id): Promise<SourceRow>`; `listSources(deps, cursor?): Promise<Page<SourceRow>>`
  - `fetchSource(deps, id, force = false): Promise<FetchOutcome>` with `FetchOutcome = { changed: boolean; uploadId: string; bytes: number; sha256: string }`
  - `jobFromSource(deps, sourceId, options: { force: boolean; dryRun: boolean }, create: (uploadId: string) => Promise<Job>): Promise<Job | SkippedJob>` with `SkippedJob = { skipped: "unchanged"; sourceId: string; uploadId: string }`; skips only a real run without `force` whose fetched SHA-256 equals `lastImport.sha256`, and records `lastImport` after a real job is created
  - `latestSourceUploads(sources: KvCollection<SourceRow>): Promise<Set<string>>`
- Produces (`src/plugin/service.ts`): `uploadInUse(jobs, uploadId, exceptJobId?): Promise<boolean>`; `type UploadKeeper = (uploadId: string) => Promise<boolean>`; `releaseUploadIfUnused`, `nextBatch` and `changeJob` take an optional last `keep: UploadKeeper`; `page` is exported. (`src/plugin/retention.ts`) `purgeExpired(deps, uploads, retentionDays, keepUploads?: ReadonlySet<string>)`.
- Produces (routes): `sources/create|update|delete|get|list|fetch`; `jobs/create` takes `uploadId` or `sourceId` (exactly one) and `force?`; storage collection `sources` (indexes `name`, `createdAt`).

- [ ] **Step 1: Write the failing tests**

The `jobFromSource` tests pin the controller ruling: a real run of content already imported is skipped, a dry run never is and never counts, and a failed creation records nothing.

Create `packages/flux-import/tests/unit/sources.test.ts`:
```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmDashUploads, uploadKey } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import { setCredential } from "../../src/plugin/credentials.js";
import { ServiceError } from "../../src/plugin/service.js";
import {
	createSource,
	deleteSource,
	fetchSource,
	getSource,
	jobFromSource,
	latestSourceUploads,
	listSources,
	type SourceDeps,
	type SourceRow,
	updateSource,
} from "../../src/plugin/sources.js";
import { FakeStorage, MemoryKv, MemorySettings } from "./fakes.js";

const FEED = "https://feeds.example.com/products.csv";
const BODY = "sku,Name\nA,One\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Handler = (headers: Headers) => Response;

function setup(opts: { allowPrivateNetwork?: boolean } = {}) {
	const clock = { t: Date.parse("2026-10-26T09:00:00Z") };
	let next = 0;
	const routes = new Map<string, Handler>();
	const sent: Array<{ url: string; headers: Record<string, string> }> = [];
	const storage = new FakeStorage();
	const deps: SourceDeps = {
		sources: new MemoryKv<SourceRow>(),
		jobs: new MemoryKv<Job>(),
		settings: new MemorySettings(),
		storage,
		net: {
			allowPrivateNetwork: opts.allowPrivateNetwork ?? false,
			resolver: async () => ["93.184.215.14"],
			fetch: async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				sent.push({ url, headers: Object.fromEntries(headers.entries()) });
				const handler = routes.get(url);
				return handler ? handler(headers) : new Response("missing", { status: 404 });
			},
		},
		limits: { maxBytes: 10_000, headersMs: 15_000, totalMs: 120_000, bufferBytes: 5_000 },
		workers: false,
		now: () => clock.t,
		newId: () => `S${++next}`,
	};
	const files = () => [...storage.files.keys()].sort();
	return { deps, routes, sent, clock, storage, files };
}

/** Serves `body` with an ETag and answers a matching If-None-Match with 304. */
function etagged(body: () => string): Handler {
	return (headers) => {
		const tag = `"${sha(body()).slice(0, 8)}"`;
		if (headers.get("if-none-match") === tag) return new Response(null, { status: 304 });
		return new Response(body(), { headers: { etag: tag } });
	};
}

function jobUsing(uploadId: string, status: Job["status"] = "running"): Job {
	return { id: `J-${uploadId.slice(0, 4)}`, uploadId, status, dryRun: false } as unknown as Job;
}

describe("source records", () => {
	it("creates a source with a normalised URL and timestamps", async () => {
		const { deps } = setup();
		const row = await createSource(deps, {
			name: "Supplier",
			url: "HTTPS://Feeds.Example.com/p.csv",
		});
		expect(row).toEqual({
			id: "S1",
			name: "Supplier",
			url: "https://feeds.example.com/p.csv",
			createdAt: "2026-10-26T09:00:00.000Z",
			updatedAt: "2026-10-26T09:00:00.000Z",
		});
		expect(await getSource(deps, "S1")).toEqual(row);
	});

	it("refuses a duplicate name, an unknown credential and a blocked URL", async () => {
		const { deps } = setup();
		await createSource(deps, { name: "Supplier", url: FEED });
		await expect(createSource(deps, { name: "Supplier", url: FEED })).rejects.toEqual(
			new ServiceError("CONFLICT", 'A source named "Supplier" already exists', 409),
		);
		await expect(createSource(deps, { name: "B", url: FEED, credential: "nope" })).rejects.toEqual(
			new ServiceError("NOT_FOUND", 'Credential "nope" not found', 404),
		);
		for (const url of ["http://localhost:8080/feed", "http://10.1.2.3/x", "ftp://example.com/x"]) {
			await expect(createSource(deps, { name: url, url })).rejects.toMatchObject({
				code: "URL_BLOCKED",
				status: 400,
			});
		}
		await expect(
			createSource(deps, { name: "u", url: "https://user:pw@example.com/" }),
		).rejects.toMatchObject({ code: "URL_BLOCKED" });
	});

	it("accepts private hosts when private networks are allowed, but not other schemes", async () => {
		const { deps } = setup({ allowPrivateNetwork: true });
		expect((await createSource(deps, { name: "local", url: "http://127.0.0.1:4500/f" })).url).toBe(
			"http://127.0.0.1:4500/f",
		);
		await expect(
			createSource(deps, { name: "f", url: "file:///etc/passwd" }),
		).rejects.toMatchObject({ code: "URL_BLOCKED" });
	});

	it("updates the name, URL and credential, clearing lastFetch only when URL or credential change", async () => {
		const { deps, routes, clock } = setup();
		routes.set(FEED, () => new Response(BODY));
		await setCredential(deps.settings, "supplier", { header: "X-Key", value: "k" });
		await createSource(deps, { name: "A", url: FEED });
		await createSource(deps, { name: "B", url: "https://b.example.com/" });
		await fetchSource(deps, "S1");
		clock.t += 1000;

		const renamed = await updateSource(deps, { id: "S1", name: "A2" });
		expect(renamed).toMatchObject({ name: "A2", url: FEED, updatedAt: "2026-10-26T09:00:01.000Z" });
		expect(renamed.lastFetch).toBeDefined();
		expect((await updateSource(deps, { id: "S1", url: FEED })).lastFetch).toBeDefined();
		await expect(updateSource(deps, { id: "S1", name: "B" })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(updateSource(deps, { id: "S1", credential: "nope" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const withCredential = await updateSource(deps, { id: "S1", credential: "supplier" });
		expect(withCredential.credential).toBe("supplier");
		expect(withCredential.lastFetch).toBeUndefined();

		await fetchSource(deps, "S1");
		const moved = await updateSource(deps, { id: "S1", url: "https://feeds.example.com/v2.csv" });
		expect(moved.lastFetch).toBeUndefined();
		const cleared = await updateSource(deps, { id: "S1", credential: null });
		expect(cleared).not.toHaveProperty("credential");
		await expect(updateSource(deps, { id: "nope" })).rejects.toMatchObject({
			code: "NOT_FOUND",
			status: 404,
		});
	});

	it("lists sources newest first, a page at a time", async () => {
		const { deps, clock } = setup();
		for (let i = 0; i < 52; i++) {
			clock.t += 1000;
			await createSource(deps, { name: `S${i}`, url: FEED });
		}
		const first = await listSources(deps);
		expect(first.items).toHaveLength(50);
		expect(first.items[0]?.name).toBe("S51");
		expect(first.hasMore).toBe(true);
		const second = await listSources(deps, first.cursor);
		expect(second.items.map((s) => s.name)).toEqual(["S1", "S0"]);
	});

	it("deletes a source with its latest staged file unless a job still reads it", async () => {
		const { deps, routes, files } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		await createSource(deps, { name: "B", url: FEED });
		const a = await fetchSource(deps, "S1");
		const b = await fetchSource(deps, "S2");
		await deps.jobs.put("J1", jobUsing(b.uploadId));

		expect(await deleteSource(deps, "S1")).toEqual({ deleted: true });
		expect(await deleteSource(deps, "S2")).toEqual({ deleted: true });
		expect(files()).toEqual([uploadKey(b.uploadId)]);
		expect(a.uploadId).not.toBe(b.uploadId);
		await expect(getSource(deps, "S1")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(deleteSource(deps, "S1")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("fetchSource", () => {
	it("stages the feed with the credential and saves lastFetch", async () => {
		const { deps, routes, sent, files } = setup();
		routes.set(FEED, () => new Response(BODY, { headers: { etag: '"1"' } }));
		await setCredential(deps.settings, "supplier", { header: "Authorization", value: "Bearer t" });
		await createSource(deps, { name: "A", url: FEED, credential: "supplier" });
		const result = await fetchSource(deps, "S1");
		expect(result).toEqual({
			changed: true,
			uploadId: expect.any(String),
			bytes: BODY.length,
			sha256: sha(BODY),
		});
		expect(sent[0]?.headers).toEqual({ authorization: "Bearer t" });
		expect((await getSource(deps, "S1")).lastFetch).toEqual({
			at: "2026-10-26T09:00:00.000Z",
			status: 200,
			etag: '"1"',
			sha256: sha(BODY),
			bytes: BODY.length,
			uploadId: result.uploadId,
		});
		expect(files()).toEqual([uploadKey(result.uploadId)]);
	});

	it("reports unchanged through a 304 and through the hash, reusing the staged file", async () => {
		const { deps, routes, sent, files } = setup();
		let body = BODY;
		routes.set(
			FEED,
			etagged(() => body),
		);
		routes.set("https://plain.example.com/f.csv", () => new Response(body));
		await createSource(deps, { name: "etag", url: FEED });
		await createSource(deps, { name: "plain", url: "https://plain.example.com/f.csv" });

		const first = await fetchSource(deps, "S1");
		const again = await fetchSource(deps, "S1");
		expect(again).toEqual({ ...first, changed: false });
		expect(sent[1]?.headers["if-none-match"]).toBeDefined();
		expect((await getSource(deps, "S1")).lastFetch?.status).toBe(304);

		const plain = await fetchSource(deps, "S2");
		expect(await fetchSource(deps, "S2")).toEqual({ ...plain, changed: false });
		expect(files()).toEqual([uploadKey(first.uploadId), uploadKey(plain.uploadId)].sort());

		body = `${BODY}B,Two\n`;
		const changed = await fetchSource(deps, "S1");
		expect(changed.changed).toBe(true);
		// The replaced file is deleted: no job reads it.
		expect(await new EmDashUploads(deps.storage).exists(first.uploadId)).toBe(false);
	});

	it("keeps the replaced file while a job still reads it", async () => {
		const { deps, routes } = setup();
		let body = BODY;
		routes.set(FEED, () => new Response(body));
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		await deps.jobs.put("J1", jobUsing(first.uploadId, "paused"));
		body = `${BODY}B,Two\n`;
		await fetchSource(deps, "S1");
		expect(await new EmDashUploads(deps.storage).exists(first.uploadId)).toBe(true);
	});

	it("with force fetches again and reports changed", async () => {
		const { deps, routes, sent } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		const forced = await fetchSource(deps, "S1", true);
		expect(sent[1]?.headers).toEqual({});
		expect(forced.changed).toBe(true);
		expect(forced.uploadId).not.toBe(first.uploadId);
	});

	it("saves a failure as lastError, keeps lastFetch, and clears the error on the next success", async () => {
		const { deps, routes, clock } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const first = await fetchSource(deps, "S1");
		routes.set(FEED, () => new Response("gone", { status: 404 }));
		clock.t += 60_000;
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("HTTP_ERROR", "The server answered HTTP 404", 502),
		);
		const failed = await getSource(deps, "S1");
		expect(failed.lastError).toEqual({
			at: "2026-10-26T09:01:00.000Z",
			code: "HTTP_ERROR",
			message: "The server answered HTTP 404",
		});
		expect(failed.lastFetch?.uploadId).toBe(first.uploadId);

		routes.set(FEED, () => new Response(BODY));
		await fetchSource(deps, "S1");
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastError");
	});

	it("fails with CREDENTIAL_MISSING once the named credential is deleted", async () => {
		const { deps, routes, sent } = setup();
		routes.set(FEED, () => new Response(BODY));
		await setCredential(deps.settings, "supplier", { header: "X-Key", value: "k" });
		await createSource(deps, { name: "A", url: FEED, credential: "supplier" });
		deps.settings = new MemorySettings();
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("CREDENTIAL_MISSING", 'Credential "supplier" does not exist', 409),
		);
		expect((await getSource(deps, "S1")).lastError?.code).toBe("CREDENTIAL_MISSING");
		expect(sent).toEqual([]);
	});

	it("maps each fetch failure to its code and status", async () => {
		const { deps, routes } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => new Response("x".repeat(10_001)));
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({ code: "TOO_LARGE", status: 413 });
		deps.net.resolver = async () => ["192.168.0.10"];
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({
			code: "URL_BLOCKED",
			status: 400,
		});
		deps.net.resolver = async () => {
			throw new Error("ENOTFOUND");
		};
		await expect(fetchSource(deps, "S1")).rejects.toMatchObject({
			code: "FETCH_FAILED",
			status: 502,
		});
		await expect(fetchSource(deps, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("does not resurrect a source deleted during the fetch, and drops the new file", async () => {
		const { deps, routes, files } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => {
			void deps.sources.delete("S1");
			return new Response(BODY);
		});
		await expect(fetchSource(deps, "S1")).rejects.toEqual(
			new ServiceError("CONFLICT", "The source was deleted or reconfigured during the fetch", 409),
		);
		expect(await deps.sources.get("S1")).toBeNull();
		expect(files()).toEqual([]);
	});

	it("keeps a concurrent rename made during the fetch", async () => {
		const { deps, routes } = setup();
		await createSource(deps, { name: "A", url: FEED });
		routes.set(FEED, () => {
			void updateSource(deps, { id: "S1", name: "Renamed" });
			return new Response(BODY);
		});
		await fetchSource(deps, "S1");
		expect(await getSource(deps, "S1")).toMatchObject({
			name: "Renamed",
			lastFetch: { sha256: sha(BODY) },
		});
	});
});

describe("jobFromSource", () => {
	const REAL = { force: false, dryRun: false };
	const DRY = { force: false, dryRun: true };

	function creator() {
		const created: string[] = [];
		let failNext = false;
		const create = async (uploadId: string) => {
			if (failNext) {
				failNext = false;
				throw new Error("invalid template");
			}
			created.push(uploadId);
			return { ...jobUsing(uploadId, "created"), id: `J${created.length}` };
		};
		return { created, create, failOnce: () => (failNext = true) };
	}

	it("skips a real run of content already imported, and forces one", async () => {
		const { deps, routes } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const { created, create } = creator();

		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J1" });
		expect((await getSource(deps, "S1")).lastImport).toEqual({
			sha256: sha(BODY),
			uploadId: created[0],
			jobId: "J1",
			at: "2026-10-26T09:00:00.000Z",
		});
		expect(await jobFromSource(deps, "S1", REAL, create)).toEqual({
			skipped: "unchanged",
			sourceId: "S1",
			uploadId: created[0],
		});
		const forced = await jobFromSource(deps, "S1", { force: true, dryRun: false }, create);
		expect(forced).toMatchObject({ id: "J2" });
		expect(created[1]).not.toBe(created[0]);
		expect((await getSource(deps, "S1")).lastImport?.jobId).toBe("J2");
	});

	it("never skips a dry run, and a dry run does not count as an import", async () => {
		const { deps, routes } = setup();
		routes.set(
			FEED,
			etagged(() => BODY),
		);
		await createSource(deps, { name: "A", url: FEED });
		const { created, create } = creator();

		expect(await jobFromSource(deps, "S1", DRY, create)).toMatchObject({ id: "J1" });
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastImport");
		// The fetch answers 304 now, yet the first real run is created without force.
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J2" });
		expect(await jobFromSource(deps, "S1", DRY, create)).toMatchObject({ id: "J3" });
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ skipped: "unchanged" });
		expect(created).toHaveLength(3);
	});

	it("records nothing when job creation fails, so the retry creates the job", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { create, failOnce } = creator();
		failOnce();
		await expect(jobFromSource(deps, "S1", REAL, create)).rejects.toThrow("invalid template");
		expect(await getSource(deps, "S1")).not.toHaveProperty("lastImport");
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J1" });
	});

	it("forgets the last import when the URL changes", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		routes.set("https://mirror.example.com/p.csv", () => new Response(BODY));
		await createSource(deps, { name: "A", url: FEED });
		const { create } = creator();
		await jobFromSource(deps, "S1", REAL, create);
		expect((await updateSource(deps, { id: "S1", name: "B" })).lastImport).toBeDefined();
		const moved = await updateSource(deps, { id: "S1", url: "https://mirror.example.com/p.csv" });
		expect(moved).not.toHaveProperty("lastImport");
		expect(await jobFromSource(deps, "S1", REAL, create)).toMatchObject({ id: "J2" });
	});
});

describe("latestSourceUploads", () => {
	it("lists the latest staged file of every source that has one", async () => {
		const { deps, routes } = setup();
		routes.set(FEED, () => new Response(BODY));
		for (let i = 0; i < 3; i++) await createSource(deps, { name: `S${i}`, url: FEED });
		const a = await fetchSource(deps, "S1");
		const b = await fetchSource(deps, "S3");
		expect(await latestSourceUploads(deps.sources)).toEqual(new Set([a.uploadId, b.uploadId]));
	});
});
```

In `packages/flux-import/tests/unit/service.test.ts`, replace
```ts
	it("knows which states still need the file", () => {
```
with:
```ts
	it("keeps a file that a URL source still names as its latest fetch", async () => {
		const { deps } = makeDeps();
		const uploads = new Uploads();
		deps.source.add("u1", csv(2));
		const keep = async (uploadId: string) => uploadId === "u1";
		const job = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		expect((await nextBatch(deps, uploads, job.id, "h", keep)).status).toBe("completed");
		const other = await startJob(deps, { uploadId: "u1", template, dryRun: false }, fields);
		const cancelled = await changeJob(deps, uploads, other.id, "cancel", keep);
		expect(uploads.deleted).toEqual([]);
		// Without the keeper (the source was deleted), the same release deletes the file.
		expect(await releaseUploadIfUnused(deps, uploads, cancelled)).toBe(true);
		expect(uploads.deleted).toEqual(["u1"]);
	});

	it("knows which states still need the file", () => {
```

In `packages/flux-import/tests/unit/retention.test.ts`, replace
```ts
	it("leaves a job with a live lease for the next run", async () => {
```
with:
```ts
	it("keeps the staged files it is told to keep, such as each source's latest fetch", async () => {
		const { deps } = makeDeps();
		const purger = new Purger();
		await purgeExpired(deps, purger, 30, new Set(["latest-1", "latest-2"]));
		expect(purger.keeps[0]).toEqual(new Set(["latest-1", "latest-2"]));
	});

	it("leaves a job with a live lease for the next run", async () => {
```

In `packages/flux-import/tests/unit/definition.test.ts`, replace
```ts
	"sources/paste",
```
with:
```ts
	"sources/paste",
	"sources/create",
	"sources/update",
	"sources/delete",
	"sources/get",
	"sources/list",
	"sources/fetch",
```
then replace
```ts
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
```
with:
```ts
		expect(STORAGE.links.indexes).toEqual(["entryId"]);
		expect(STORAGE.sources.indexes).toEqual(["name", "createdAt"]);
```
then replace
```ts
	it("validates credential input", () => {
```
with:
```ts
	it("takes exactly one of uploadId and sourceId in jobs/create", () => {
		const create = plugin.routes["jobs/create"]!.input!;
		const base = { template: {}, dryRun: false };
		expect(create.safeParse({ ...base, uploadId: UPLOAD_ID }).success).toBe(true);
		expect(create.safeParse({ ...base, sourceId: "01JZSRC", force: true }).success).toBe(true);
		expect(create.safeParse({ ...base }).success).toBe(false);
		expect(create.safeParse({ ...base, uploadId: UPLOAD_ID, sourceId: "01JZSRC" }).success).toBe(
			false,
		);
		expect(create.safeParse({ ...base, sourceId: "a/b" }).success).toBe(false);
	});

	it("validates source input", () => {
		const createSource = plugin.routes["sources/create"]!.input!;
		expect(createSource.safeParse({ name: "Feed", url: "https://x.example/f.csv" }).success).toBe(
			true,
		);
		expect(createSource.safeParse({ name: "", url: "https://x.example/" }).success).toBe(false);
		expect(createSource.safeParse({ name: "x".repeat(101), url: "https://x/" }).success).toBe(
			false,
		);
		expect(
			createSource.safeParse({ name: "Feed", url: `https://x.example/${"a".repeat(2048)}` })
				.success,
		).toBe(false);
		expect(
			createSource.safeParse({ name: "Feed", url: "https://x/", credential: "Bad Name" }).success,
		).toBe(false);
		const update = plugin.routes["sources/update"]!.input!;
		expect(update.safeParse({ id: "S1", credential: null }).success).toBe(true);
		expect(update.safeParse({ id: "S1", credential: "supplier" }).success).toBe(true);
	});

	it("validates credential input", () => {
```


- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter flux-import exec vitest run tests/unit/sources.test.ts tests/unit/service.test.ts tests/unit/retention.test.ts tests/unit/definition.test.ts`
Expected: FAIL — `sources.test.ts` cannot load `../../src/plugin/sources.js`; "keeps a file that a URL source still names as its latest fetch" fails (the file is deleted: `nextBatch` ignores the keeper); "keeps the staged files it is told to keep, …" fails (the purge ignores `keepUploads`); in `definition.test.ts` the route list, the storage indexes, "takes exactly one of uploadId and sourceId in jobs/create" and "validates source input" fail.

- [ ] **Step 3: Let the release path and the purge keep files**

In `packages/flux-import/src/plugin/service.ts`, replace
```ts
import { SourceMissingError } from "../engine/ports.js";
```
with:
```ts
import type { KvCollection } from "../engine/ports.js";
import { SourceMissingError } from "../engine/ports.js";
```
then replace
```ts
function page<T>(result: { items: { data: T }[]; cursor?: string; hasMore: boolean }): Page<T> {
```
with:
```ts
export function page<T>(result: {
	items: { data: T }[];
	cursor?: string;
	hasMore: boolean;
}): Page<T> {
```
then replace
```ts
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
```
with:
```ts
/** Whether a job other than `exceptJobId` may still read the staged file. */
export async function uploadInUse(
	jobs: KvCollection<Job>,
	uploadId: string,
	exceptJobId?: string,
): Promise<boolean> {
	let cursor: string | undefined;
	do {
		const result = await jobs.query({
			where: { uploadId },
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		if (result.items.some(({ id, data }) => id !== exceptJobId && uploadNeeded(data))) return true;
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return false;
}

/** Answers whether a staged file must stay although no job needs it (a source's latest fetch). */
export type UploadKeeper = (uploadId: string) => Promise<boolean>;

const keepNone: UploadKeeper = async () => false;

/** Deletes the job's staged file once neither it nor any other job can still read it. */
export async function releaseUploadIfUnused(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
	keep: UploadKeeper = keepNone,
): Promise<boolean> {
	if (uploadNeeded(job)) return false;
	if (await uploadInUse(deps.jobs, job.uploadId, job.id)) return false;
	if (await keep(job.uploadId)) return false;
	await uploads.delete(job.uploadId);
	return true;
}

async function releaseQuietly(
	deps: EngineDeps,
	uploads: UploadStore,
	job: Job,
	keep: UploadKeeper,
): Promise<void> {
	// Best effort: a file left behind here is removed by the retention task.
	await releaseUploadIfUnused(deps, uploads, job, keep).catch(() => false);
}

export async function nextBatch(
	deps: EngineDeps,
	uploads: UploadStore,
	id: string,
	holder: string,
	keep: UploadKeeper = keepNone,
): Promise<Job> {
```
then replace
```ts
	await releaseQuietly(deps, uploads, job);
	return job;
}
```
with:
```ts
	await releaseQuietly(deps, uploads, job, keep);
	return job;
}
```
then replace
```ts
	action: "pause" | "resume" | "cancel" | "retry",
): Promise<Job> {
	const job = await transitionJob(deps, id, action);
	if (action === "cancel") await releaseQuietly(deps, uploads, job);
```
with:
```ts
	action: "pause" | "resume" | "cancel" | "retry",
	keep: UploadKeeper = keepNone,
): Promise<Job> {
	const job = await transitionJob(deps, id, action);
	if (action === "cancel") await releaseQuietly(deps, uploads, job, keep);
```

In `packages/flux-import/src/plugin/retention.ts`, replace
```ts
 * before it. A job with a live lease is left for the next run. Links are kept: they map source
 * keys to entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
): Promise<PurgeResult> {
```
with:
```ts
 * before it, except files in `keepUploads`. A job with a live lease is left for the next run.
 * Links are kept: they map source keys to entries across runs.
 */
export async function purgeExpired(
	deps: Pick<EngineDeps, "jobs" | "records" | "now">,
	uploads: UploadPurger,
	retentionDays: number,
	/** Staged files kept however old they are: each URL source's latest fetch. */
	keepUploads: ReadonlySet<string> = new Set(),
): Promise<PurgeResult> {
```
then replace
```ts
	const keep = new Set<string>();
```
with:
```ts
	const keep = new Set<string>(keepUploads);
```

- [ ] **Step 4: Implement sources**

Create `packages/flux-import/src/plugin/sources.ts`:
```ts
import type { StorageCollection } from "emdash";
import { kvCollection } from "../emdash/storage.js";
import { EmDashUploads, type UploadStorage } from "../emdash/uploads.js";
import type { KvCollection } from "../engine/ports.js";
import type { Job } from "../engine/types.js";
import {
	type DownloadResult,
	downloadSource,
	type FetchLimits,
	type LastFetch,
} from "../sources/fetcher.js";
import {
	checkHost,
	type NetOptions,
	parseSourceUrl,
	UrlSourceError,
	type UrlSourceErrorCode,
} from "../sources/net.js";
import { type CredentialSettings, getCredential } from "./credentials.js";
import { PAGE_SIZE, type Page, page, ServiceError, uploadInUse } from "./service.js";

export interface SourceRow {
	id: string;
	/** 1-100 characters, unique. */
	name: string;
	/** http(s), no userinfo, at most 2,048 characters, stored as `URL.href`. */
	url: string;
	/** A credential name. */
	credential?: string;
	lastFetch?: LastFetch;
	lastError?: { at: string; code: string; message: string };
	/** The content of the last job created (not a dry run) from a fetch of this source. */
	lastImport?: LastImport;
	createdAt: string;
	updatedAt: string;
}

export interface LastImport {
	sha256: string;
	uploadId: string;
	jobId: string;
	at: string;
}

export interface SourceDeps {
	sources: KvCollection<SourceRow>;
	jobs: KvCollection<Job>;
	settings: CredentialSettings;
	storage: UploadStorage;
	net: NetOptions;
	limits: FetchLimits;
	workers: boolean;
	now: () => number;
	newId: () => string;
}

export interface CreateSourceInput {
	name: string;
	url: string;
	credential?: string | undefined;
}

export interface UpdateSourceInput {
	id: string;
	name?: string | undefined;
	url?: string | undefined;
	/** `null` removes the credential. */
	credential?: string | null | undefined;
}

export interface FetchOutcome {
	changed: boolean;
	uploadId: string;
	bytes: number;
	sha256: string;
}

export interface SkippedJob {
	skipped: "unchanged";
	sourceId: string;
	uploadId: string;
}

const PAGE = 100;
const CAS_ATTEMPTS = 5;

const STATUS: Record<UrlSourceErrorCode, number> = {
	URL_BLOCKED: 400,
	FETCH_FAILED: 502,
	HTTP_ERROR: 502,
	TOO_MANY_REDIRECTS: 502,
	TOO_LARGE: 413,
	LENGTH_REQUIRED: 502,
};

/** The `sources` storage collection declared in the plugin definition. */
export function sourcesCollection(
	storage: Record<string, StorageCollection | undefined>,
): KvCollection<SourceRow> {
	if (!storage.sources) throw new Error("flux-import: the sources storage collection is missing");
	return kvCollection<SourceRow>(storage.sources);
}

function toServiceError(e: unknown): unknown {
	return e instanceof UrlSourceError ? new ServiceError(e.code, e.message, STATUS[e.code]) : e;
}

/** Normalises and checks a URL without DNS; the fetch checks the addresses. */
function checkedUrl(text: string, allowPrivateNetwork: boolean): string {
	try {
		const url = parseSourceUrl(text);
		checkHost(url, allowPrivateNetwork);
		return url.href;
	} catch (e) {
		throw toServiceError(e);
	}
}

async function assertNameFree(deps: SourceDeps, name: string, self?: string): Promise<void> {
	const found = await deps.sources.query({ where: { name }, limit: 2 });
	if (found.items.some((item) => item.id !== self)) {
		throw new ServiceError("CONFLICT", `A source named "${name}" already exists`, 409);
	}
}

async function assertCredential(deps: SourceDeps, name: string): Promise<void> {
	if (!(await getCredential(deps.settings, name))) {
		throw new ServiceError("NOT_FOUND", `Credential "${name}" not found`, 404);
	}
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function getSource(deps: Pick<SourceDeps, "sources">, id: string): Promise<SourceRow> {
	const row = await deps.sources.get(id);
	if (!row) throw new ServiceError("NOT_FOUND", `Source ${id} not found`, 404);
	return row;
}

export async function listSources(
	deps: Pick<SourceDeps, "sources">,
	cursor?: string,
): Promise<Page<SourceRow>> {
	return page(
		await deps.sources.query({
			orderBy: { createdAt: "desc" },
			limit: PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		}),
	);
}

export async function createSource(deps: SourceDeps, input: CreateSourceInput): Promise<SourceRow> {
	const url = checkedUrl(input.url, deps.net.allowPrivateNetwork);
	await assertNameFree(deps, input.name);
	if (input.credential !== undefined) await assertCredential(deps, input.credential);
	const at = iso(deps.now());
	const row: SourceRow = {
		id: deps.newId(),
		name: input.name,
		url,
		...(input.credential === undefined ? {} : { credential: input.credential }),
		createdAt: at,
		updatedAt: at,
	};
	await deps.sources.put(row.id, row);
	return row;
}

/**
 * Changing the URL or the credential clears `lastFetch`, `lastError` and `lastImport`: the next
 * fetch is full and its content counts as new.
 */
export async function updateSource(deps: SourceDeps, input: UpdateSourceInput): Promise<SourceRow> {
	const current = await getSource(deps, input.id);
	const { credential: _credential, lastFetch, lastError, lastImport, ...base } = current;
	if (input.name !== undefined && input.name !== current.name) {
		await assertNameFree(deps, input.name, current.id);
	}
	const url =
		input.url === undefined ? current.url : checkedUrl(input.url, deps.net.allowPrivateNetwork);
	if (typeof input.credential === "string" && input.credential !== current.credential) {
		await assertCredential(deps, input.credential);
	}
	const credential = input.credential === undefined ? current.credential : input.credential;
	const reconfigured = url !== current.url || (credential ?? undefined) !== current.credential;
	const next: SourceRow = {
		...base,
		name: input.name ?? current.name,
		url,
		...(credential === null || credential === undefined ? {} : { credential }),
		...(reconfigured || !lastFetch ? {} : { lastFetch }),
		...(reconfigured || !lastError ? {} : { lastError }),
		...(reconfigured || !lastImport ? {} : { lastImport }),
		updatedAt: iso(deps.now()),
	};
	await deps.sources.put(next.id, next);
	return next;
}

/** Deletes the staged file unless a job may still read it. */
async function deleteUploadIfUnused(deps: SourceDeps, uploadId: string): Promise<void> {
	if (await uploadInUse(deps.jobs, uploadId)) return;
	await new EmDashUploads(deps.storage).delete(uploadId);
}

/** Deletes the source and its latest staged file, unless a job still reads that file. */
export async function deleteSource(deps: SourceDeps, id: string): Promise<{ deleted: true }> {
	const row = await getSource(deps, id);
	await deps.sources.delete(id);
	if (row.lastFetch) await deleteUploadIfUnused(deps, row.lastFetch.uploadId);
	return { deleted: true };
}

/** Each source's latest staged file: kept while the source exists. */
export async function latestSourceUploads(sources: KvCollection<SourceRow>): Promise<Set<string>> {
	const latest = new Set<string>();
	let cursor: string | undefined;
	do {
		const result = await sources.query({ limit: PAGE, ...(cursor ? { cursor } : {}) });
		for (const { data } of result.items) {
			if (data.lastFetch) latest.add(data.lastFetch.uploadId);
		}
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return latest;
}

type Versioned = { value: SourceRow; revision: string };

/**
 * Writes a fetch result onto the row read before the fetch. A concurrent fetch only moves the
 * revision, so the write is retried on the newer row; a row that was deleted or given another
 * URL or credential meanwhile is left alone (`null`).
 */
async function saveFetchResult(
	deps: SourceDeps,
	read: Versioned,
	change: (row: SourceRow) => SourceRow,
): Promise<SourceRow | null> {
	let current = read;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const result = await deps.sources.compareAndSet(
			read.value.id,
			current.revision,
			change(current.value),
		);
		if (result.applied) return current.value;
		const again = await deps.sources.getVersioned(read.value.id);
		if (
			!again ||
			again.value.url !== read.value.url ||
			again.value.credential !== read.value.credential
		) {
			return null;
		}
		current = again;
	}
	throw new ServiceError("CONFLICT", "The source kept changing during the fetch; try again", 409);
}

function withoutError(row: SourceRow): SourceRow {
	const { lastError: _lastError, ...rest } = row;
	return rest;
}

/**
 * Fetches a source into a staged upload (see `downloadSource`), saves the result as `lastFetch`
 * or the failure as `lastError`, and deletes the previous staged file when a changed fetch
 * replaced it and no job reads it.
 */
export async function fetchSource(
	deps: SourceDeps,
	id: string,
	force = false,
): Promise<FetchOutcome> {
	const read = await deps.sources.getVersioned(id);
	if (!read) throw new ServiceError("NOT_FOUND", `Source ${id} not found`, 404);
	const source = read.value;
	let result: DownloadResult;
	try {
		let credential: { header: string; value: string } | undefined;
		if (source.credential !== undefined) {
			credential = (await getCredential(deps.settings, source.credential)) ?? undefined;
			if (!credential) {
				throw new ServiceError(
					"CREDENTIAL_MISSING",
					`Credential "${source.credential}" does not exist`,
					409,
				);
			}
		}
		result = await downloadSource(
			{
				storage: deps.storage,
				net: deps.net,
				limits: deps.limits,
				workers: deps.workers,
				now: deps.now,
			},
			{
				url: source.url,
				force,
				...(credential ? { credential } : {}),
				...(source.lastFetch ? { previous: source.lastFetch } : {}),
			},
		);
	} catch (e) {
		const error = toServiceError(e);
		if (error instanceof ServiceError) {
			const lastError = { at: iso(deps.now()), code: error.code, message: error.message };
			await saveFetchResult(deps, read, (row) => ({ ...row, lastError })).catch(() => null);
		}
		throw error;
	}

	const replaced = await saveFetchResult(deps, read, (row) => ({
		...withoutError(row),
		lastFetch: result.fetch,
	}));
	if (!replaced) {
		if (result.changed) await deleteUploadIfUnused(deps, result.fetch.uploadId);
		throw new ServiceError(
			"CONFLICT",
			"The source was deleted or reconfigured during the fetch",
			409,
		);
	}
	const previous = replaced.lastFetch?.uploadId;
	if (result.changed && previous !== undefined && previous !== result.fetch.uploadId) {
		await deleteUploadIfUnused(deps, previous).catch(() => {});
	}
	const { uploadId, bytes, sha256 } = result.fetch;
	return { changed: result.changed, uploadId, bytes, sha256 };
}

/**
 * Saves the content a real job was created from. Best effort: the job exists either way, and a
 * source deleted or reconfigured meanwhile is left alone. A lost race is retried on the newer row.
 */
async function recordImport(
	deps: SourceDeps,
	read: SourceRow,
	lastImport: LastImport,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		const current = await deps.sources.getVersioned(read.id);
		if (
			!current ||
			current.value.url !== read.url ||
			current.value.credential !== read.credential
		) {
			return;
		}
		const result = await deps.sources.compareAndSet(read.id, current.revision, {
			...current.value,
			lastImport,
		});
		if (result.applied) return;
	}
}

/**
 * `jobs/create` with a `sourceId`: fetches first (conditional GET and hash decide whether a new
 * copy is staged), then skips the job only for a real run without `force` whose content equals
 * `lastImport`. Dry runs are never skipped and never recorded; a failed creation records nothing.
 */
export async function jobFromSource(
	deps: SourceDeps,
	sourceId: string,
	options: { force: boolean; dryRun: boolean },
	create: (uploadId: string) => Promise<Job>,
): Promise<Job | SkippedJob> {
	const fetched = await fetchSource(deps, sourceId, options.force);
	const source = await getSource(deps, sourceId);
	if (!options.force && !options.dryRun && source.lastImport?.sha256 === fetched.sha256) {
		return { skipped: "unchanged", sourceId, uploadId: fetched.uploadId };
	}
	const job = await create(fetched.uploadId);
	if (!options.dryRun) {
		await recordImport(deps, source, {
			sha256: fetched.sha256,
			uploadId: fetched.uploadId,
			jobId: job.id,
			at: iso(deps.now()),
		});
	}
	return job;
}
```

- [ ] **Step 5: Add the routes, the storage collection and the purge keep set**

In `packages/flux-import/src/plugin/routes.ts`, replace
```ts
import { PluginRouteError, pluginResponse, ulid } from "emdash";
```
with:
```ts
import { PluginRouteError, pluginResponse, ulid } from "emdash";
import { allowPrivateNetwork, maxSourceBytes } from "../astro/config.js";
```
then replace
```ts
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { JobError } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
```
with:
```ts
import { EmDashUploads, isUploadId, type UploadStorage } from "../emdash/uploads.js";
import { onWorkers } from "../emdash/workers.js";
import { JobError } from "../engine/jobs.js";
import type { EngineDeps, JobStatus, RecordStatus } from "../engine/types.js";
import { FETCH_LIMITS } from "../sources/fetcher.js";
import { defaultResolver } from "../sources/net.js";
```
then replace
```ts
	startJob,
} from "./service.js";
```
with:
```ts
	startJob,
	type UploadKeeper,
} from "./service.js";
import {
	createSource,
	deleteSource,
	fetchSource,
	getSource,
	jobFromSource,
	latestSourceUploads,
	listSources,
	type SourceDeps,
	sourcesCollection,
	updateSource,
} from "./sources.js";
```
then replace
```ts
const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
```
with:
```ts
const jobId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid job ID");
const sourceId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "Invalid source ID");
const sourceName = z.string().min(1).max(100);
const sourceUrl = z.string().min(1).max(2048);
```
then replace
```ts
	actor: ActorInfo;
}
```
with:
```ts
	actor: ActorInfo;
	sources: SourceDeps;
	/** Keeps each URL source's latest staged file when a finished job releases its file. */
	keep: UploadKeeper;
}
```
then replace
```ts
		const uploads = new EmDashUploads(runtime.storage);
		const deps: EngineDeps = {
```
with:
```ts
		const uploads = new EmDashUploads(runtime.storage);
		const collection = sourcesCollection(ctx.storage);
		const sources: SourceDeps = {
			sources: collection,
			jobs: pluginCollections(ctx.storage).jobs,
			settings: ctx.settings,
			storage: runtime.storage,
			net: {
				resolver: defaultResolver(),
				allowPrivateNetwork: allowPrivateNetwork(),
				// A plain call: workerd rejects fetch() called as a method of another object.
				fetch: (input, init) => fetch(input, init),
			},
			limits: { ...FETCH_LIMITS, maxBytes: maxSourceBytes() },
			workers: onWorkers(),
			now: Date.now,
			newId: () => ulid(),
		};
		const keep: UploadKeeper = async (uploadId) =>
			(await latestSourceUploads(collection)).has(uploadId);
		const deps: EngineDeps = {
```
then replace
```ts
			return await run({ deps, uploads, storage: runtime.storage, runtime, actor });
```
with:
```ts
			return await run({
				deps,
				uploads,
				storage: runtime.storage,
				runtime,
				actor,
				sources,
				keep,
			});
```
then replace
```ts
const createInput = z.object({
	uploadId,
	template: z.unknown(),
	dryRun: z.boolean(),
	publish: z.boolean().optional(),
	batchSize: z.number().int().optional(),
	budgetMs: z.number().int().optional(),
});
```
with:
```ts
const createInput = z
	.object({
		uploadId: uploadId.optional(),
		sourceId: sourceId.optional(),
		/** With `sourceId`: fetch without validators and create the job even if nothing changed. */
		force: z.boolean().optional(),
		template: z.unknown(),
		dryRun: z.boolean(),
		publish: z.boolean().optional(),
		batchSize: z.number().int().optional(),
		budgetMs: z.number().int().optional(),
	})
	.refine((input) => (input.uploadId === undefined) !== (input.sourceId === undefined), {
		message: "Set exactly one of uploadId and sourceId",
	});
```
then replace
```ts
		withServices(ctx, ({ deps, uploads }) => changeJob(deps, uploads, ctx.input.id, action)),
```
with:
```ts
		withServices(ctx, ({ deps, uploads, keep }) =>
			changeJob(deps, uploads, ctx.input.id, action, keep),
		),
```
then replace
```ts
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
			return startJob(
				deps,
				options,
				(collection) => listSchemaFields(runtime.schemaRegistry, collection),
				(locale) => resolveSiteLocale(locale),
			);
		});
	}),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`),
		),
	),
```
with:
```ts
	"sources/create": route(
		z.object({ name: sourceName, url: sourceUrl, credential: credentialName.optional() }),
		(ctx) => withServices(ctx, ({ sources }) => createSource(sources, ctx.input)),
	),

	"sources/update": route(
		z.object({
			id: sourceId,
			name: sourceName.optional(),
			url: sourceUrl.optional(),
			credential: credentialName.nullable().optional(),
		}),
		(ctx) => withServices(ctx, ({ sources }) => updateSource(sources, ctx.input)),
	),

	"sources/delete": route(z.object({ id: sourceId }), (ctx) =>
		withServices(ctx, ({ sources }) => deleteSource(sources, ctx.input.id)),
	),

	"sources/get": route(z.object({ id: sourceId }), (ctx) =>
		withServices(ctx, ({ sources }) => getSource(sources, ctx.input.id)),
	),

	"sources/list": route(z.object({ cursor }), (ctx) =>
		withServices(ctx, ({ sources }) => listSources(sources, ctx.input.cursor)),
	),

	"sources/fetch": route(z.object({ id: sourceId, force: z.boolean().optional() }), (ctx) =>
		withServices(ctx, ({ sources }) =>
			fetchSource(sources, ctx.input.id, ctx.input.force ?? false),
		),
	),

	"jobs/create": route(createInput, async (ctx) => {
		await ensureRetentionScheduled(ctx);
		return withServices(ctx, ({ deps, runtime, sources }) => {
			const { input } = ctx;
			const start = (upload: string) => {
				const options: StartJobInput = {
					uploadId: upload,
					template: input.template,
					dryRun: input.dryRun,
					...(input.publish === undefined ? {} : { publish: input.publish }),
					...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
					...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
				};
				return startJob(
					deps,
					options,
					(collection) => listSchemaFields(runtime.schemaRegistry, collection),
					(locale) => resolveSiteLocale(locale),
				);
			};
			if (input.sourceId !== undefined) {
				const options = { force: input.force ?? false, dryRun: input.dryRun };
				return jobFromSource(sources, input.sourceId, options, start);
			}
			if (input.uploadId === undefined) {
				throw new PluginRouteError(
					"VALIDATION_ERROR",
					"Set exactly one of uploadId and sourceId",
					400,
				);
			}
			return start(input.uploadId);
		});
	}),

	"jobs/next": route(byId, (ctx) =>
		withServices(ctx, ({ deps, uploads, actor, keep }) =>
			// A unique holder per call: two concurrent calls never share a lease.
			nextBatch(deps, uploads, ctx.input.id, `${actor.id}:${ulid()}`, keep),
		),
	),
```

In `packages/flux-import/src/plugin/definition.ts`, replace
```ts
import { withRuntime } from "./runtime.js";
```
with:
```ts
import { withRuntime } from "./runtime.js";
import { latestSourceUploads, sourcesCollection } from "./sources.js";
```
then replace
```ts
	links: { indexes: ["entryId"] },
```
with:
```ts
	links: { indexes: ["entryId"] },
	sources: { indexes: ["name", "createdAt"] },
```
then replace
```ts
		// through ctx.content, so these do not gate any call it makes.
```
with:
```ts
		// through ctx.content, so these do not gate any call it makes. URL sources are fetched with
		// the runtime's own fetch() behind the plugin's SSRF guard (src/sources/net.ts), not through
		// ctx.http, so no network capability is declared.
```
then replace
```ts
							days,
						);
```
with:
```ts
							days,
							await latestSourceUploads(sourcesCollection(ctx.storage)),
						);
```


- [ ] **Step 6: Run them to see them pass**

Run: `pnpm --filter flux-import exec vitest run tests/unit/sources.test.ts tests/unit/service.test.ts tests/unit/retention.test.ts tests/unit/definition.test.ts`
Expected: PASS (20 tests in `sources.test.ts`, 25 in `service.test.ts`, 5 in `retention.test.ts`, 12 in `definition.test.ts`). Then `pnpm typecheck && pnpm lint && pnpm test` (all pass; 31 files / 765 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/flux-import/src/plugin packages/flux-import/tests/unit
git commit -m "Add saved URL sources, sources/fetch and jobs/create from a source, keeping each source's latest file"
```

### Task 5: Node integration: a local feed server on `sites/dev`

**Files:**
- Create: `packages/flux-import/tests/integration/feed-server.ts`, `packages/flux-import/tests/integration/url-sources.test.ts`
- Modify: `packages/flux-import/tests/integration/server.ts`, `sites/dev/astro.config.mjs`

**Interfaces:**
- Consumes: Tasks 1-4 through HTTP; harness `Client` (`plugin`, `createProducts`, `runToEnd`), `ApiError`, `devBypass`, `startServer`/`stopServer`, `withDb` (`tests/integration/db.ts`), `productsCsv`, `template` (`tests/integration/fixtures.ts`); `inject("baseUrl")`, `inject("token")` (shared server, option off).
- Produces: `FeedServer` (`start()`, `url(path)`, `log(path)`, `stop()`, `feeds: Map<string, Feed>` with `Feed = { body; etag?; authorization?; chunked? }`); `startServer(port, dir?, maxSourceBytes?, allowPrivateNetwork = false)`; `TEST_ENCRYPTION_KEY`; env `FLUX_DEV_ALLOW_PRIVATE_NETWORK` read by `sites/dev`.

- [ ] **Step 1: Give test servers a key and the option**

In `packages/flux-import/tests/integration/server.ts`, replace
```ts
import { type ChildProcess, spawn } from "node:child_process";
```
with:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
```
then replace
```ts
export const TEST_MAX_SOURCE_BYTES = 1_000_000;
```
with:
```ts
export const TEST_MAX_SOURCE_BYTES = 1_000_000;

/**
 * A throwaway `EMDASH_ENCRYPTION_KEY` for this test process, so credentials (a `secret` plugin
 * setting) can be stored without the site's own `.env`. Set in the environment, it wins over
 * `.env` (`emdash` src/astro/integration/dev-env.ts never overwrites a set variable).
 */
export const TEST_ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;
```
then replace
```ts
 * an upload limit of `maxSourceBytes`.
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
): Promise<DevServer> {
```
with:
```ts
 * an upload limit of `maxSourceBytes`. `allowPrivateNetwork` lets URL sources reach this machine.
 */
export async function startServer(
	port: number,
	dir?: string,
	maxSourceBytes = TEST_MAX_SOURCE_BYTES,
	allowPrivateNetwork = false,
): Promise<DevServer> {
```
then replace
```ts
			FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),
```
with:
```ts
			FLUX_DEV_MAX_SOURCE_BYTES: String(maxSourceBytes),
			FLUX_DEV_ALLOW_PRIVATE_NETWORK: allowPrivateNetwork ? "1" : "0",
			EMDASH_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
```

In `sites/dev/astro.config.mjs`, replace
```js
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
```
with:
```js
const maxSourceBytes = Number(process.env.FLUX_DEV_MAX_SOURCE_BYTES) || undefined;
// URL source tests fetch from a local HTTP server; the option only works under `astro dev`.
const allowPrivateNetwork = process.env.FLUX_DEV_ALLOW_PRIVATE_NETWORK === "1";
```
then replace
```js
		fluxImportRoutes(maxSourceBytes ? { maxSourceBytes } : {}),
```
with:
```js
		fluxImportRoutes({ ...(maxSourceBytes ? { maxSourceBytes } : {}), allowPrivateNetwork }),
```

- [ ] **Step 2: Add the feed server**

Create `packages/flux-import/tests/integration/feed-server.ts`:
```ts
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FeedRequest {
	path: string;
	headers: IncomingHttpHeaders;
	status: number;
}

export interface Feed {
	body: string;
	/** Sends an ETag and answers a matching If-None-Match with 304. */
	etag?: boolean;
	/** Answers 401 unless the Authorization header is exactly this. */
	authorization?: string;
	/** Sends the body in two chunks without a Content-Length (Transfer-Encoding: chunked). */
	chunked?: boolean;
}

/**
 * A local HTTP server for URL source tests. Paths not in `feeds` answer 404; every request is
 * logged with its headers and the status sent.
 */
export class FeedServer {
	readonly feeds = new Map<string, Feed>();
	readonly requests: FeedRequest[] = [];
	private server: Server | undefined;
	baseUrl = "";

	async start(): Promise<void> {
		const server = createServer((req, res) => {
			const path = new URL(req.url ?? "/", "http://feed").pathname;
			const feed = this.feeds.get(path);
			const send = (status: number, headers: Record<string, string> = {}, body?: string) => {
				this.requests.push({ path, headers: req.headers, status });
				if (feed?.chunked && status === 200 && body !== undefined) {
					res.writeHead(status, headers);
					const half = Math.floor(body.length / 2);
					res.write(body.slice(0, half));
					setTimeout(() => res.end(body.slice(half)), 20);
					return;
				}
				res.writeHead(status, {
					...headers,
					...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
				});
				res.end(body);
			};
			if (!feed) return send(404, {}, "not found");
			if (feed.authorization !== undefined && req.headers.authorization !== feed.authorization) {
				return send(401, {}, "unauthorized");
			}
			const tag = `"${createHash("sha256").update(feed.body).digest("hex").slice(0, 16)}"`;
			if (feed.etag && req.headers["if-none-match"] === tag) return send(304, { etag: tag });
			send(200, { "content-type": "text/csv", ...(feed.etag ? { etag: tag } : {}) }, feed.body);
		});
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}`;
	}

	url(path: string): string {
		return `${this.baseUrl}${path}`;
	}

	/** The requests made to `path`, oldest first. */
	log(path: string): FeedRequest[] {
		return this.requests.filter((r) => r.path === path);
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
}
```

- [ ] **Step 3: Write the test**

Create `packages/flux-import/tests/integration/url-sources.test.ts`:
```ts
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { ApiError, Client, devBypass } from "./client.js";
import { withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4395;
const TOKEN = "Bearer feed-token-7f3a";

type Skipped = { skipped: "unchanged"; sourceId: string; uploadId: string };

let server: DevServer;
let client: Client;
const feeds = new FeedServer();

beforeAll(async () => {
	await feeds.start();
	// Its own server: URL sources here fetch from 127.0.0.1, which needs allowPrivateNetwork.
	server = await startServer(PORT, undefined, undefined, true);
	client = new Client(server.baseUrl, await devBypass(server.baseUrl));
	await client.createProducts("it_url");
});

afterAll(async () => {
	await stopServer(server);
	await rm(server.dir, { recursive: true, force: true });
	await feeds.stop();
});

const createJob = (sourceId: string, extra: Record<string, unknown> = {}) =>
	client.plugin<Job | Skipped>("jobs/create", {
		sourceId,
		template: template("it_url"),
		dryRun: false,
		...extra,
	});

async function runJob(sourceId: string): Promise<Job> {
	const job = await createJob(sourceId);
	if ("skipped" in job) throw new Error(`Expected a job, got ${JSON.stringify(job)}`);
	return client.runToEnd(job.id);
}

const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

describe("URL sources on Node", () => {
	let bearer: SourceRow;
	let plain: SourceRow;

	it("imports a feed through a bearer credential that no route returns", async () => {
		feeds.feeds.set("/bearer.csv", { body: productsCsv(5), etag: true, authorization: TOKEN });
		expect(
			await client.plugin("credentials/set", {
				name: "feed-token",
				header: "Authorization",
				value: TOKEN,
			}),
		).toEqual({ name: "feed-token", header: "Authorization" });
		const listed = await client.plugin("credentials/list", {});
		expect(listed).toEqual([{ name: "feed-token", header: "Authorization" }]);
		// EmDash stored the setting as an AES-GCM envelope, not as the JSON text.
		const raw = withDb(server.dbPath, (db) =>
			db
				.prepare("SELECT value FROM options WHERE name = ?")
				.get("plugin:flux-import:settings:credentials"),
		) as { value: string };
		expect(JSON.parse(raw.value)).toMatchObject({ $emdash: "plugin-setting", v: 1 });
		expect(raw.value).not.toContain("feed-token-7f3a");

		bearer = await client.plugin<SourceRow>("sources/create", {
			name: "Bearer feed",
			url: feeds.url("/bearer.csv"),
			credential: "feed-token",
		});
		expect(JSON.stringify(bearer)).not.toContain("feed-token-7f3a");
		const done = await runJob(bearer.id);
		expect(done).toMatchObject({ status: "completed", counters: { created: 5, failed: 0 } });
		expect(feeds.log("/bearer.csv").map((r) => [r.status, r.headers.authorization])).toEqual([
			[200, TOKEN],
		]);
		const stored = await client.plugin<SourceRow>("sources/get", { id: bearer.id });
		expect(stored.lastFetch).toMatchObject({ status: 200, uploadId: done.uploadId });
		expect(JSON.stringify(stored)).not.toContain("feed-token-7f3a");
	});

	it("skips a re-run when the server answers 304, keeping the staged file", async () => {
		const first = await client.plugin<SourceRow>("sources/get", { id: bearer.id });
		expect(await createJob(bearer.id)).toEqual({
			skipped: "unchanged",
			sourceId: bearer.id,
			uploadId: first.lastFetch?.uploadId,
		});
		const second = feeds.log("/bearer.csv")[1];
		expect(second?.status).toBe(304);
		expect(second?.headers["if-none-match"]).toMatch(/^"[0-9a-f]{16}"$/);
		expect(
			(await client.plugin<SourceRow>("sources/get", { id: bearer.id })).lastFetch,
		).toMatchObject({ status: 304, uploadId: first.lastFetch?.uploadId });
	});

	it("skips a re-run when a server without validators sends the same body", async () => {
		feeds.feeds.set("/plain.csv", { body: productsCsv(5) });
		plain = await client.plugin<SourceRow>("sources/create", {
			name: "Plain feed",
			url: feeds.url("/plain.csv"),
		});
		expect((await runJob(plain.id)).counters).toMatchObject({ unchanged: 5, created: 0 });
		const skipped = await createJob(plain.id);
		expect(skipped).toMatchObject({ skipped: "unchanged", sourceId: plain.id });
		expect(feeds.log("/plain.csv").map((r) => [r.status, r.headers["if-none-match"]])).toEqual([
			[200, undefined],
			[200, undefined],
		]);
	});

	it("creates a new job when the body changes, and with force when it does not", async () => {
		feeds.feeds.set("/plain.csv", { body: productsCsv(6) });
		expect((await runJob(plain.id)).counters).toMatchObject({ created: 1, unchanged: 5 });
		const forced = await createJob(plain.id, { force: true });
		expect(forced).toMatchObject({ status: "created" });
	});

	it("never skips a dry run, and runs the real import after it without force", async () => {
		feeds.feeds.set("/dry.csv", { body: productsCsv(3), etag: true });
		const dry = await client.plugin<SourceRow>("sources/create", {
			name: "Dry-run feed",
			url: feeds.url("/dry.csv"),
		});
		const preview = await createJob(dry.id, { dryRun: true });
		expect(preview).toMatchObject({ status: "created", dryRun: true });
		await client.runToEnd((preview as Job).id);
		// The second fetch is a 304, but nothing from this feed has been imported yet.
		const real = await createJob(dry.id);
		expect(real).toMatchObject({ status: "created", dryRun: false });
		await client.runToEnd((real as Job).id);
		expect(await createJob(dry.id)).toMatchObject({ skipped: "unchanged", sourceId: dry.id });
		expect(feeds.log("/dry.csv").map((r) => r.status)).toEqual([200, 304, 304]);
	});

	it("fails with HTTP_ERROR for a 404 and saves it as the source's lastError", async () => {
		const missing = await client.plugin<SourceRow>("sources/create", {
			name: "Missing feed",
			url: feeds.url("/missing.csv"),
		});
		const error = await failure(client.plugin("sources/fetch", { id: missing.id }));
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 502, code: "HTTP_ERROR" });
		expect(
			(await client.plugin<SourceRow>("sources/get", { id: missing.id })).lastError,
		).toMatchObject({ code: "HTTP_ERROR", message: "The server answered HTTP 404" });
	});

	it("fails with CREDENTIAL_MISSING after the credential is deleted", async () => {
		expect(await client.plugin("credentials/delete", { name: "feed-token" })).toEqual({
			deleted: true,
		});
		const error = await failure(client.plugin("sources/fetch", { id: bearer.id }));
		expect(error).toMatchObject({ status: 409, code: "CREDENTIAL_MISSING" });
	});

	it("deletes a source and its latest staged file", async () => {
		expect(await client.plugin("sources/delete", { id: plain.id })).toEqual({ deleted: true });
		const error = await failure(client.plugin("sources/get", { id: plain.id }));
		expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
	});
});

describe("URL sources without allowPrivateNetwork", () => {
	it("refuses a loopback URL with URL_BLOCKED", async () => {
		const shared = new Client(inject("baseUrl"), inject("token"));
		for (const url of [feeds.url("/plain.csv"), "http://localhost/feed.csv"]) {
			const error = await failure(shared.plugin("sources/create", { name: url, url }));
			expect(error).toMatchObject({ status: 400, code: "URL_BLOCKED" });
		}
	});
});
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter flux-import exec vitest run --config vitest.integration.config.ts tests/integration/url-sources.test.ts --reporter=verbose`
Expected: PASS (9 tests; about 6 s of tests plus two dev server starts, about 13 s in all). The first test reads the stored setting and finds EmDash's envelope (Review Focus 2); the second proves the 304 path and that the finished job kept its source's file (Review Focus 4); "never skips a dry run, …" proves that a real run after a dry run of an unchanged feed is created without `force`, and that the next real run is skipped.

- [ ] **Step 5: Run the whole integration suite**

Run: `pnpm test:integration`
Expected: PASS (8 files / 43 tests, about 7 minutes; Fact F1 describes a known `crash.test.ts` flake on WSL). Then `pnpm typecheck && pnpm lint && pnpm test`. `git status` must show only this task's files: the global setup restores `sites/dev/emdash-env.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/flux-import/tests/integration sites/dev/astro.config.mjs
git commit -m "Prove URL sources end to end on Node against a local feed server"
```

### Task 6: workerd parity: a chunked feed through the buffering path on `sites/dev-cf`

**Files:**
- Modify: `sites/dev-cf/astro.config.mjs`, `packages/flux-import/tests/integration-cf/parity.test.ts`

**Interfaces:**
- Consumes: `FeedServer` (Task 5); parity harness (`client`, `inject("cfBaseUrl")`, `inject("cfToken")`); `productsCsv`, `template`.
- Produces: one parity test; no code.

- [ ] **Step 1: Allow the local feed server on the dev-only Workers site**

In `sites/dev-cf/astro.config.mjs`, replace
```js
		fluxImportRoutes(),
```
with:
```js
		// The parity tests fetch URL sources from a local HTTP server (development only).
		fluxImportRoutes({ allowPrivateNetwork: true }),
```

- [ ] **Step 2: Add the test**

In `packages/flux-import/tests/integration-cf/parity.test.ts`, replace
```ts
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { Client } from "../integration/client.js";
```
with:
```ts
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { jsonTemplate, productsJson, withSelection } from "../fixtures/formats.js";
import { Client } from "../integration/client.js";
import { FeedServer } from "../integration/feed-server.js";
```
then replace
```ts
	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
```
with:
```ts
	it("imports a chunked URL feed through the Workers buffering path into R2", async () => {
		const feeds = new FeedServer();
		await feeds.start();
		try {
			// No Content-Length: R2 needs a known length, so the fetcher buffers the body first.
			feeds.feeds.set("/chunked.csv", { body: productsCsv(10), chunked: true });
			await client.createProducts("cf_url");
			const source = await client.plugin<SourceRow>("sources/create", {
				name: "Chunked feed",
				url: feeds.url("/chunked.csv"),
			});
			const create = () =>
				client.plugin<Job | { skipped: string }>("jobs/create", {
					sourceId: source.id,
					template: template("cf_url"),
					dryRun: false,
				});
			const job = await create();
			if ("skipped" in job) throw new Error("expected a job");
			expect(await client.runToEnd(job.id)).toMatchObject({
				status: "completed",
				counters: { created: 10, failed: 0 },
			});
			const stored = await client.plugin<SourceRow>("sources/get", { id: source.id });
			expect(stored.lastFetch).toMatchObject({
				status: 200,
				bytes: Buffer.byteLength(productsCsv(10)),
				uploadId: job.uploadId,
			});
			// Same body again: unchanged by its hash, and the kept R2 object is reused.
			expect(await create()).toEqual({
				skipped: "unchanged",
				sourceId: source.id,
				uploadId: job.uploadId,
			});
			expect(feeds.log("/chunked.csv").map((r) => r.status)).toEqual([200, 200]);
		} finally {
			await feeds.stop();
		}
	});

	it("imports 10,000 rows with ranged R2 reads and does not re-read past the end", async () => {
```

- [ ] **Step 3: Run the new test on workerd**

Run: `pnpm --filter flux-import exec vitest run --config vitest.cf.config.ts -t "URL feed" --reporter=verbose`
Expected: PASS (1 test, about 2 s plus 30 s of server start; the other five are skipped). This proves on workerd that a chunked body is buffered and stored in R2 with its length (Review Focus 5; without the buffering path `stageUpload` throws `LengthRequiredError` and the route answers 500), that DNS is skipped under `allowPrivateNetwork`, that `AbortSignal.any` works there (W4), and that the hash path finds the kept R2 object. The full `pnpm test:cf` runs in Task 7.

- [ ] **Step 4: Commit**

`pnpm typecheck && pnpm lint && pnpm test`, then:
```bash
git add sites/dev-cf/astro.config.mjs packages/flux-import/tests/integration-cf/parity.test.ts
git commit -m "Prove a chunked URL feed on workerd through the Workers buffering path"
```

### Task 7: M3c review run

**Files:**
- Create: `docs/superpowers/notes/2026-10-26-m3c-review.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the filled-in review note; no code.

- [ ] **Step 1: Run every automated check**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:cf`
Expected: all pass (`pnpm test:cf` takes about 18 minutes, almost all of it the unchanged 10,000-row case). Copy the summary lines (files, tests, durations) into the note.

- [ ] **Step 2: Manual checks against `pnpm dev`**

On the normal dev database (back up `sites/dev/data.db*` first; an agent runs `FLUX_DEV_ALLOW_PRIVATE_NETWORK=1 node node_modules/astro/bin/astro.mjs dev --ignore-lock` inside `sites/dev`; the site's own `.env` supplies `EMDASH_ENCRYPTION_KEY`, or export one from `npx emdash secrets generate`), with an Admin PAT from `setup/dev-bypass`, and a local feed (for example `python3 -m http.server 4500` in a directory holding a 10-row products CSV), record each result:
1. `credentials/set { name: "local", header: "X-Api-Key", value: "k-1" }`, then `credentials/list`: one entry `{ name, header }` and no value; the admin page `/_emdash/admin/plugins/flux-import/settings` (or `GET /_emdash/api/admin/plugins/flux-import/settings`) shows the credentials field as set, without its value.
2. `sources/create { name: "Local CSV", url: "http://127.0.0.1:4500/products.csv", credential: "local" }`, then `jobs/create { sourceId, template (into posts, as in the M3b manual check), dryRun: false }` and drive it with `jobs/next`: completed with 10 created. `sources/get` shows `lastFetch` with status 200, bytes and SHA-256.
3. `jobs/create` again: `{ skipped: "unchanged", … }` (Python's server sends `Last-Modified`, so the fetch is a `304`; `sources/get` shows `lastImport` with the first job's ID). A dry run of the same feed creates a job (never skipped) and leaves `lastImport` alone. Edit one row of the CSV and run again: a new job with 1 updated.
4. Without the environment variable (restart the server): `sources/create` with a `127.0.0.1` URL answers 400 `URL_BLOCKED`; `sources/fetch` of the source from check 2 answers 400 `URL_BLOCKED` and `sources/get` shows it as `lastError`.
5. `sources/delete` of the source: `{ deleted: true }`; its latest staged file is gone from `sites/dev/uploads` unless a job still reads it. Restore `sites/dev/data.db*`, remove `sites/dev/uploads`, revert `sites/dev/emdash-env.d.ts`; `git status` clean apart from the note.

- [ ] **Step 3: Write the review note**

Create `docs/superpowers/notes/2026-10-26-m3c-review.md` from this template and fill in every `…`:
````markdown
# Milestone 3c review

Date: …  ·  Commit: …  ·  Node: …  ·  EmDash 1.2.0

## Automated checks

| Command | Result | Summary (files / tests / duration) |
| --- | --- | --- |
| `pnpm typecheck` | … | … |
| `pnpm lint` | … | … |
| `pnpm test` | … | … |
| `pnpm test:integration` | … | … |
| `pnpm test:cf` | … | … |

## Spec "Testing" coverage

| Item | Evidence | Result |
| --- | --- | --- |
| SSRF: every blocked range, IPv4-mapped and NAT64 IPv6, decimal and hex IPv4, public addresses allowed, blocked hostnames, a resolver returning a private address, a redirect to a private host, credential kept on same-origin and removed on cross-origin hops, more than 5 hops, `allowPrivateNetwork` only in DEV | `net.test.ts` | … |
| Fetch: conditional headers; `304` and same-hash unchanged; `force`; missing previous upload; size limit from `Content-Length` and while streaming (partial upload deleted); both timeouts; Workers buffering and `LENGTH_REQUIRED` | `fetcher.test.ts` | … |
| Routes: credential routes never return values; name and header validation; source create, update (clears `lastFetch` on URL change), delete, list, unique names; `jobs/create` with `sourceId` (created, skipped against `lastImport`, forced; dry run never skipped; failed creation records nothing) and exactly one of `uploadId`/`sourceId`; retention keeps each source's latest upload | `credentials.test.ts`, `sources.test.ts`, `definition.test.ts`, `service.test.ts`, `retention.test.ts` | … |
| Integration on `sites/dev`: bearer credential and a completed job; re-run skipped through `304` and through the hash; changed body creates a job; `URL_BLOCKED` with the option off; `HTTP_ERROR` for a 404 | `tests/integration/url-sources.test.ts` | … |
| workerd: one URL import with a chunked response through the buffering path | `parity.test.ts` | … |

## Manual checks

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Credential set and listed without its value; admin page shows it as set | … | … |
| 2 | Source import with a credential | … | … |
| 3 | Re-run skipped (which path), changed file imported | … | … |
| 4 | `URL_BLOCKED` without the option, saved as `lastError` | … | … |
| 5 | Delete removes the latest file; working tree clean | … | … |

## Deviations from the plan

…

## Open issues for the next part

…
````

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-26-m3c-review.md
git commit -m "Add the Milestone 3c review results"
```

---

## After this plan

M3c ends here with the review stop. M6 schedules `jobFromSource` from cron on the same pieces (a fetch per source, then batches); M3d adds XLSX with a row-index cursor. Known gaps carried forward: DNS can change between the check and the connection (as in EmDash core; on Workers Cloudflare's network refuses private ranges itself); two concurrent creates can give two sources one name. The M2, M3a and M3b open issues (`docs/superpowers/notes/2026-10-08-m2-review.md`, `docs/superpowers/notes/2026-10-12-m3a-review.md`, `docs/superpowers/notes/2026-10-14-m3b-review.md`) are unchanged by this plan; the production Cloudflare build blocker from M2 still stands, so URL sources on a deployed Worker stay unverified.
