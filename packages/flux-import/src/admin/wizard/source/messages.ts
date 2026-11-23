import type { Msg } from "../../i18n.js";

/** The Source step's messages. */
export const M = {
	tabUpload: { id: "flux-import.source.tab-upload", message: "Upload file" },
	tabUrl: { id: "flux-import.source.tab-url", message: "From URL" },
	tabPaste: { id: "flux-import.source.tab-paste", message: "Paste" },
	tabSaved: { id: "flux-import.source.tab-saved", message: "Saved source" },

	chooseFile: { id: "flux-import.source.choose-file", message: "Choose a file" },
	fileTypes: {
		id: "flux-import.source.file-types",
		message: "CSV, JSON, JSON Lines (.jsonl or .ndjson), XML or XLSX.",
	},
	uploading: { id: "flux-import.source.uploading", message: "Uploading {name}" },

	address: { id: "flux-import.source.address", message: "Address" },
	name: { id: "flux-import.source.name", message: "Name" },
	nameHint: {
		id: "flux-import.source.name-hint",
		message: "The source is saved under this name, so it can be fetched again later.",
	},
	credential: { id: "flux-import.source.credential", message: "Credential" },
	noCredential: { id: "flux-import.source.no-credential", message: "None" },
	fetch: { id: "flux-import.source.fetch", message: "Fetch" },
	nameTaken: {
		id: "flux-import.source.name-taken",
		message:
			"A saved source is already named {name} and fetches this address. Use it, or choose another name.",
	},
	takenCredential: {
		id: "flux-import.source.taken-credential",
		message: "It fetches with the credential {credential}, not the one chosen here.",
	},
	takenNoCredential: {
		id: "flux-import.source.taken-no-credential",
		message: "It fetches with no credential, not the one chosen here.",
	},
	nameTakenOther: {
		id: "flux-import.source.name-taken-other",
		message:
			"A saved source named {name} fetches a different address ({address}). Choose another name for this one.",
	},
	nameTakenGone: {
		id: "flux-import.source.name-taken-gone",
		message:
			"A saved source is named {name}, but it can no longer be found. Try again, or choose another name.",
	},
	useSaved: { id: "flux-import.source.use-saved", message: "Use the saved source" },

	text: { id: "flux-import.source.text", message: "Text" },
	pasteSize: { id: "flux-import.source.paste-size", message: "{used} KiB of {max} KiB" },
	pasteTooLarge: {
		id: "flux-import.source.paste-too-large",
		message: "The text is larger than 1 MiB, the most that can be pasted. Upload it as a file.",
	},
	useText: { id: "flux-import.source.use-text", message: "Use this text" },
	pastedLabel: { id: "flux-import.source.pasted-label", message: "Pasted text" },

	loadingSources: { id: "flux-import.source.loading-sources", message: "Loading saved sources" },
	noSources: { id: "flux-import.source.no-sources", message: "No saved sources" },
	noSourcesHint: {
		id: "flux-import.source.no-sources-hint",
		message: "A source fetched from a URL is saved here.",
	},
	use: { id: "flux-import.source.use", message: "Use" },
	lastFetchFailed: { id: "flux-import.source.last-fetch-failed", message: "Last fetch failed" },
	neverFetched: { id: "flux-import.source.never-fetched", message: "Never fetched" },
	useSource: { id: "flux-import.source.use-source", message: "Use {name}" },

	format: { id: "flux-import.source.format", message: "Format" },
	formatCsv: { id: "flux-import.source.format-csv", message: "CSV" },
	formatJson: { id: "flux-import.source.format-json", message: "JSON" },
	formatJsonl: { id: "flux-import.source.format-jsonl", message: "JSON Lines" },
	formatXml: { id: "flux-import.source.format-xml", message: "XML" },
	formatXlsx: { id: "flux-import.source.format-xlsx", message: "XLSX" },
	formatAssumed: {
		id: "flux-import.source.format-assumed",
		message:
			"The address names no format, so CSV was assumed. Change it if the data is another format.",
	},
	settings: { id: "flux-import.source.settings", message: "How to read {name}" },
	records: { id: "flux-import.source.records", message: "Records path" },
	recordsJsonHint: {
		id: "flux-import.source.records-json-hint",
		message:
			"Where the records are: dot-separated keys, e.g. data.products. Leave empty for a top-level list.",
	},
	recordsXmlHint: {
		id: "flux-import.source.records-xml-hint",
		message: "Where the records are: element names from the root, e.g. feed/item.",
	},
	sheet: { id: "flux-import.source.sheet", message: "Sheet" },
	sheetHint: {
		id: "flux-import.source.sheet-hint",
		message: "A sheet name, or its number from 1. Leave empty for the first sheet.",
	},
	headerRow: { id: "flux-import.source.header-row", message: "Header row" },
	headerRowHint: {
		id: "flux-import.source.header-row-hint",
		message: "The row that holds the column names. Leave empty for row 1.",
	},
	filter: { id: "flux-import.source.filter", message: "Row filter" },
	filterHint: {
		id: "flux-import.source.filter-hint",
		message: "Optional. A JSONata expression; only records it is true for are imported.",
	},

	sample: { id: "flux-import.source.sample", message: "Sample" },
	sampleKey: { id: "flux-import.source.sample-key", message: "Key" },
	sampleValues: { id: "flux-import.source.sample-values", message: "First values" },
	keysShown: {
		id: "flux-import.source.keys-shown",
		message: "Showing {shown} of {total} keys. Every key can be mapped in the next steps.",
	},
	noRecords: { id: "flux-import.source.no-records", message: "No records were found" },
	noRecordsPathHint: {
		id: "flux-import.source.no-records-path-hint",
		message: "Check the records path, or the file itself.",
	},
	noRecordsHint: {
		id: "flux-import.source.no-records-hint",
		message: "Check that the file holds data.",
	},
	headerOnly: {
		id: "flux-import.source.header-only",
		message: "The file has a header but no rows",
	},
	headerOnlyHint: {
		id: "flux-import.source.header-only-hint",
		message: "Choose a file with at least one record.",
	},

	chooseData: { id: "flux-import.source.choose-data", message: "Choose the data to import" },
	noRecordsReason: {
		id: "flux-import.source.no-records-reason",
		message: "Choose data with at least one record",
	},

	template: { id: "flux-import.source.template", message: "Start from a saved template" },
	templateLabel: { id: "flux-import.source.template-label", message: "Saved template" },
	templateOption: { id: "flux-import.source.template-option", message: "{name} ({collection})" },
	loadTemplate: { id: "flux-import.source.load-template", message: "Load template" },
	loadingTemplates: {
		id: "flux-import.source.loading-templates",
		message: "Loading saved templates",
	},
	noTemplates: { id: "flux-import.source.no-templates", message: "No saved templates" },
	noTemplatesHint: {
		id: "flux-import.source.no-templates-hint",
		message: "A template saved in the Options step can be reused here.",
	},
	templateNoRecords: {
		id: "flux-import.source.template-no-records",
		message:
			"This template's settings find no records in the file. Choose another template or file.",
	},
	templateNeedsFile: {
		id: "flux-import.source.template-needs-file",
		message: "Choose the file to import first",
	},

	wordpress: {
		id: "flux-import.source.wordpress",
		message: "Importing a WordPress export (WXR)?",
	},
	wordpressLink: {
		id: "flux-import.source.wordpress-link",
		message: "Use EmDash's WordPress importer",
	},
} satisfies Record<string, Msg>;
