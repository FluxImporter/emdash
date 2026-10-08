You are building **EmDash Import**: a native EmDash plugin that does what WP All Import does for WordPress (and more), for EmDash — Cloudflare's open-source, Astro-based, TypeScript CMS. EmDash is NOT WordPress. Do not bring over WP/PHP patterns.
 
## Ground rules
- EmDash is on 1.x but changes fast, and your training data is stale. Before writing any EmDash-specific code, check the docs: the `emdash-docs` MCP (`search_docs`), or https://docs.emdashcms.com/llms.txt and then the specific page. If the docs don't cover something, read the source at https://github.com/emdash-cms/emdash (`AGENTS.md`, `skills/`, `packages/`). Never guess APIs, hook names, capability strings or config keys. If something isn't documented, say so and show me where you found the answer in the source.
- TypeScript strict, ESM, `import type`, `.js` extensions on internal imports. No speculative abstractions.
- SQL only through Kysely's `sql` template (`sql.ref()` for identifiers). Every content query filters by `locale`. Content is Portable Text, never stored HTML.
- Verify before calling anything done: typecheck, lint, tests, and a run against a real local EmDash site.
## Phase 0: Verify the architecture (report back before writing any plugin code)
Clone the EmDash repo and answer each of these with file paths and code references:
1. Native plugin runtime: exactly what `ctx` exposes to a native plugin (`definePlugin`). Can it create or alter collections and fields, create users, bylines and menus, and upload media? If it can't, what's the supported path (internal services, the REST API, something else)?
2. Is EmDash's own WXR/Gutenberg/HTML → Portable Text converter exported as a reusable package or function? Give its name and signature.
3. Plugin cron: the real API (`ctx.cron`? a `cron` hook?), whether it works for native plugins, and the status of issues #3391 and #3392 and of native-runtime cron dispatch.
4. Native React admin pages: how they're registered, which host components and APIs are available, and how the page calls plugin routes (auth plus the `X-EmDash-Request: 1` header).
5. How a plugin route receives large file uploads (multipart or streaming?) and where to store them (`emdash.storage`?).
6. Runtime limits for native code on Cloudflare Workers compared with Node: CPU, memory, subrequests, request body size, and whether `eval` / `new Function` are available.
7. How a plugin can expose MCP tools (`<pluginId>__<tool>`).
Then propose the architecture in plan mode and wait for my approval.
## Target feature set
**Sources:** CSV, XML, JSON, XLSX, from an upload, a URL (optionally with auth headers) or a pasted snippet. Use a streaming parser; never load huge files fully into memory. Support record selection with XPath, JSONPath or row filters.
 
**Mapping UI (React admin page):**
- Step wizard: Source → Target collection → Map fields → Options → Preview → Run.
- Drag-and-drop from source fields to EmDash fields, driven by the live schema.
- Optionally create any missing collections and fields from the mapper. Schema changes are additive only: never change the type of an existing field.
- Per-field transforms using a SAFE expression language (e.g. JSONata or a small template syntax). No `eval`, and no user-supplied JS executed on the host.
- AI-assisted mapping: sample about 20 records, compare them with the schema, and suggest mappings the user must confirm.
- Saved templates you can reuse, export and import as JSON.
**Field types:** text, number, boolean, date (with timezone and format), select, relations/references, Portable Text (from HTML or Markdown, with unknown markup reported, never silently dropped), images and files (downloaded from URL, including featured image and galleries), taxonomies (hierarchical, from a delimited path such as `Parent > Child`), bylines/authors, locale and translation linking.
 
**Record handling:**
- A unique-key strategy: a source ID stored per entry, plus a match on slug or any field.
- Choose create only, update only, or both.
- "Update only these fields" and "Never overwrite fields edited in the admin" (compare against revisions).
- Delete, trash or unpublish entries missing from the feed.
- Publish, draft or schedule on import.
- Use `_rev` tokens on updates, and respect edit locks.
**Execution:**
- Jobs persist in plugin storage and run in batches with a saved cursor, so every step is resumable and idempotent. Batch size is configurable and safe within Worker limits.
- Live progress, pause and resume, a cancel button, and a per-record log with errors (CSV download).
- Dry-run mode that shows a per-record diff (create/update/skip/delete) without writing anything.
- Rollback of a finished run, using revisions and trash.
- Scheduled imports from a URL through plugin cron, if Phase 0 confirms cron is reliable. Otherwise document the gap and add a protected "run next batch" route that an external scheduler can call.
**Media:** deduplicate by hash (reuse EmDash's own behaviour), rewrite URLs inside Portable Text, report failed downloads, and respect `maxUploadSize`.
 
**Extensibility:** emit plugin events (import started, record saved, run finished) and expose MCP tools: `list_templates`, `dry_run`, `start_import`, `import_status`.
 
## Non-goals (v1)
No e-commerce, no user/password import, and no WordPress-specific migration (EmDash's built-in WXR/exporter importer covers that; link to it from the UI).
 
## Milestones (stop for my review after each)

> Superseded: the milestone order and the open decisions are now set in
> [the roadmap spec](superpowers/specs/2026-10-07-flux-import-roadmap-design.md) (backend and API first,
> React wizard in M7). The list below is the original order.

1. **Phase 0 report + architecture plan.**
2. **MVP:** CSV upload → one collection. Text, number, date and slug fields. Create/update by source ID. Batched, resumable job. Log. Tests.
3. XML, JSON and XLSX plus URL sources. Record filters. Taxonomies. Media from URL.
4. React mapper UI with templates and dry-run diffs.
5. Portable Text conversion. Relations. Bylines. Locales.
6. Delete-missing, rollback, "don't overwrite edited fields".
7. Scheduling, MCP tools, AI mapping suggestions.
8. Docs (README, a `skills/` entry for agents), plus packaging and publishing via npm.
## Testing
- Unit tests for parsers, transforms and the mapping engine.
- Integration tests against a local EmDash site (Node plus `workerd`), using fixture feeds: 10 rows, 10,000 rows, and malformed input.
- Prove resumability by killing a job mid-run and resuming it without creating duplicates.
- Before each milestone is done: `pnpm typecheck && pnpm lint && pnpm test`, plus a manual run in `pnpm dev`, reported with the results.
Start with Phase 0 now.