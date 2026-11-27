# Contributing

Thanks for helping with Flux Importer. Bug reports, fixes and docs improvements are all welcome.

- **Bugs and ideas:** open an [issue](https://github.com/FluxImporter/emdash/issues/new/choose).
  For anything larger than a small fix, start with an issue, so we can agree on the approach before
  you write the code.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 22.16 or later and pnpm 10. The [README](README.md#development) explains the layout
and how to run the dev site.

```sh
pnpm install
pnpm --filter fluximporter-dev-site dev
```

## Before you open a pull request

Run the checks CI runs:

```sh
pnpm typecheck
pnpm lint        # pnpm format fixes formatting
pnpm test
```

If you change how imports run, also run `pnpm test:integration`; it starts `sites/dev` with
`astro dev`.

Pull requests go to `main`. Keep each one to one change, with a title that says what it does.

## Conventions

- **EmDash APIs come from the docs**, not memory: [docs.emdashcms.com](https://docs.emdashcms.com),
  or the `emdash-docs` MCP server configured in `.mcp.json`. EmDash changes quickly.
- **TypeScript strict, ESM**, `import type` for types and `.js` extensions on relative imports.
- **SQL** goes through Kysely's `sql` template, never string interpolation.
- **Admin UI** uses Kumo components, at the exact Kumo version EmDash's admin ships. Class names
  must exist in EmDash's prebuilt admin stylesheet: `node scripts/check-classes.mjs` checks them,
  and so does a unit test.
- **Every admin string** goes through the translation helpers in `src/admin/i18n.ts`, with an ID
  in the form `fluximporter.<area>.<key>`, and plural forms for counts.
- **Tests** come with every change: unit tests next to the code they cover in `tests/unit`, admin
  tests in `tests/admin`, and integration tests for anything that writes content.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
