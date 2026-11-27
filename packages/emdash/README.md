# Flux Importer for EmDash

Import CSV, JSON, XML, Excel and ZIP files, and live URL feeds, into [EmDash](https://emdashcms.com).
You map columns to fields in a visual wizard, preview a dry run, schedule repeat imports and roll
back any run. Built for EmDash 1.2 and later.

Documentation: **[fluximporter.com/emdash](https://www.fluximporter.com/emdash/)**

## Requirements

- EmDash 1.2 or later, on Node 22 or Cloudflare Workers
- Astro 6 or later, with `@astrojs/react` (EmDash's admin needs it already). Releases are tested
  with Astro 7.
- `@cloudflare/kumo` at the version EmDash's admin uses: 2.6.0 for EmDash 1.2

## Install

```sh
pnpm add @fluximporter/emdash
```

Register two things in `astro.config.mjs`:

- **`fluxImporter()`** goes in EmDash's `plugins`. It's the plugin itself: the admin pages, the
  API and the scheduled tasks.
- **`fluxImporterRoutes()`** goes in Astro's `integrations`. It adds the streamed upload route.
  EmDash's plugin routes cap request bodies at 8 MiB, so large files are uploaded through this
  route instead.

```js
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fluxImporter, fluxImporterRoutes } from "@fluximporter/emdash";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			plugins: [fluxImporter()],
		}),
		fluxImporterRoutes(),
	],
});
```

On Cloudflare, use `d1()` and `r2()` from `@emdash-cms/cloudflare` instead; nothing else changes.

Then start the site, sign in to the admin at `/_emdash/admin` and open **Imports** in the sidebar.

### Options

`fluxImporterRoutes()` takes:

| Option                | Default         | What it does                                                                                     |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `maxSourceBytes`      | 52428800 (50 MiB) | The largest file the upload route accepts, and the largest URL source it fetches.             |
| `allowPrivateNetwork` | `false`         | Lets URL sources reach private and loopback addresses. Only for local development: production builds ignore it. |

`fluxImporter()` takes no options.

### Settings

Administrators change these on the plugin's settings page in the admin:

| Setting                          | Default | What it does                                                                                          |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Keep import logs for (days)      | 30      | Job records and staged files older than this are deleted hourly.                                       |
| Mapping suggestions              | None    | `None` matches fields by name only. `Anthropic` or an OpenAI-compatible endpoint also suggests a mapping. |
| Provider API key, Model, Base URL | empty  | For the suggestion provider above.                                                                     |

Secrets (the provider key and URL source credentials) are stored encrypted, so the site needs
`EMDASH_ENCRYPTION_KEY` set to use them.

When suggestions are on, each one sends the provider the target collection's name and the
fields that name matching didn't settle, the column names and up to 5 sample records, each value cut
to 200 characters. It never sends IDs, source URLs, credentials or user details.

## Who can use it

Every page and API route needs EmDash's `import:execute` permission, which only Administrators
have. Scheduled imports run as the Administrator who set them up, and stop if that user no longer
holds the permission.

## Permissions it declares, and why

Flux Importer is a **native** plugin: it runs in your site's own process, like any npm package you
add to your Astro config. The capabilities below tell administrators what it does; for a native
plugin they are not an isolation boundary. Install it only if you trust the publisher.

| Capability                     | Why                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content:read`                 | An import reads existing entries to match each record to the entry it updates.                                                                                                                                                |
| `content:write`                | An import creates and updates entries. Entries that left the source can be moved to the trash or unpublished, when you choose that.                                                                                                              |
| `content:publish`              | An import can publish the entries it writes, or schedule them, when you choose to.                                                                                                                                                       |
| `content:restore`              | A rollback restores entries an import moved to the trash.                                                                                                                                                                     |
| `schema:read`                  | The wizard lists your collections and fields to map columns to.                                                                                                                                                               |
| `taxonomies:write`             | An import looks up categories and tags by name, and creates the ones that don't exist yet.                                                                                                                                    |
| `bylines:read`                 | An import looks up existing bylines by name to credit entries. It never creates bylines.                                                                                                                                      |
| `media:write`                  | An import uploads the images and files that image and file fields point to.                                                                                                                                                   |
| `users:read`                   | Before each scheduled run, it checks that the Administrator who set the schedule still exists and can import.                                                                                                                 |
| `network:request:unrestricted` | It fetches URLs an Administrator enters: URL sources, the media your records point to, and the suggestion provider. Their hosts aren't known in advance, so they can't be listed. Private and loopback addresses are refused. |

The wizard can also add one field to a collection, `flux_source_id`, which links each entry to its
record in the source, and can create the fields you map to, when you choose that. Plugins can't
declare a capability for schema changes, so this one is listed here instead.

## What it stores

Its own data lives in EmDash's plugin storage under the ID `fluximporter`: jobs and their record
logs, templates, URL sources, schedules and the journal that rollbacks use. Uploaded files are
staged in your site's media storage until the job no longer needs them.

## MCP tools for agents

Eight of its routes are also MCP tools on your site's MCP server: listing templates, sources and
schedules, a dry run, starting an import, running it batch by batch, and checking its status. An
Administrator enables them once under **Agent access**. A token needs the `mcp:tools:fluximporter`
(or `mcp:tools`) scope, and the user behind it still needs `import:execute`. Starting an import and
running a batch are marked destructive, so clients ask before each call.

## Upgrading

Update `@fluximporter/emdash` and `emdash` together. When an EmDash release moves its admin to a
new Kumo version, a Flux Importer release follows with the matching `@cloudflare/kumo` version.
Releases before 1.0 may change stored data or options; the release notes say how.

## License

MIT
