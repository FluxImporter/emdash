import type { Template } from "../engine/template.js";

/** The browser's view of EmDash's schema and manifest reads (Fact V1), and of a sample. */

/** A collection field, from the schema API (preflight F6). */
export interface SchemaField {
	slug: string;
	label: string;
	type: string;
	required: boolean;
	/** A select's or multi-select's options. */
	options?: string[];
	/** The field has a default value, so leaving it unmapped is not an error. */
	hasDefault: boolean;
	translatable: boolean;
	/** EmDash cannot read the field's type; a collection holding one cannot be imported into. */
	unsupported: boolean;
	/** A reference field: its target collection, and whether it is bound to a relation. */
	reference?: { target: string | null; bound: boolean };
}

export interface CollectionInfo {
	slug: string;
	label: string;
	hidden: boolean;
}

export interface TaxonomyInfo {
	name: string;
	label: string;
	hierarchical: boolean;
	collections: string[];
}

export interface SiteInfo {
	collections: CollectionInfo[];
	locales: string[];
	defaultLocale: string;
	taxonomies: TaxonomyInfo[];
}

/** One sampled key: one value per sampled record, `undefined` where the record lacks it. */
export interface SampleColumn {
	key: string;
	values: unknown[];
}

/** A template's `source` block (preflight F5). */
export type SourceBlock = Template["source"];

/** The `jobs/create` body the wizard sends. */
export interface CreateJobInput {
	uploadId: string;
	dryRun: boolean;
	template?: unknown;
	templateId?: string;
	templateRevision?: number;
	publish: boolean;
	batchSize?: number;
	journal: true;
	missing?: false | { maxPercent: number };
	/** The Jobs tab shows the job as the wizard's (`Job.origin`). */
	origin: "wizard";
}
