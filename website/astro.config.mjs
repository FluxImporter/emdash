// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const fonts =
	"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap";

/** A sidebar count (44, 8), restyled as plain mono text in CSS. @param {string} text */
const count = (text) => ({ text, variant: /** @type {const} */ ("default"), class: "fx-count" });

export default defineConfig({
	site: "https://fluximporter.com",
	integrations: [
		starlight({
			title: "Flux Importer",
			// TODO: the repo is private and its default branch is a working branch; set the public
			// repo and branch before launch (same TODO as GITHUB_URL in src/site.ts).
			editLink: {
				baseUrl: "https://github.com/danlapteacru/emdash-fluximporter/edit/main/website/",
			},
			lastUpdated: true,
			routeMiddleware: "./src/starlightRouteData.ts",
			customCss: ["./src/styles/flux.css", "./src/styles/site.css"],
			components: {
				Footer: "./src/components/Footer.astro",
				Header: "./src/components/Header.astro",
				MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
				PageTitle: "./src/components/PageTitle.astro",
				Pagination: "./src/components/Pagination.astro",
				Sidebar: "./src/components/Sidebar.astro",
				TableOfContents: "./src/components/TableOfContents.astro",
				ThemeProvider: "./src/components/ThemeProvider.astro",
				ThemeSelect: "./src/components/ThemeSelect.astro",
			},
			head: [
				{ tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
				{
					tag: "link",
					attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
				},
				{ tag: "link", attrs: { rel: "stylesheet", href: fonts } },
			],
			sidebar: [
				{
					label: "Start here",
					items: [
						{ label: "Install", link: "/emdash/" },
						{ label: "Your first import", link: "/emdash/first-import/" },
						{ label: "Configuration and settings", link: "/emdash/configuration/" },
						{ label: "Permissions", link: "/emdash/permissions/" },
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "The import wizard", link: "/emdash/guides/wizard/" },
						{ label: "Templates", link: "/emdash/guides/templates/" },
						{ label: "URL sources and credentials", link: "/emdash/guides/url-sources/" },
						{ label: "Schedules", link: "/emdash/guides/schedules/" },
						{ label: "Rollback", link: "/emdash/guides/rollback/" },
						{ label: "Record rules", link: "/emdash/guides/record-rules/" },
						{ label: "Missing entries", link: "/emdash/guides/missing-entries/" },
						{ label: "Media", link: "/emdash/guides/media/" },
						{ label: "Taxonomies", link: "/emdash/guides/taxonomies/" },
						{ label: "Translations", link: "/emdash/guides/translations/" },
						{ label: "AI mapping", link: "/emdash/guides/ai-mapping/" },
						{ label: "Imports from AI agents", link: "/emdash/guides/agents/" },
					],
				},
				{
					label: "Reference",
					items: [
						{
							label: "API routes",
							badge: count("44"),
							collapsed: true,
							items: [
								{ label: "jobs", link: "/emdash/reference/api/jobs/" },
								{ label: "templates", link: "/emdash/reference/api/templates/" },
								{ label: "sources", link: "/emdash/reference/api/sources/" },
								{ label: "schedules", link: "/emdash/reference/api/schedules/" },
								{ label: "credentials", link: "/emdash/reference/api/credentials/" },
								{ label: "schema", link: "/emdash/reference/api/schema/" },
							],
						},
						{ label: "Agent tools", link: "/emdash/reference/agent-tools/", badge: count("8") },
						{ label: "Template format", link: "/emdash/reference/template-format/" },
						{ label: "Source formats", link: "/emdash/reference/source-formats/" },
						{ label: "Hooks", link: "/emdash/reference/hooks/" },
						{ label: "Error codes", link: "/emdash/reference/error-codes/" },
						{
							label: "Job states and record outcomes",
							link: "/emdash/reference/job-states/",
						},
						{ label: "Storage", link: "/emdash/reference/storage/" },
					],
				},
				{
					label: "WordPress docs",
					link: "/wordpress/",
					badge: { text: "soon", variant: "default", class: "fx-soon" },
					attrs: { "aria-disabled": "true", class: "fx-soon-link" },
				},
			],
		}),
	],
});
