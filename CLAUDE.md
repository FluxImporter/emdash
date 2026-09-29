# Project rules — EmDash

This project is built on EmDash, Cloudflare's open-source CMS: full-stack TypeScript on Astro and MIT-licensed. It is not WordPress, so don't bring over WP/PHP patterns (hooks, `functions.php`, Gutenberg blocks, the options table).

## Source of truth: docs, not memory

EmDash is on 1.x but still changes fast (additive releases every few days), so model training data is stale or missing. Before writing EmDash-specific code:

1. Query the Docs MCP (`emdash-docs` → `search_docs`), or
2. Read llms.txt: https://docs.emdashcms.com/llms.txt (index of all doc pages), then fetch the specific page.
3. If both fail, check the repo: https://github.com/emdash-cms/emdash (`AGENTS.md`, `skills/`).

Never guess APIs, config keys, hook names or capability strings. If the docs don't cover something, say so.

Key pages:

- Getting started: https://docs.emdashcms.com/getting-started/
- CLI: https://docs.emdashcms.com/reference/cli/
- Site MCP server: https://docs.emdashcms.com/reference/mcp-server/
- AI tools: https://docs.emdashcms.com/guides/ai-tools/
- Plugins: https://docs.emdashcms.com/plugins/overview/ · capabilities: https://docs.emdashcms.com/plugins/creating-plugins/capabilities/
- Themes: https://docs.emdashcms.com/themes/overview/

## MCP servers

- emdash-docs (public, read-only, no auth): `https://docs.emdashcms.com/mcp`. Configured in `.mcp.json`.
- Site MCP (content, schema, media, taxonomies, menus, settings, revisions): `<site-url>/_emdash/api/mcp`. Auth is OAuth 2.1 or a PAT (`ec_pat_…`); session cookies don't work. It's enabled by default (`mcp: false` in the Astro config disables it).
- When working with site content, ask for the schema first (`schema_list_collections` / `schema_get_collection`) before creating or updating content.
- Never commit PATs or OAuth credentials. Keep them in env vars or a local, gitignored config.

## CLI (`npx emdash` or `em`)

- `init`, `doctor`, `seed`, `migrate`, `export-seed` for the local DB and seeds
- `types` generates TS types from the live schema. Run it after any schema change.
- `login` / `whoami`, then `content`, `schema`, `media`, `search`, `taxonomy`, `menu`, `site` (export/import)
- Prefer the CLI or MCP over editing the DB by hand.

## Architecture rules

- Schema lives in the DB (`_emdash_collections`, `_emdash_fields`). Each collection is a real SQL table (`ec_<name>`). Change schema through the admin, CLI or MCP, not raw SQL.
- Content is structured Portable Text (JSON), not HTML. Render it with components; don't store markup.
- Content tables are row-per-locale. Every content query must filter by `locale`.
- SQL: never interpolate values. Use Kysely's `sql` template; use `sql.ref()` for identifiers.
- API routes: `export const prerender = false;` and get the runtime via `const { emdash } = locals;`.
- State-changing requests need the `X-EmDash-Request: 1` header (CSRF).
- Use `import.meta.env.DEV/PROD`, never `process.env.NODE_ENV`. Dev-only endpoints return 403 in production.
- Storage goes through `emdash.storage` (local in dev, R2/S3 in prod).

## Plugins

- Sandboxed (Worker isolates). Declare the minimum capabilities in the manifest (e.g. `read:content`, `email:send`), and justify each one.
- Use plugin KV storage and lifecycle hooks as documented. There's no global state or direct DB access.

## Code style

- TypeScript strict, ESM, `import type` for types, `.js` extensions on internal imports.
- Keep it simple: no speculative abstractions. Match existing project conventions first.
- Verify before calling work done: typecheck, lint, and run the dev server or tests when relevant.
