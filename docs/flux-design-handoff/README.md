# Flux Importer design handoff

Design source for fluximporter.com and the Flux Importer admin screens in EmDash.
These files are **design mockups, not production code**. Read them for layout, spacing,
colours, copy and behaviour; rebuild them with the real stack.

## Format

Each `*.dc.html` file is one mockup screen or part:

- Markup with inline styles, inside `<x-dc>`. `{{ name }}` placeholders are filled by the
  `renderVals()` function in the `<script type="text/x-dc">` block at the bottom of the file.
- `<sc-for list="{{ items }}" as="x">` repeats markup; `<sc-if value="{{ flag }}">` shows it
  conditionally; `<dc-import name="Header" theme="dark">` embeds the sibling file `Header.dc.html`.
- The theme colours for each component are in a `T` or `K` object in its script
  (`dark` and `light` keys). The animations are `@keyframes` in the page files' `<helmet>`.

## website/ — fluximporter.com (Astro Starlight)

| File | What it is |
| --- | --- |
| `Main.dc.html`, `HomePage.dc.html` | Home page (splash). `HomeLight`, `HomeMobile` are the same page in light / at 375px. |
| `Header`, `Footer`, `InstallBlock`, `FlowDemo` | Home parts. InstallBlock types the command and copies; FlowDemo is the animated import demo. |
| `EmDash.dc.html` | `/emdash/` docs landing page. |
| `GuidePage.dc.html` (+ `Guide`, `GuideLight`) | Guide page template: steps, callouts, table, code, kbd. |
| `ApiPage.dc.html` (+ `ApiJobsCreate`, `ApiMobile`) | API route reference template (jobs/create). |
| `Permissions.dc.html` | Table pattern page. |
| `Search.dc.html`, `NotFound.dc.html` | ⌘K search modal and 404. |
| `Sidebar`, `PrevNext`, `Code` | Docs sidebar with product switcher, previous/next, code block. |
| `Tokens.dc.html`, `Components.dc.html`, `ComponentColumn.dc.html` | Design tokens and component sheet. |
| `Notes.dc.html` | What doesn't map cleanly onto Starlight, and how to handle it. |

`tokens/flux.css` holds every CSS custom property, including the mapping onto Starlight's
`--sl-*` variables.

## admin/ — Flux Importer screens inside the EmDash admin (Kumo 2.6.0)

| File | What it is |
| --- | --- |
| `Critique.dc.html` | Ranked problems with the current screens. |
| `Copy.dc.html` | Copy changes: now → proposed. |
| `Spec.dc.html` | Build notes per screen: Kumo component + Tailwind utilities for each element (data in its script). |
| `Frame.dc.html` | Mock EmDash shell (sidebar + header). Not part of the plugin. |
| `Home.dc.html` | Imports home: title with mark, New import, tabs with counts. |
| `Jobs`, `Templates`, `Sources`, `Schedules` | The four tabs. `States.dc.html` holds empty / loading / failed / 403 / site-import states. |
| `Rollback.dc.html`, `RunLog.dc.html` | Dialogs. Rollback has three stages: check, summary, progress. |
| `Wizard.dc.html`, `StepSource`, `StepMap`, `StepPreview`, `StepRun` | New import wizard. |

The admin mockups draw colours from Kumo's real token values (oklch). In code, use the Kumo
token classes (`bg-kumo-base`, `text-kumo-subtle`, …), never the raw values.

## Known unknowns

- The EmDash plugin registration key in the `astro.config.mjs` samples (`plugins: [...]`)
  and the `r2({ binding: "MEDIA" })` name are guesses.
- API error meanings, nested template fields and the agent tool name `[tool]` are placeholders.
- Permissions rows 4–10 are placeholders.
- All counts, hosts and log lines in the mockups are sample data.
