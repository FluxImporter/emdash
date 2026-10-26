import { csvReader } from "./csv-reader.js";
import { jsonlReader, jsonReader } from "./json.js";
import { recordsPathProblem } from "./paths.js";
import type { RecordReader, TemplateSource } from "./reader.js";
import { xmlReader } from "./xml.js";

/**
 * Problems with a source block that no reader can fix: `records` where it is not allowed,
 * missing where it is required, or not a valid path; `sheet` or `headerRow` outside xlsx.
 */
export function checkSource(source: TemplateSource): string[] {
	const { format, records } = source;
	const problems: string[] = [];
	if (format !== "xlsx") {
		for (const key of ["sheet", "headerRow"] as const) {
			if (source[key] !== undefined) problems.push(`source.${key} is only allowed for xlsx`);
		}
	}
	if (format === "csv" || format === "jsonl" || format === "xlsx") {
		if (records !== undefined) problems.push(`source.records is not allowed for ${format}`);
		return problems;
	}
	if (records === undefined) {
		if (format === "xml") problems.push('source.records is required for xml, as in "feed/item"');
		return problems;
	}
	const problem = recordsPathProblem(records, format);
	if (problem !== null) problems.push(`source.records: ${problem}`);
	return problems;
}

/**
 * The reader for a source block that passed `checkSource`. An XLSX job reads the JSON Lines its
 * sheet was converted to at job creation.
 */
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
		case "xlsx":
			return jsonlReader();
	}
}
