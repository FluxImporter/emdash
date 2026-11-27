# Flux Importer for EmDash

The source of [`@fluximporter/emdash`](packages/emdash/README.md), an importer plugin for
[EmDash](https://emdashcms.com). It brings CSV, JSON, XML and Excel files, and live URL feeds,
into EmDash. You map columns in a visual wizard, preview a dry run, schedule repeat imports and
roll back any run.

- **Using it:** see the [package README](packages/emdash/README.md) and
  [fluximporter.com/emdash](https://www.fluximporter.com/emdash/).
- **AI assistants:** `npx skills add FluxImporter/emdash` installs the
  [`fluximporter` agent skill](skills/fluximporter/SKILL.md), for installing the plugin and running
  imports through its MCP tools.
- **Website:** the docs site lives in its own repo, `FluxImporter/fluximporter-site`.

## Layout

| Path              | What it is                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `skills`          | The agent skill, in the [Agent Skills](https://agentskills.io) format.                           |
| `packages/emdash` | The plugin, published to npm as `@fluximporter/emdash`. The only part that's published.         |
| `sites/dev`       | An EmDash site on Node and SQLite. The integration tests run against it; use it for development. |
| `sites/dev-cf`    | The same site on Cloudflare (workerd, D1 and R2), for the Cloudflare tests.                      |
| `docs`            | The architecture notes, design specs and implementation plans.                                   |
| `scripts`         | Checks the test suites use, such as the admin class check.                                       |

## Development

You need Node 22.16 or later and pnpm 10.

```sh
pnpm install
pnpm --filter fluximporter-dev-site dev   # the dev site at http://localhost:4321
```

Sign in through the dev bypass link the server prints, then open **Imports** in the admin sidebar.
The workspace runs the plugin's TypeScript source directly, so there's no build step while you work.

### Checks

| Command                                             | What it runs                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm typecheck`                                    | TypeScript, for the plugin and its admin.                                     |
| `pnpm lint`                                         | Biome. `pnpm format` fixes formatting.                                        |
| `pnpm test`                                         | Unit and admin tests (Vitest).                                                |
| `pnpm test:integration`                             | Imports against `sites/dev`, run with `astro dev`.                            |
| `pnpm test:cf`                                      | The same flows against `sites/dev-cf` under workerd.                          |
| `pnpm test:build`                                   | A production Cloudflare build of `sites/dev-cf`, run with `wrangler dev`.     |

### Packaging

`pnpm --filter @fluximporter/emdash pack` typechecks, compiles `src` (except the admin) into
`dist`, and writes the tarball. The published package's main entry and upload route point at
`dist`; the admin ships as source, because the site's own build compiles it with EmDash's admin.
To test a tarball as npm would install it, copy `sites/dev` outside the workspace, depend on the
tarball, and run the integration tests with `FLUX_TEST_SITE` set to that copy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) explains.

## License

[MIT](LICENSE)
