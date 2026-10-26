# Flux Import M3c: URL sources

Status: approved in conversation 2026-10-26. Part of Milestone 3 (Sources) of
[the roadmap](./2026-10-07-flux-import-roadmap-design.md). Builds on
[M3a](./2026-10-12-flux-import-m3a-formats-design.md) (formats, pasted sources) and
[M3b](./2026-10-14-flux-import-m3b-selection-transforms-design.md) (filters and expressions),
merged at `7e1d97c`.

## Goal

Import from saved URL sources, chiefly recurring supplier or partner feeds, with the same
guarantees as uploads (bounded memory, exact byte-offset resume, idempotent batches, crash repair)
plus: auth headers kept encrypted, an SSRF guard, and re-runs skipped when the feed has not
changed. M3c triggers runs by hand; M6 adds cron on top of the same pieces.

## Decisions

| Topic | Decision |
| --- | --- |
| Approach | Download, then import. A fetch streams the URL's body into the existing upload store; the job imports that staged copy exactly like an uploaded file. Nothing in the engine changes. |
| Saved sources | A new plugin storage collection `sources`; each source names a URL and optionally a credential. |
| Credentials | Named credentials (`name → { header, value }`) kept as JSON in one declared `secret` plugin setting, `credentials`, which EmDash encrypts at rest (AES-GCM, `EMDASH_ENCRYPTION_KEY`). Routes can set or delete a credential but never return its value. |
| Fetching | Native `fetch()` through the trusted runtime, not `ctx.http.fetch()`, whose 8 MiB buffered limit is below the 50 MiB source limit. The plugin therefore enforces its own SSRF guard. |
| Change detection | Conditional GET (`If-None-Match`, `If-Modified-Since`) from the last fetch, plus a SHA-256 of the body. A `304` or the same hash is an unchanged fetch (no new copy staged) while the previous staged upload still exists. `jobs/create` skips a run only when the fetched content equals the last real import (`lastImport`), not the last fetch. |
| Format | The template's `source.format` decides parsing; the response `Content-Type` is ignored. |
| Capabilities | No new capability: the native plugin does not use `ctx.http`. The plugin's capability comment is updated to say it fetches URLs through the trusted runtime. |

## Storage: `sources`

Key: ULID. Indexes: `name`, `createdAt`. Names are unique (checked on create and rename).

```ts
interface SourceRow {
	id: string;
	name: string; // 1-100 chars
	url: string; // http(s), no userinfo, at most 2,048 chars
	credential?: string; // a credential name
	lastFetch?: {
		at: string;
		status: number; // HTTP status of the final response
		etag?: string;
		lastModified?: string;
		sha256: string;
		bytes: number;
		uploadId: string;
	};
	lastError?: { at: string; code: string; message: string };
	lastImport?: {
		sha256: string; // content of the last real (not dry-run) job created from a fetch
		uploadId: string;
		jobId: string;
		at: string;
	};
	createdAt: string;
	updatedAt: string;
}
```

A failed fetch sets `lastError` and keeps `lastFetch` from the last success. A successful fetch
clears `lastError`. `lastImport` is written (compare-and-set) only when `jobs/create` creates a job
that is not a dry run from a source fetch; dry runs and failed creations never write it. Changing
the URL or credential clears `lastFetch`, `lastError` and `lastImport`. `lastImport.uploadId` has
no retention protection of its own: its file stays while a job uses it (or while it is also
`lastFetch.uploadId`).

## Credentials

- Setting `credentials` (`type: "secret"`) holds a JSON object `{ [name]: { header, value } }`.
- Names: 1-64 chars, `[a-z0-9-]`. Header names: a valid HTTP token, not `Host`, `Cookie`,
  `Content-Length`, `Transfer-Encoding`, `Connection`, or another hop-by-hop header. Values: 1-4,096
  chars, no CR or LF.
- Routes: `credentials/set { name, header, value }`, `credentials/delete { name }`,
  `credentials/list` → `[{ name, header }]`. No route returns a value.
- Deleting a credential that a source names is allowed; fetching that source then fails with
  `CREDENTIAL_MISSING`.
- The plan verifies, before relying on it, that `ctx.settings.set` on a declared `secret` field
  encrypts the value for a native plugin; if it does not, the plan stops and reports.

## Routes

All require `import:execute`, like every other route.

| Route | Input | Result |
| --- | --- | --- |
| `sources/create` | `{ name, url, credential? }` | the source |
| `sources/update` | `{ id, name?, url?, credential? \| null }` | the source; changing `url` or `credential` clears `lastFetch` |
| `sources/delete` | `{ id }` | `{ deleted: true }`; deletes the latest staged upload unless a job still uses it |
| `sources/get` | `{ id }` | the source |
| `sources/list` | `{ cursor? }` | a page of sources |
| `sources/fetch` | `{ id, force? }` | `{ changed, uploadId, bytes, sha256 }` |
| `jobs/create` | existing input with either `uploadId` or `sourceId` (exactly one), plus optional `force` | the job, or `{ skipped: "unchanged", sourceId, uploadId }` (only for a real run without `force` whose content equals `lastImport`) |

`sources/fetch`:

1. Load the source and its credential (`CREDENTIAL_MISSING` if named but absent).
2. Unless `force`, send `If-None-Match` / `If-Modified-Since` from `lastFetch` when its staged
   upload still exists.
3. `304` → unchanged, reuse `lastFetch.uploadId`.
4. `2xx` → stream the body into a new staged upload while hashing it. If the hash equals
   `lastFetch.sha256` and the old upload still exists (and not `force`), delete the new copy and
   report unchanged. Otherwise record the new `lastFetch` and report changed.
