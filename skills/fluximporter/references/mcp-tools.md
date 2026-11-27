# Flux Importer MCP tools

The site's MCP server lists these as `fluximporter__<name>` once an Administrator turns on Agent
access and the token has `mcp:tools:fluximporter` (or `mcp:tools`). Each tool calls the plugin route
named beside it, so the same input also works as a JSON `POST` to
`/_emdash/api/plugins/fluximporter/<route>`. Over plain HTTP the bearer token needs the `admin`
scope instead of `mcp:tools`, and still belongs to an Administrator.

Errors arrive as tool errors with the text `[CODE] message` and the code in `_meta.code`.

## Reading

### `list_templates` (`templates/list`)

| Input | Type | Notes |
| --- | --- | --- |
| `collection` | string, optional | Only templates that import into this collection (its slug). |
| `cursor` | string, optional | From the previous call. |

Returns up to 8 templates per page: id, name, description, target collection and locale, and
source format, plus a cursor while more exist.

### `get_template` (`templates/get`)

| Input | Type | Notes |
| --- | --- | --- |
| `id` | string | A template id from `list_templates`. |

Returns the template: how source columns or paths map to fields, its record rules and its current
`revision`. Read it before preparing `text` for a dry run.

### `list_sources` (`sources/overview`)

Input: `cursor` (optional). Returns up to 50 URL sources an Administrator set up: id, name, host,
whether it uses a credential, the last fetch (time, HTTP status, bytes) and the last fetch error's
code. URLs, paths and credentials are never shown. Pass a source's id as `sourceId` to `dry_run`.

### `list_schedules` (`schedules/overview`)

Input: `cursor` (optional). Returns the scheduled URL imports: id, name, template and revision,
source id, cron expression (UTC), enabled or paused and why, the next run, the last launch and the
last 5 runs with their counts. Schedules can only be changed by an Administrator in the admin.

### `import_status` (`jobs/status`)

| Input | Type | Notes |
| --- | --- | --- |
| `id` | string | The job's id. |
| `records` | string, optional | An outcome: `planned`, `created`, `updated`, `unchanged`, `failed`, `conflict`, `locked`, `filtered`, `removed`, `reverted` or `writing`. Adds up to 10 rows with that outcome. |
| `cursor` | string, optional | From the previous call with the same `records`. |

Returns the job's summary without advancing it: status, records read, a count per outcome,
warnings, error and `next` (as in `next_batch`). `next: "not_agent"` means the job is unfinished
but wasn't created by `dry_run` or `start_import`, so `next_batch` can't advance it. Rows show short
previews of the mapped values and their errors.

## Importing

### `dry_run` (`jobs/plan`)

| Input | Type | Notes |
| --- | --- | --- |
| `templateId` | string | From `list_templates`. |
| `templateRevision` | number, optional | Refuse with `TEMPLATE_CHANGED` unless the template is at this revision. |
| `text` | string | The data in the template's format (CSV, JSON, JSON Lines or XML), at most 1 MiB, and the request at most 2 MiB once JSON-escaped. Give `text` or `sourceId`. |
| `sourceId` | string | A URL source's id. The source is fetched now. |
| `publish` | boolean, optional | Default `true`. `false` keeps written entries as drafts. |
| `batchSize` | number, optional | Records per `next_batch` call, 1-500, default 50. |
| `budgetMs` | number, optional | Time per `next_batch` call in milliseconds, 500-25000. |

Plans an import without writing entries. Returns `{ job }`. Drive it with `next_batch` until
`done`, then read it with `import_status` and show the user the plan.

### `start_import` (`jobs/start`, destructive)

| Input | Type | Notes |
| --- | --- | --- |
| `dryRunId` | string | A completed dry run's id, from `dry_run`. |
| `batchSize` | number, optional | Default: the dry run's. |
| `budgetMs` | number, optional | Default: the dry run's. |

Imports the dry run's data with the same template revision and options. This is the call that
changes the site: make it only after the user has seen the dry run and agreed. Calling it again with
the same `dryRunId` returns the same job. If the template changed since the dry run, it answers
`TEMPLATE_CHANGED`. Returns `{ job }`.

### `next_batch` (`jobs/step`, destructive)

| Input | Type | Notes |
| --- | --- | --- |
| `id` | string | A job from `dry_run` or `start_import`. |

Runs one batch. Returns `{ id, status, next, processed, total?, busyUntil?, retryAfterMs?, error? }`:

| `next` | What to do |
| --- | --- |
| `next_batch` | Call again, after `retryAfterMs` when it's set. |
| `wait` | Another call is running a batch. Wait `retryAfterMs`, then call again. |
| `done` | Finished. Read the result with `import_status`. |
| `stopped` | Paused, failed or cancelled. See `error` and `import_status`. |

On `INTERNAL_ERROR`, wait 5 seconds and retry; after 3 failures in a row, stop and tell the user.
