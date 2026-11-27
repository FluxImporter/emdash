import type { Msg } from "../../../i18n.js";

/** The Map detail panel's and the key picker's messages. */
export const M = {
	selectedField: { id: "fluximporter.detail.selected-field", message: "Selected field" },
	valueFrom: { id: "fluximporter.detail.value-from", message: "Value from" },
	sourceKey: { id: "fluximporter.detail.source-key", message: "Source key" },
	expression: { id: "fluximporter.detail.expression", message: "Expression" },
	expressionInput: { id: "fluximporter.detail.expression-input", message: "JSONata expression" },
	none: { id: "fluximporter.detail.none", message: "None" },
	keepsKey: {
		id: "fluximporter.detail.keeps-key",
		message: "Until an expression is written, this row keeps the key {key}",
	},
	keepsExpression: {
		id: "fluximporter.detail.keeps-expression",
		message: "Until a key is picked, this row keeps its expression",
	},

	keyPlaceholder: { id: "fluximporter.detail.key-placeholder", message: "Find a key" },
	showKeys: { id: "fluximporter.detail.show-keys", message: "Show all keys" },
	clearKey: { id: "fluximporter.detail.clear-key", message: "Clear the search" },
	noKeyMatches: { id: "fluximporter.detail.no-key-matches", message: "No key matches" },
	keysCapped: {
		id: "fluximporter.detail.keys-capped",
		message: "Showing {shown} of {total} keys: type to find the others",
	},

	mappingType: { id: "fluximporter.detail.mapping-type", message: "Mapping type" },
	types: {
		text: { id: "fluximporter.detail.type.text", message: "Text" },
		number: { id: "fluximporter.detail.type.number", message: "Number" },
		date: { id: "fluximporter.detail.type.date", message: "Date" },
		boolean: { id: "fluximporter.detail.type.boolean", message: "Yes or no" },
		select: { id: "fluximporter.detail.type.select", message: "Option" },
		multiSelect: { id: "fluximporter.detail.type.multi-select", message: "Options" },
		json: { id: "fluximporter.detail.type.json", message: "JSON" },
		slug: { id: "fluximporter.detail.type.slug", message: "Slug" },
		reference: { id: "fluximporter.detail.type.reference", message: "Reference" },
		image: { id: "fluximporter.detail.type.image", message: "Image" },
		file: { id: "fluximporter.detail.type.file", message: "File" },
		portableText: { id: "fluximporter.detail.type.portable-text", message: "Portable Text" },
	},

	decimal: { id: "fluximporter.detail.decimal", message: "Decimal separator" },
	thousands: { id: "fluximporter.detail.thousands", message: "Thousands separator" },
	separatorChars: {
		point: { id: "fluximporter.detail.char.point", message: "Point (.)" },
		comma: { id: "fluximporter.detail.char.comma", message: "Comma (,)" },
		space: { id: "fluximporter.detail.char.space", message: "Space" },
		apostrophe: { id: "fluximporter.detail.char.apostrophe", message: "Apostrophe (')" },
		underscore: { id: "fluximporter.detail.char.underscore", message: "Underscore (_)" },
	},
	thousandsSameAsDecimal: {
		id: "fluximporter.detail.thousands-same-as-decimal",
		message: "The thousands separator must differ from the decimal separator",
	},

	dateFormat: { id: "fluximporter.detail.date-format", message: "Source date format" },
	dateFormatHint: {
		id: "fluximporter.detail.date-format-hint",
		message: "A Luxon format such as dd/MM/yyyy, or unix. Empty reads ISO 8601 dates.",
	},
	timezone: { id: "fluximporter.detail.timezone", message: "Timezone" },
	tzUtc: { id: "fluximporter.detail.tz-utc", message: "UTC" },
	tzSite: { id: "fluximporter.detail.tz-site", message: "The site's timezone" },
	outputFormat: { id: "fluximporter.detail.output-format", message: "Output format" },
	outputFormatHint: {
		id: "fluximporter.detail.output-format-hint",
		message: "How the date is written into this text field. Empty writes yyyy-MM-dd.",
	},

	trueTokens: { id: "fluximporter.detail.true-tokens", message: "Values read as yes" },
	falseTokens: { id: "fluximporter.detail.false-tokens", message: "Values read as no" },
	sharedToken: {
		id: "fluximporter.detail.shared-token",
		message: '"{token}" is both a yes and a no value',
	},
	tooManyTokens: {
		id: "fluximporter.detail.too-many-tokens",
		message: "At most {count} values, each up to {length} characters",
	},
	tokensHint: {
		id: "fluximporter.detail.tokens-hint",
		message: "Separate values with commas. Empty keeps the usual ones.",
	},

	sourceValues: { id: "fluximporter.detail.source-values", message: "Source values" },
	asIs: { id: "fluximporter.detail.as-is", message: "As it is" },
	addValue: { id: "fluximporter.detail.add-value", message: "Add a value" },
	add: { id: "fluximporter.detail.add", message: "Add" },
	valueTooLong: {
		id: "fluximporter.detail.value-too-long",
		message: "A source value is at most {length} characters",
	},
	ignoreCase: { id: "fluximporter.detail.ignore-case", message: "Ignore case" },
	separator: { id: "fluximporter.detail.separator", message: "Separator" },
	separatorHint: {
		id: "fluximporter.detail.separator-hint",
		message: "Splits one source value into several. Empty uses a comma.",
	},

	parseJson: { id: "fluximporter.detail.parse-json", message: "Parse text as JSON" },

	matchBy: { id: "fluximporter.detail.match-by", message: "Match by" },
	matchId: { id: "fluximporter.detail.match-id", message: "Entry ID" },
	matchSlug: { id: "fluximporter.detail.match-slug", message: "Slug" },
	matchKey: { id: "fluximporter.detail.match-key", message: "Import key" },
	matchLabel: { id: "fluximporter.detail.match-label", message: "Label" },
	matchName: { id: "fluximporter.detail.match-name", message: "Name" },

	altText: { id: "fluximporter.detail.alt-text", message: "Alt text" },
	altKey: { id: "fluximporter.detail.alt-key", message: "Alt text key" },
	altExpression: { id: "fluximporter.detail.alt-expression", message: "Alt text expression" },
	refresh: { id: "fluximporter.detail.refresh", message: "Download the file again on every run" },

	ptFormat: { id: "fluximporter.detail.pt-format", message: "Source format" },
	ptFormatRequired: {
		id: "fluximporter.detail.pt-format-required",
		message: "Choose the source's format: Portable Text needs it",
	},
	ptChoose: { id: "fluximporter.detail.pt-choose", message: "Choose a format" },
	ptHtml: { id: "fluximporter.detail.pt-html", message: "HTML" },
	ptMarkdown: { id: "fluximporter.detail.pt-markdown", message: "Markdown" },
	ptText: { id: "fluximporter.detail.pt-text", message: "Plain text" },
	baseUrl: { id: "fluximporter.detail.base-url", message: "Base URL for relative links" },
	baseUrlInvalid: {
		id: "fluximporter.detail.base-url-invalid",
		message: "Enter an absolute http or https address",
	},
	images: { id: "fluximporter.detail.images", message: "Images" },
	imagesImport: { id: "fluximporter.detail.images-import", message: "Import them" },
	imagesSkip: { id: "fluximporter.detail.images-skip", message: "Skip them" },
	imageErrors: {
		id: "fluximporter.detail.image-errors",
		message: "When an image cannot be imported",
	},
	imageErrorsDrop: { id: "fluximporter.detail.image-errors-drop", message: "Leave it out" },
	failRecord: { id: "fluximporter.detail.fail-record", message: "Fail the record" },
	unknownMarkup: { id: "fluximporter.detail.unknown-markup", message: "Markup it cannot convert" },
	unknownMarkupWarn: { id: "fluximporter.detail.unknown-markup-warn", message: "Warn" },

	matchTermsBy: { id: "fluximporter.detail.match-terms-by", message: "Match terms by" },
	termSeparator: { id: "fluximporter.detail.term-separator", message: "Term separator" },
	pathSeparator: { id: "fluximporter.detail.path-separator", message: "Path separator" },
	pathSeparatorHint: {
		id: "fluximporter.detail.path-separator-hint",
		message: "Splits a term into its parents, as in Kitchen/Mugs. Empty uses /.",
	},
	termIsPath: {
		id: "fluximporter.detail.term-is-path",
		message: "The term separator cannot be {char}, the path character",
	},
	termSameAsPath: {
		id: "fluximporter.detail.term-same-as-path",
		message: "The term separator must differ from the path separator",
	},
	pathSameAsTerm: {
		id: "fluximporter.detail.path-same-as-term",
		message: "The path separator must differ from the term separator",
	},
	createTerms: { id: "fluximporter.detail.create-terms", message: "Create missing terms" },
	matchBylinesBy: { id: "fluximporter.detail.match-bylines-by", message: "Match bylines by" },

	sampleValues: { id: "fluximporter.detail.sample-values", message: "Sample values" },
	noSampleValues: {
		id: "fluximporter.detail.no-sample-values",
		message: "The sample has no values for this key",
	},
	emptyValue: { id: "fluximporter.detail.empty-value", message: "(empty)" },
	previewNote: {
		id: "fluximporter.detail.preview-note",
		message: "Converted values show in Preview",
	},

	badge: { id: "fluximporter.detail.badge", message: "{origin} · {band}" },
	originAi: { id: "fluximporter.detail.origin-ai", message: "AI" },
	originName: { id: "fluximporter.detail.origin-name", message: "Name" },
	originTemplate: { id: "fluximporter.detail.origin-template", message: "Template" },
	bandHigh: { id: "fluximporter.detail.band-high", message: "high" },
	bandMedium: { id: "fluximporter.detail.band-medium", message: "medium" },
	bandLow: { id: "fluximporter.detail.band-low", message: "low" },
	check: { id: "fluximporter.detail.check", message: "check" },

	/** The banner of a row to check (StepMap.dc.html): what to look at, then Keep it or Remove the key. */
	reviewAiLow: {
		id: "fluximporter.detail.review-ai-low",
		message: "AI suggested {key} with low confidence.",
	},
	reviewNameLow: {
		id: "fluximporter.detail.review-name-low",
		message: "Name matching suggested {key} with low confidence.",
	},
	reviewAiFormat: {
		id: "fluximporter.detail.review-ai-format",
		message: "AI suggested {key}, but the format of its values is unclear.",
	},
	reviewNameFormat: {
		id: "fluximporter.detail.review-name-format",
		message: "Name matching suggested {key}, but the format of its values is unclear.",
	},
	reviewMissing: {
		id: "fluximporter.detail.review-missing",
		message: "The sample has no key {key}.",
	},
	reviewKey: {
		id: "fluximporter.detail.review-key",
		message: "Check that {key} is the right key for this field.",
	},
	reviewValues: { id: "fluximporter.detail.review-values", message: "Values look like {values}." },
	keepIt: { id: "fluximporter.detail.keep-it", message: "Keep it" },
	removeTheKey: { id: "fluximporter.detail.remove-the-key", message: "Remove the key" },
} satisfies Record<string, Msg | Record<string, Msg>>;