5. Any other status → `HTTP_ERROR`.

`jobs/create` with `sourceId`:

1. Fetch exactly as `sources/fetch` does (conditional GET and hash decide whether a new copy is
   staged; `sources/fetch` keeps reporting `changed` relative to `lastFetch`).
2. If not `force`, not a dry run, and the fetched SHA-256 equals `lastImport.sha256` →
   `{ skipped: "unchanged", sourceId, uploadId }`, no job.
3. Otherwise create the job from the resulting `uploadId` as today. Dry runs are never skipped.
4. Only when a job that is not a dry run was created, record `lastImport { sha256, uploadId,
   jobId, at }`. A failed creation records nothing, so a retry (and a real run after a dry run)
   needs no `force`.

## SSRF guard

A plugin module (`src/sources/net.ts` or similar), modelled on EmDash core's internal
`ssrfSafeFetch` (not exported, so not imported):

- Scheme `http:` or `https:` only; no username or password in the URL.
- Blocked hostnames: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`,
  `metadata.google.internal` and other metadata names.
- IP literals and every resolved address must be public. Blocked: `0.0.0.0/8`, `10/8`, `100.64/10`,
  `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4` and above,
  `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and IPv4 addresses mapped or embedded in IPv6
  (`::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`). Non-canonical IPv4 forms are normalised by `URL` first.
- DNS: `node:dns` `lookup(…, { all: true })` on Node; DNS-over-HTTPS (`cloudflare-dns.com`, A and
  AAAA) on Workers. Any non-public answer blocks the request.
- Redirects: `redirect: "manual"`, at most 5 hops, each re-validated. The credential header is
  removed when a hop changes origin.
- Known gap (as in EmDash core): DNS can change between the check and the connection. On Workers,
  Cloudflare's network refuses private ranges itself.
- Development and tests: `fluxImportRoutes({ allowPrivateNetwork: true })` skips the address checks
  (scheme and userinfo checks still apply), honoured only when `import.meta.env.DEV` is true and
  ignored in production builds.

## Limits

- Size: `maxSourceBytes` (default 50 MiB), the upload limit. A larger `Content-Length` is refused
  before reading; the stream is cut and the partial upload deleted when it passes the limit.
- Time: 15 s until response headers, 120 s for the whole download (abort signals).
- Workers: storage needs a known length. When the response has no `Content-Length`, or a
  `Content-Encoding` (Workers decodes the body, so the header no longer matches), the body is
  buffered in memory up to 32 MiB and stored with its length; larger fails with `LENGTH_REQUIRED`.
  Node streams without buffering. The plan verifies Workers' `Content-Length` behaviour for
  compressed responses.

## Errors

| Code | When |
| --- | --- |
| `URL_BLOCKED` | Scheme, userinfo, hostname or address rules |
| `CREDENTIAL_MISSING` | The source names a credential that does not exist |
| `FETCH_FAILED` | Network error, DNS failure or timeout |
| `HTTP_ERROR` | Final status other than 2xx or 304; the message includes the status |
| `TOO_MANY_REDIRECTS` | More than 5 hops |
| `TOO_LARGE` | Over `maxSourceBytes` |
| `LENGTH_REQUIRED` | Workers, unknown length, over 32 MiB |
| `NOT_FOUND`, `CONFLICT` | Unknown source or credential; duplicate source name |

Messages never contain a credential value. Each error on `sources/fetch` is also saved as the
source's `lastError`.

## Retention

The latest staged upload of each source is kept while the source exists (the daily purge skips
it). Earlier uploads expire under the existing retention rules. Deleting a source deletes its
latest upload unless a job still references it.

## Testing

- Unit, SSRF: a table of URLs and addresses (each blocked range, IPv4-mapped and NAT64 IPv6,
  decimal and hex IPv4 forms, public addresses allowed), blocked hostnames, a stubbed resolver
  returning a private address, a redirect to a private host, credential header kept on same-origin
  and removed on cross-origin hops, more than 5 hops, `allowPrivateNetwork` only in DEV.
- Unit, fetch: conditional headers; `304` and same-hash unchanged; `force`; missing previous
  upload forces a full fetch; size limit from `Content-Length` and while streaming (partial
  upload deleted); both timeouts; the Workers buffering path and `LENGTH_REQUIRED`.
- Unit, routes: credential routes never return values; name and header validation; source
  create, update (clears `lastFetch` on URL change), delete, list, unique names;
  `jobs/create` with `sourceId` (created; a real run of content already imported skipped; forced;
  a dry run then a real run on an unchanged feed creates the job without `force`; a failed
  creation then a retry creates the job) and exactly one of `uploadId` and `sourceId`; retention keeps each source's latest upload.
- Integration on `sites/dev`: a local HTTP server and `allowPrivateNetwork`: first fetch with a
  bearer credential and a completed job; a re-run skipped through `304` and through the hash
  (server without validators); a dry run is never skipped and the real run after it is created
without `force`; a changed body creates a new job; `URL_BLOCKED` with the option
  off; `HTTP_ERROR` for a 404.
- Cloudflare parity on `sites/dev-cf`: one URL import, including a chunked response that takes the
  buffering path.

## Out of scope for M3c

Cron-scheduled fetches (M6); OAuth flows and request bodies (GET only); proxies; HTTP methods
other than GET; per-source format detection from `Content-Type`; XLSX (M3d).
