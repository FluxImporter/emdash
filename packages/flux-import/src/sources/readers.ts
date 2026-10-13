import { csvReader } from "./csv-reader.js";
import { jsonlReader, jsonReader } from "./json.js";
import { recordsPathProblem } from "./paths.js";
import type { RecordReader, TemplateSource } from "./reader.js";
import { xmlReader } from "./xml.js";

/**
 * Problems with a source block that no reader can fix: `records` where it is not allowed,
 * missing where it is required, or not a valid path.
 */
export function checkSource(source: TemplateSource): string[] {
	const { format, records } = source;
	if (format === "csv" || format === "jsonl") {
		return records === undefined ? [] : [`source.records is not allowed for ${format}`];
	}
	if (records === undefined) {
		return format === "xml" ? ['source.records is required for xml, as in "feed/item"'] : [];
	}
	const problem = recordsPathProblem(records, format);
	return problem === null ? [] : [`source.records: ${problem}`];
}

/** The reader for a source block that passed `checkSource`. */
export function readerFor(source: TemplateSource, columns: readonly string[] = []): RecordReader {
	switch (source.format) {
		case "csv":
			return csvReader(columns);
		case "json":
			return jsonReader(source.records);
		case "jsonl":
			return jsonlReader();
		case "xml":
			return xmlReader(source.records ?? "");
	}
}
