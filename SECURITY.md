# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub:
**[Report a vulnerability](https://github.com/FluxImporter/emdash/security/advisories/new)**
(the repository's **Security** tab, then **Report a vulnerability**).

Don't open a public issue or pull request for a vulnerability. Include:

- the version of `@fluximporter/emdash` and of EmDash, and whether the site runs on Node or
  Cloudflare Workers;
- what an attacker can do, and what access they need (an anonymous visitor, a signed-in user, an
  Administrator, an MCP client);
- the steps or a proof of concept that shows it.

We aim to acknowledge a report within a week, and to agree on a fix and a disclosure date with you.
Fixes ship as a new npm release with a GitHub security advisory.

## Supported versions

Only the latest release on npm gets security fixes. Before 1.0, a fix may come with other changes,
and the release notes say what to update.

## Scope

In scope: the plugin's code in this repository, its API routes, its upload route, its MCP tools
and its admin pages.

Out of scope: EmDash itself (report those to
[emdash-cms/emdash](https://github.com/emdash-cms/emdash/security)), and the trust model of native
plugins, which run with the site's own authority by design (see the
[package README](packages/emdash/README.md#permissions-it-declares-and-why)).
