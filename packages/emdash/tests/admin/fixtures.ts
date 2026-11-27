import { templateSchema } from "../../src/engine/template.js";
import type { Job } from "../../src/engine/types.js";

/**
 * Shared fixtures for the admin's component tests. Tasks 2-15 never modify this file; their own
 * fixtures live in their test files (preflight F21).
 */

/**
 * `GET /_emdash/api/manifest`'s `data` on `sites/dev` (Fact V1), captured from a fresh dev
 * database: collections `pages` and `posts`, locales `en`, `fr` and `de`, taxonomies `category`
 * and `tag` on `posts`.
 */
export const MANIFEST: unknown = {
	version: "1.2.0",
	commit: "b5f37c646",
	astroVersion: "7.3.7",
	hash: "fe27a7fcc3daa78b",
	collections: {
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "preview", "search", "seo"],
			hasSeo: true,
			urlPattern: "/pages/{slug}",
			routable: true,
			fields: {
				title: {
					kind: "string",
					label: "Title",
					required: true,
					translatable: true,
					id: "01M84GM9J875VYTAPPN95YJNH2",
				},
				content: {
					kind: "portableText",
					label: "Content",
					required: false,
					translatable: true,
					id: "01M84GM9J830EKS7JG4RM3BKG9",
				},
			},
		},
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions", "preview", "scheduling", "search", "seo"],
			hasSeo: true,
			urlPattern: "/posts/{slug}",
			routable: true,
			fields: {
				title: {
					kind: "string",
					label: "Title",
					required: true,
					translatable: true,
					id: "01M84GM9J1TCQ6F1W43G4NRP2Q",
				},
				featured_image: {
					kind: "image",
					label: "Featured Image",
					required: false,
					translatable: true,
					id: "01M84GM9J1FW1YA7H1W4QTD7F6",
				},
				content: {
					kind: "portableText",
					label: "Content",
					required: false,
					translatable: true,
					id: "01M84GM9J1J7ZNNR5V5178M02S",
				},
				excerpt: {
					kind: "richText",
					label: "Excerpt",
					required: false,
					translatable: true,
					id: "01M84GM9J1PC8YX7027J984XGY",
				},
			},
		},
	},
	plugins: {
		fluximporter: {
			version: "0.7.0",
			enabled: true,
			adminMode: "react",
			adminPages: [
				{
					path: "/imports",
					label: "Imports",
					icon: "clock-counter-clockwise",
					group: "Imports",
				},
				{
					path: "/import",
					label: "New import",
					icon: "upload-simple",
					group: "Imports",
				},
			],
			dashboardWidgets: [],
		},
	},
	taxonomies: [
		{
			id: "taxdef_category",
			name: "category",
			label: "Categories",
			labelSingular: "Category",
			hierarchical: true,
			collections: ["posts"],
			locale: "en",
			translationGroup: "taxdef_category",
		},
		{
			id: "taxdef_tag",
			name: "tag",
			label: "Tags",
			labelSingular: "Tag",
			hierarchical: false,
			collections: ["posts"],
			locale: "en",
			translationGroup: "taxdef_tag",
		},
	],
	authMode: "passkey",
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "de"],
		prefixDefaultLocale: false,
	},
	contentLocale: {
		defaultLocale: "en",
		implicit: false,
	},
	marketplace: false,
	sandboxEnabled: false,
	timezone: "UTC",
	providerManagedName: false,
	signupEnabled: false,
	admin: {
		siteName: "My Blog",
	},
};

/** `GET /_emdash/api/schema/collections/posts?includeFields=true`'s `data` on `sites/dev`. */
export const POSTS: unknown = {
	item: {
		id: "01M84GM9J1T7E27KK3302927J0",
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts", "revisions", "preview", "scheduling", "search", "seo"],
		source: "seed",
		hasSeo: true,
		urlPattern: "/posts/{slug}",
		routable: true,
		hidden: false,
		commentsEnabled: true,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		editLocking: true,
		createdAt: "2026-11-23 15:33:09",
		updatedAt: "2026-11-23 15:33:09",
		fields: [
			{
				id: "01M84GM9J1TCQ6F1W43G4NRP2Q",
				collectionId: "01M84GM9J1T7E27KK3302927J0",
				slug: "title",
				label: "Title",
				type: "string",
				columnType: "TEXT",
				required: true,
				unique: false,
				sortOrder: 0,
				searchable: true,
				indexed: false,
				translatable: true,
				createdAt: "2026-11-23 15:33:09",
			},
			{
				id: "01M84GM9J1FW1YA7H1W4QTD7F6",
				collectionId: "01M84GM9J1T7E27KK3302927J0",
				slug: "featured_image",
				label: "Featured Image",
				type: "image",
				columnType: "TEXT",
				required: false,
				unique: false,
				sortOrder: 1,
				searchable: false,
				indexed: false,
				translatable: true,
				createdAt: "2026-11-23 15:33:09",
			},
			{
				id: "01M84GM9J1J7ZNNR5V5178M02S",
				collectionId: "01M84GM9J1T7E27KK3302927J0",
				slug: "content",
				label: "Content",
				type: "portableText",
				columnType: "JSON",
				required: false,
				unique: false,
				sortOrder: 2,
				searchable: true,
				indexed: false,
				translatable: true,
				createdAt: "2026-11-23 15:33:09",
			},
			{
				id: "01M84GM9J1PC8YX7027J984XGY",
				collectionId: "01M84GM9J1T7E27KK3302927J0",
				slug: "excerpt",
				label: "Excerpt",
				type: "text",
				columnType: "TEXT",
				required: false,
				unique: false,
				sortOrder: 3,
				searchable: false,
				indexed: false,
				translatable: true,
				createdAt: "2026-11-23 15:33:09",
			},
		],
	},
};

/** A well-formed upload ID (never shown by the wizard). */
export const UPLOAD_ID = `01JZ0000000000000000000000${"0".repeat(32)}`;

/** A new dry run of a posts CSV import, as `jobs/create` returns it; `over` replaces fields. */
export function job(over: Partial<Job> = {}): Job {
	return {
		id: "01JZ00000000000000000JOB01",
		status: "created",
		journal: true,
		uploadId: UPLOAD_ID,
		template: templateSchema.parse({
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "id" },
			fields: { title: { from: "title", type: "text" } },
		}),
		dryRun: true,
		publish: false,
		batchSize: 50,
		budgetMs: 4000,
		source: { format: "csv" },
		columns: ["id", "title"],
		cursor: { offset: 0, seq: 0 },
		counters: {
			created: 0,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
		},
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		failures: 0,
		createdAt: "2026-11-23T12:00:00.000Z",
		updatedAt: "2026-11-23T12:00:00.000Z",
		...over,
	};
}

/** A CSV `sources/sample` answer's `data`: the header row and the sampled rows. */
export function sampleCsv(keys: string[], rows: string[][]): unknown {
	return { headers: keys, rows };
}
