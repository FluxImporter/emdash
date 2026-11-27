import type { Msg, PluralMsg } from "../../i18n.js";

/** The Source step's messages. */
export const M = {
	tabUpload: { id: "fluximporter.source.tab-upload", message: "Upload a file" },
	tabUrl: { id: "fluximporter.source.tab-url", message: "From a URL" },
	tabPaste: { id: "fluximporter.source.tab-paste", message: "Paste" },
	tabSaved: { id: "fluximporter.source.tab-saved", message: "Saved source" },

	chooseFile: { id: "fluximporter.source.choose-file", message: "Choose a file" },
	chooseAnother: { id: "fluximporter.source.choose-another", message: "Choose another file" },
	/** Used by the Templates tab's import dialog; the Upload tab says "Choose a file". */
	browseFiles: { id: "fluximporter.source.browse-files", message: "Browse files" },
	fileTypes: {
		id: "fluximporter.source.file-types",
		message: "CSV, JSON, JSON Lines (.jsonl or .ndjson), XML or XLSX.",
	},
	uploading: { id: "fluximporter.source.uploading", message: "Uploading {name}" },

	address: { id: "fluximporter.source.address", message: "Address" },
	name: { id: "fluximporter.source.name", message: "Name" },
	nameHint: {
		id: "fluximporter.source.name-hint",
		message: "The source is saved under this name, so it can be fetched again later.",
	},
	credential: { id: "fluximporter.source.credential", message: "Credential" },
	noCredential: { id: "fluximporter.source.no-credential", message: "None" },
	fetch: { id: "fluximporter.source.fetch", message: "Fetch" },
	nameTaken: {
		id: "fluximporter.source.name-taken",
		message:
			"A saved source is already named {name} and fetches this address. Use it, or choose another name.",
	},
	takenCredential: {
		id: "fluximporter.source.taken-credential",
		message: "It fetches with the credential {credential}, not the one chosen here.",
	},
	takenNoCredential: {
		id: "fluximporter.source.taken-no-credential",
		message: "It fetches with no credential, not the one chosen here.",
	},
	nameTakenOther: {
		id: "fluximporter.source.name-taken-other",
		message:
			"A saved source named {name} fetches a different address ({address}). Choose another name for this one.",
	},
	nameTakenGone: {
		id: "fluximporter.source.name-taken-gone",
		message:
			"A saved source is named {name}, but it can no longer be found. Try again, or choose another name.",
	},
	useSaved: { id: "fluximporter.source.use-saved", message: "Use the saved source" },

	text: { id: "fluximporter.source.text", message: "Text" },
	pasteSize: { id: "fluximporter.source.paste-size", message: "{used} KiB of {max} KiB" },
	pasteTooLarge: {
		id: "fluximporter.source.paste-too-large",
		message: "The text is larger than 1 MiB, the most that can be pasted. Upload it as a file.",
	},
	useText: { id: "fluximporter.source.use-text", message: "Use this text" },
	pastedLabel: { id: "fluximporter.source.pasted-label", message: "Pasted text" },

	loadingSources: { id: "fluximporter.source.loading-sources", message: "Loading saved sources" },
	noSources: { id: "fluximporter.source.no-sources", message: "No saved sources" },
	noSourcesHint: {
		id: "fluximporter.source.no-sources-hint",
		message: "A source fetched from a URL is saved here.",
	},
	use: { id: "fluximporter.source.use", message: "Use" },
	lastFetchFailed: { id: "fluximporter.source.last-fetch-failed", message: "Last fetch failed" },
	neverFetched: { id: "fluximporter.source.never-fetched", message: "Never fetched" },
	useSource: { id: "fluximporter.source.use-source", message: "Use {name}" },

	format: { id: "fluximporter.source.format", message: "Format" },
	formatCsv: { id: "fluximporter.source.format-csv", message: "CSV" },
	formatJson: { id: "fluximporter.source.format-json", message: "JSON" },
	formatJsonl: { id: "fluximporter.source.format-jsonl", message: "JSON Lines" },
	formatXml: { id: "fluximporter.source.format-xml", message: "XML" },
	formatXlsx: { id: "fluximporter.source.format-xlsx", message: "XLSX" },
	formatAssumed: {
		id: "fluximporter.source.format-assumed",
		message:
			"The address names no format, so CSV was assumed. Change it if the data is another format.",
	},
	settings: { id: "fluximporter.source.settings", message: "How to read it" },
	records: { id: "fluximporter.source.records", message: "Records path" },
	recordsJsonHint: {
		id: "fluximporter.source.records-json-hint",
		message:
			"Where the records are: dot-separated keys, e.g. data.products. Leave empty for a top-level list.",
	},
	recordsXmlHint: {
		id: "fluximporter.source.records-xml-hint",
		message: "Where the records are: element names from the root, e.g. feed/item.",
	},
	sheet: { id: "fluximporter.source.sheet", message: "Sheet" },
	sheetHint: {
		id: "fluximporter.source.sheet-hint",
		message: "A sheet name, or its number from 1. Leave empty for the first sheet.",
	},
	headerRow: { id: "fluximporter.source.header-row", message: "Header row" },
	headerRowHint: {
		id: "fluximporter.source.header-row-hint",
		message: "The row that holds the column names. Leave empty for row 1.",
	},
	filter: { id: "fluximporter.source.filter", message: "Row filter" },
	filterHint: {
		id: "fluximporter.source.filter-hint",
		message: "Optional. A JSONata expression. Only records it is true for are imported.",
	},

	sample: { id: "fluximporter.source.sample", message: "Sample" },
	sampleKey: { id: "fluximporter.source.sample-key", message: "Key" },
	sampleLooks: { id: "fluximporter.source.sample-looks", message: "Looks like" },
	looksText: { id: "fluximporter.source.looks-text", message: "Text" },
	looksNumber: { id: "fluximporter.source.looks-number", message: "Number" },
	looksDate: { id: "fluximporter.source.looks-date", message: "Date" },
	sampleValues: { id: "fluximporter.source.sample-values", message: "First values" },
	keysShown: {
		id: "fluximporter.source.keys-shown",
		message: "Showing {shown} of {total} keys. Every key can be mapped in the next steps.",
	},
	noRecords: { id: "fluximporter.source.no-records", message: "No records were found" },
	noRecordsPathHint: {
		id: "fluximporter.source.no-records-path-hint",
		message: "Check the records path, or the file itself.",
	},
	noRecordsHint: {
		id: "fluximporter.source.no-records-hint",
		message: "Check that the file holds data.",
	},
	headerOnly: {
		id: "fluximporter.source.header-only",
		message: "The file has a header but no rows",
	},
	headerOnlyHint: {
		id: "fluximporter.source.header-only-hint",
		message: "Choose a file with at least one record.",
	},

	chooseData: { id: "fluximporter.source.choose-data", message: "Choose the data to import" },
	noRecordsReason: {
		id: "fluximporter.source.no-records-reason",
		message: "Choose data with at least one record",
	},

	template: { id: "fluximporter.source.template", message: "Start from a template" },
	optional: { id: "fluximporter.source.optional", message: "· optional" },
	templateLabel: { id: "fluximporter.source.template-label", message: "Saved template" },
	templatePlaceholder: {
		id: "fluximporter.source.template-placeholder",
		message: "Choose a template",
	},
	templateOption: { id: "fluximporter.source.template-option", message: "{name} ({collection})" },
	loadTemplate: { id: "fluximporter.source.load-template", message: "Load template" },
	loadingTemplates: {
		id: "fluximporter.source.loading-templates",
		message: "Loading saved templates",
	},
	noTemplates: { id: "fluximporter.source.no-templates", message: "No saved templates" },
	noTemplatesHint: {
		id: "fluximporter.source.no-templates-hint",
		message: "A template saved in the Options step can be reused here.",
	},
	templateNoRecords: {
		id: "fluximporter.source.template-no-records",
		message:
			"This template's settings find no records in the file. Choose another template or file.",
	},
	templateNeedsFile: {
		id: "fluximporter.source.template-needs-file",
		message: "Choose the file to import first",
	},
	templateChooseData: {
		id: "fluximporter.source.template-choose-data",
		message: "Choose the data, then use the template.",
	},

	wordpress: {
		id: "fluximporter.source.wordpress",
		message: "Importing a WordPress export (WXR)?",
	},
	wordpressLink: {
		id: "fluximporter.source.wordpress-link",
		message: "Use EmDash's WordPress importer",
	},
} satisfies Record<string, Msg>;

/** The counts the Source step shows: the sample's records and keys. */
export const COUNT = {
	records: {
		id: "fluximporter.source.count-records",
		one: "{count} record",
		other: "{count} records",
	},
	/** The sample is full: the source may hold more. */
	recordsAtLeast: {
		id: "fluximporter.source.count-records-at-least",
		one: "{count}+ record",
		other: "{count}+ records",
	},
	keys: { id: "fluximporter.source.count-keys", one: "{count} key", other: "{count} keys" },
	firstValues: {
		id: "fluximporter.source.count-first-values",
		one: "First {shown} of {count} record",
		other: "First {shown} of {count} records",
	},
} satisfies Record<string, PluralMsg>;
