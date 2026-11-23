import type { Msg } from "../../../i18n.js";

/** The Map detail panel's and the key picker's messages. */
export const M = {
	valueFrom: { id: "flux-import.detail.value-from", message: "Value from" },
	sourceKey: { id: "flux-import.detail.source-key", message: "Source key" },
	expression: { id: "flux-import.detail.expression", message: "Expression" },
	expressionInput: { id: "flux-import.detail.expression-input", message: "JSONata expression" },
	none: { id: "flux-import.detail.none", message: "None" },

	keyPlaceholder: { id: "flux-import.detail.key-placeholder", message: "Find a key" },
	showKeys: { id: "flux-import.detail.show-keys", message: "Show all keys" },
	clearKey: { id: "flux-import.detail.clear-key", message: "Clear the search" },
	noKeyMatches: { id: "flux-import.detail.no-key-matches", message: "No key matches" },
	keysCapped: {
		id: "flux-import.detail.keys-capped",
		message: "Showing {shown} of {total} keys: type to find the others",
	},

	mappingType: { id: "flux-import.detail.mapping-type", message: "Mapping type" },
	types: {
		text: { id: "flux-import.detail.type.text", message: "Text" },
		number: { id: "flux-import.detail.type.number", message: "Number" },
		date: { id: "flux-import.detail.type.date", message: "Date" },
		boolean: { id: "flux-import.detail.type.boolean", message: "Yes or no" },
		select: { id: "flux-import.detail.type.select", message: "Option" },
		multiSelect: { id: "flux-import.detail.type.multi-select", message: "Options" },
		json: { id: "flux-import.detail.type.json", message: "JSON" },
		slug: { id: "flux-import.detail.type.slug", message: "Slug" },
		reference: { id: "flux-import.detail.type.reference", message: "Reference" },
		image: { id: "flux-import.detail.type.image", message: "Image" },
		file: { id: "flux-import.detail.type.file", message: "File" },
		portableText: { id: "flux-import.detail.type.portable-text", message: "Portable Text" },
	},

	decimal: { id: "flux-import.detail.decimal", message: "Decimal separator" },
	thousands: { id: "flux-import.detail.thousands", message: "Thousands separator" },
	separatorChars: {
		point: { id: "flux-import.detail.char.point", message: "Point (.)" },
		comma: { id: "flux-import.detail.char.comma", message: "Comma (,)" },
		space: { id: "flux-import.detail.char.space", message: "Space" },
		apostrophe: { id: "flux-import.detail.char.apostrophe", message: "Apostrophe (')" },
		underscore: { id: "flux-import.detail.char.underscore", message: "Underscore (_)" },
	},
	thousandsSameAsDecimal: {
		id: "flux-import.detail.thousands-same-as-decimal",
		message: "The thousands separator must differ from the decimal separator",
	},

	dateFormat: { id: "flux-import.detail.date-format", message: "Source date format" },
	dateFormatHint: {
		id: "flux-import.detail.date-format-hint",
		message: "A Luxon format such as dd/MM/yyyy, or unix. Empty reads ISO 8601 dates.",
	},
	timezone: { id: "flux-import.detail.timezone", message: "Timezone" },
	tzUtc: { id: "flux-import.detail.tz-utc", message: "UTC" },
	tzSite: { id: "flux-import.detail.tz-site", message: "The site's timezone" },
	outputFormat: { id: "flux-import.detail.output-format", message: "Output format" },
	outputFormatHint: {
		id: "flux-import.detail.output-format-hint",
		message: "How the date is written into this text field. Empty writes yyyy-MM-dd.",
	},

	trueTokens: { id: "flux-import.detail.true-tokens", message: "Values read as yes" },
	falseTokens: { id: "flux-import.detail.false-tokens", message: "Values read as no" },
	tokensHint: {
		id: "flux-import.detail.tokens-hint",
		message: "Separate values with commas. Empty keeps the usual ones.",
	},

	sourceValues: { id: "flux-import.detail.source-values", message: "Source values" },
	asIs: { id: "flux-import.detail.as-is", message: "As it is" },
	ignoreCase: { id: "flux-import.detail.ignore-case", message: "Ignore case" },
	separator: { id: "flux-import.detail.separator", message: "Separator" },
	separatorHint: {
		id: "flux-import.detail.separator-hint",
		message: "Splits one source value into several. Empty uses a comma.",
	},

	parseJson: { id: "flux-import.detail.parse-json", message: "Parse text as JSON" },

	matchBy: { id: "flux-import.detail.match-by", message: "Match by" },
	matchId: { id: "flux-import.detail.match-id", message: "Entry ID" },
	matchSlug: { id: "flux-import.detail.match-slug", message: "Slug" },
	matchKey: { id: "flux-import.detail.match-key", message: "Import key" },
	matchLabel: { id: "flux-import.detail.match-label", message: "Label" },
	matchName: { id: "flux-import.detail.match-name", message: "Name" },

	altText: { id: "flux-import.detail.alt-text", message: "Alt text" },
	altKey: { id: "flux-import.detail.alt-key", message: "Alt text key" },
	altExpression: { id: "flux-import.detail.alt-expression", message: "Alt text expression" },
	refresh: { id: "flux-import.detail.refresh", message: "Download the file again on every run" },

	ptFormat: { id: "flux-import.detail.pt-format", message: "Source format" },
	ptFormatRequired: {
		id: "flux-import.detail.pt-format-required",
		message: "Choose the source's format: Portable Text needs it",
	},
	ptChoose: { id: "flux-import.detail.pt-choose", message: "Choose a format" },
	ptHtml: { id: "flux-import.detail.pt-html", message: "HTML" },
	ptMarkdown: { id: "flux-import.detail.pt-markdown", message: "Markdown" },
	ptText: { id: "flux-import.detail.pt-text", message: "Plain text" },
	baseUrl: { id: "flux-import.detail.base-url", message: "Base URL for relative links" },
	baseUrlInvalid: {
		id: "flux-import.detail.base-url-invalid",
		message: "Enter an absolute http or https address",
	},
	images: { id: "flux-import.detail.images", message: "Images" },
	imagesImport: { id: "flux-import.detail.images-import", message: "Import them" },
	imagesSkip: { id: "flux-import.detail.images-skip", message: "Skip them" },
	imageErrors: {
		id: "flux-import.detail.image-errors",
		message: "When an image cannot be imported",
	},
	imageErrorsDrop: { id: "flux-import.detail.image-errors-drop", message: "Leave it out" },
	failRecord: { id: "flux-import.detail.fail-record", message: "Fail the record" },
	unknownMarkup: { id: "flux-import.detail.unknown-markup", message: "Markup it cannot convert" },
	unknownMarkupWarn: { id: "flux-import.detail.unknown-markup-warn", message: "Warn" },

	matchTermsBy: { id: "flux-import.detail.match-terms-by", message: "Match terms by" },
	termSeparator: { id: "flux-import.detail.term-separator", message: "Term separator" },
	pathSeparator: { id: "flux-import.detail.path-separator", message: "Path separator" },
	pathSeparatorHint: {
		id: "flux-import.detail.path-separator-hint",
		message: "Splits a term into its parents, as in Kitchen/Mugs. Empty uses /.",
	},
	createTerms: { id: "flux-import.detail.create-terms", message: "Create missing terms" },
	matchBylinesBy: { id: "flux-import.detail.match-bylines-by", message: "Match bylines by" },

	sampleValues: { id: "flux-import.detail.sample-values", message: "Sample values" },
	noSampleValues: {
		id: "flux-import.detail.no-sample-values",
		message: "The sample has no values for this key",
	},
	emptyValue: { id: "flux-import.detail.empty-value", message: "(empty)" },
	previewNote: {
		id: "flux-import.detail.preview-note",
		message: "Converted values show in Preview",
	},

	badge: { id: "flux-import.detail.badge", message: "{origin} · {band}" },
	originAi: { id: "flux-import.detail.origin-ai", message: "AI" },
	originName: { id: "flux-import.detail.origin-name", message: "Name" },
	originTemplate: { id: "flux-import.detail.origin-template", message: "Template" },
	bandHigh: { id: "flux-import.detail.band-high", message: "high" },
	bandMedium: { id: "flux-import.detail.band-medium", message: "medium" },
	bandLow: { id: "flux-import.detail.band-low", message: "low" },
	check: { id: "flux-import.detail.check", message: "check" },
} satisfies Record<string, Msg | Record<string, Msg>>;
