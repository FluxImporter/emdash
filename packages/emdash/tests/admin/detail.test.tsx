import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useT } from "../../src/admin/i18n.js";
import type { SampleColumn, SchemaField, TaxonomyInfo } from "../../src/admin/types.js";
import {
	badgeText,
	DetailPanel,
	type DetailRow,
} from "../../src/admin/wizard/map/detail/DetailPanel.js";
import { KeyPicker } from "../../src/admin/wizard/map/detail/KeyPicker.js";
import type { RowMapping, RowMeta } from "../../src/admin/wizard/state.js";
import { renderAdmin } from "./harness.js";

/** Task 8's own fixtures (preflight F21: never in `fixtures.ts`). */

const COLUMNS: SampleColumn[] = [
	{ key: "Name", values: ["Mug", undefined, "Cup", "Bowl", "Plate", "Jug", "Spoon"] },
	{ key: "Price", values: ["12,50", "1.234,00"] },
	{ key: "Released", values: ["07/03/2024", "31/12/2023"] },
	{ key: "Status", values: ["draft", "live", "live", undefined] },
	{ key: "Tags", values: ["red, blue", "blue"] },
	{ key: "Body", values: ["<p>Hi</p>"] },
	{ key: "Cats", values: ["Kitchen/Mugs"] },
];

function field(type: string, extra: Partial<SchemaField> = {}): SchemaField {
	return {
		slug: "f",
		label: "F",
		type,
		required: false,
		hasDefault: false,
		translatable: true,
		unsupported: false,
		...extra,
	};
}

const fieldRow = (type: string, extra: Partial<SchemaField> = {}): DetailRow => ({
	id: "field:f",
	label: "F",
	kind: "field",
	field: field(type, extra),
});

/** The panel inside a host that keeps the mapping, as the wizard's reducer does. */
function setup(
	row: DetailRow,
	mapping?: RowMapping,
	opts: { meta?: RowMeta; columns?: SampleColumn[] } = {},
) {
	const onChange = vi.fn<(m: RowMapping | null) => void>();
	const onKeep = vi.fn<() => void>();
	function Host() {
		const [current, setCurrent] = useState<RowMapping | undefined>(mapping);
		return (
			<DetailPanel
				row={row}
				mapping={current}
				meta={opts.meta}
				columns={opts.columns ?? COLUMNS}
				onChange={(m) => {
					onChange(m);
					setCurrent(m ?? undefined);
				}}
				onKeep={onKeep}
			/>
		);
	}
	return { ...renderAdmin(<Host />), onChange, onKeep };
}

/** The last mapping the panel wrote. */
const last = (onChange: ReturnType<typeof setup>["onChange"]) => onChange.mock.lastCall?.[0];

/** Opens a Kumo select by its label and picks an option. */
async function choose(user: ReturnType<typeof setup>["user"], label: string, option: string) {
	await user.click(screen.getByRole("combobox", { name: label }));
	await user.click(await screen.findByRole("option", { name: option }));
}

describe("DetailPanel", () => {
	it("maps a key without dragging: pick with the keyboard, Enter sets from", async () => {
		const { user, onChange } = setup(fieldRow("string"));
		screen.getByRole("combobox", { name: "Source key" }).focus();
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(last(onChange)).toStrictEqual({ type: "text", from: "Name" });
	});

	it("keeps the mapping's settings on a pick and drops its expression", async () => {
		const { user, onChange } = setup(fieldRow("number"), {
			type: "number",
			expr: "$number(Price)",
			decimal: ",",
		});
		await user.click(screen.getByRole("radio", { name: "Source key" }));
		await user.click(screen.getByRole("combobox", { name: "Source key" }));
		await user.click(screen.getByRole("option", { name: "Price" }));
		expect(last(onChange)).toStrictEqual({ type: "number", from: "Price", decimal: "," });
	});

	it("writes only from for the key row", async () => {
		const { user, onChange } = setup({ id: "key", label: "Key", kind: "key" });
		await user.click(screen.getByRole("combobox", { name: "Source key" }));
		await user.click(screen.getByRole("option", { name: "Status" }));
		expect(last(onChange)).toStrictEqual({ from: "Status" });
		expect(screen.queryByRole("combobox", { name: "Mapping type" })).toBeNull();
	});

	// Renders up to 271 options at once, so it gets a longer timeout for a loaded full-suite run.
	it("finds a key past the first 200 by typing (Review Focus 4)", async () => {
		const columns = Array.from({ length: 1000 }, (_, i) => ({ key: `key-${i}`, values: [i] }));
		const { user, onChange } = setup(fieldRow("string"), undefined, { columns });
		const picker = screen.getByRole("combobox", { name: "Source key" });
		await user.click(picker);
		expect(screen.getAllByRole("option")).toHaveLength(200);
		expect(screen.getByText("Showing 200 of 1,000 keys: type to find the others")).toBeVisible();
		await user.type(picker, "KEY-999");
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["key-999"]);
		await user.clear(picker);
		await user.type(picker, "-99");
		// No cap while filtering: key-99 and key-990 to key-999.
		expect(screen.getAllByRole("option")).toHaveLength(11);
		await user.click(screen.getByRole("option", { name: "key-999" }));
		expect(last(onChange)).toStrictEqual({ type: "text", from: "key-999" });
		// Reopened on the chosen key, the list is capped again.
		await user.click(picker);
		expect(screen.getAllByRole("option")).toHaveLength(200);
		await user.keyboard("{Escape}");
		// More than 200 matches are all listed; a reopened list with no query is capped again.
		await user.clear(picker);
		// 271 of the keys hold a 9.
		await user.type(picker, "9");
		expect(screen.getAllByRole("option")).toHaveLength(271);
		await user.keyboard("{Escape}");
		await user.clear(picker);
		await user.click(picker);
		expect(screen.getAllByRole("option")).toHaveLength(200);
	}, 15_000);

	it("switches to Expression and drops from", async () => {
		const { user, onChange } = setup(fieldRow("string"), { type: "text", from: "Name" });
		await user.click(screen.getByRole("radio", { name: "Expression" }));
		expect(onChange).not.toHaveBeenCalled();
		// Until an expression is written, the panel says which key the row still uses.
		const KEEPS = "Until an expression is written, this row keeps the key Name";
		expect(screen.getByText(KEEPS)).toBeVisible();
		const input = screen.getByRole("textbox", { name: "JSONata expression" });
		await user.type(input, "$uppercase(Name)");
		await user.tab();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(last(onChange)).toStrictEqual({ type: "text", expr: "$uppercase(Name)" });
		expect(screen.queryByRole("combobox", { name: "Source key" })).toBeNull();
		expect(screen.queryByText(/^Until an expression is written/)).toBeNull();
	});

	it("says the expression stays until a key is picked", async () => {
		const { user, onChange } = setup(fieldRow("string"), { type: "text", expr: "Name" });
		const KEEPS = "Until a key is picked, this row keeps its expression";
		expect(screen.queryByText(KEEPS)).toBeNull();
		await user.click(screen.getByRole("radio", { name: "Source key" }));
		expect(screen.getByText(KEEPS)).toBeVisible();
		await user.click(screen.getByRole("combobox", { name: "Source key" }));
		await user.click(screen.getByRole("option", { name: "Price" }));
		expect(last(onChange)).toStrictEqual({ type: "text", from: "Price" });
		expect(screen.queryByText(KEEPS)).toBeNull();
	});

	it("keeps the mapping when an expression is left empty", async () => {
		const { user, onChange } = setup(fieldRow("string"), { type: "text", expr: "Name" });
		expect(screen.getByRole("radio", { name: "Expression" })).toBeChecked();
		const input = screen.getByRole("textbox", { name: "JSONata expression" });
		await user.clear(input);
		await user.tab();
		expect(onChange).not.toHaveBeenCalled();
		expect(input).toHaveValue("Name");
	});

	it("follows a key dropped on the row while Expression is shown", async () => {
		// The Map step's drop, outside the panel, sets the row's mapping.
		function Host() {
			const [mapping, setMapping] = useState<RowMapping>({ type: "text", from: "Name" });
			return (
				<>
					<button type="button" onClick={() => setMapping({ type: "text", from: "Price" })}>
						Drop Price
					</button>
					<DetailPanel
						row={fieldRow("string")}
						mapping={mapping}
						meta={undefined}
						columns={COLUMNS}
						onChange={() => {}}
						onKeep={() => {}}
					/>
				</>
			);
		}
		const { user } = renderAdmin(<Host />);
		await user.click(screen.getByRole("radio", { name: "Expression" }));
		expect(screen.queryByRole("combobox", { name: "Source key" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Drop Price" }));
		expect(screen.getByRole("radio", { name: "Source key" })).toBeChecked();
		expect(screen.getByRole("combobox", { name: "Source key" })).toHaveValue("Price");
	});

	it("offers no source for a field no mapping can write", () => {
		setup(fieldRow("repeater"));
		expect(screen.getByRole("heading", { name: "F" })).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
	});

	it("offers only mapping types compatible with the field type", async () => {
		const datetime = setup(fieldRow("datetime"), { type: "date", from: "Released" });
		await datetime.user.click(screen.getByRole("combobox", { name: "Mapping type" }));
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Date"]);
		datetime.unmount();

		const string = setup(fieldRow("string"), { type: "text", from: "Released" });
		await string.user.click(screen.getByRole("combobox", { name: "Mapping type" }));
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
			"Text",
			"Date",
			"Slug",
		]);
		await string.user.click(screen.getByRole("option", { name: "Date" }));
		expect(last(string.onChange)).toStrictEqual({ type: "date", from: "Released" });
	});

	it("drops the old type's settings when the type changes", async () => {
		const { user, onChange } = setup(fieldRow("string"), {
			type: "date",
			from: "Released",
			format: "dd/MM/yyyy",
		});
		await choose(user, "Mapping type", "Text");
		expect(last(onChange)).toStrictEqual({ type: "text", from: "Released" });
	});

	it("writes date format and tz, and number decimal and thousands", async () => {
		const date = setup(fieldRow("string"), { type: "date", from: "Released" });
		await date.user.type(screen.getByRole("textbox", { name: "Source date format" }), "dd/MM/yyyy");
		await date.user.tab();
		await choose(date.user, "Timezone", "The site's timezone");
		await date.user.type(screen.getByRole("textbox", { name: "Output format" }), "d MMM yyyy");
		await date.user.tab();
		expect(last(date.onChange)).toStrictEqual({
			type: "date",
			from: "Released",
			format: "dd/MM/yyyy",
			tz: "site",
			output: "d MMM yyyy",
		});
		// An emptied input is removed, not written as an empty or undefined value.
		await date.user.clear(screen.getByRole("textbox", { name: "Output format" }));
		await date.user.tab();
		expect(last(date.onChange)).toStrictEqual({
			type: "date",
			from: "Released",
			format: "dd/MM/yyyy",
			tz: "site",
		});
		date.unmount();

		const number = setup(fieldRow("number"), { type: "number", from: "Price" });
		await choose(number.user, "Decimal separator", "Comma (,)");
		await choose(number.user, "Thousands separator", "Point (.)");
		expect(last(number.onChange)).toStrictEqual({
			type: "number",
			from: "Price",
			decimal: ",",
			thousands: ".",
		});
		await choose(number.user, "Thousands separator", "None");
		expect(last(number.onChange)).toStrictEqual({ type: "number", from: "Price", decimal: "," });
	});

	it("writes a text setting when another control is clicked", async () => {
		const { user, onChange } = setup(fieldRow("datetime"), { type: "date", from: "Released" });
		await user.type(screen.getByRole("textbox", { name: "Source date format" }), "dd/MM/yyyy");
		await user.click(screen.getByRole("combobox", { name: "Timezone" }));
		expect(last(onChange)).toStrictEqual({ type: "date", from: "Released", format: "dd/MM/yyyy" });
	});

	it("offers the date output format only for string and text fields (preflight F27)", () => {
		const text = setup(fieldRow("text"), { type: "date", from: "Released" });
		expect(screen.getByRole("textbox", { name: "Output format" })).toBeInTheDocument();
		text.unmount();
		setup(fieldRow("datetime"), { type: "date", from: "Released" });
		expect(screen.getByRole("textbox", { name: "Source date format" })).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Output format" })).toBeNull();
	});

	it("keeps a saved template's other timezone as a choice", async () => {
		const { user } = setup(fieldRow("datetime"), {
			type: "date",
			from: "Released",
			tz: "Europe/Paris",
		});
		await user.click(screen.getByRole("combobox", { name: "Timezone" }));
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
			"UTC",
			"The site's timezone",
			"Europe/Paris",
		]);
	});

	it("refuses thousands equal to decimal with a message", async () => {
		const MESSAGE = "The thousands separator must differ from the decimal separator";
		const { user, onChange } = setup(fieldRow("number"), { type: "number", from: "Price" });
		await choose(user, "Thousands separator", "Point (.)");
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByText(MESSAGE)).toBeVisible();
		await choose(user, "Thousands separator", "Space");
		expect(last(onChange)).toStrictEqual({ type: "number", from: "Price", thousands: " " });
		expect(screen.queryByText(MESSAGE)).toBeNull();
		// The other way round: a decimal equal to the thousands separator.
		await choose(user, "Decimal separator", "Comma (,)");
		await choose(user, "Thousands separator", "Point (.)");
		onChange.mockClear();
		await choose(user, "Decimal separator", "Point (.)");
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByText(MESSAGE)).toBeVisible();
	});

	it("writes boolean token lists", async () => {
		const { user, onChange } = setup(fieldRow("boolean"), { type: "boolean", from: "Status" });
		await user.type(screen.getByRole("textbox", { name: "Values read as yes" }), "live, ja");
		await user.tab();
		await user.type(screen.getByRole("textbox", { name: "Values read as no" }), "draft,,");
		await user.tab();
		expect(last(onChange)).toStrictEqual({
			type: "boolean",
			from: "Status",
			true: ["live", "ja"],
			false: ["draft"],
		});
	});

	it("refuses a token in both lists, counting an unset list as the usual tokens", async () => {
		const { user, onChange } = setup(fieldRow("boolean"), { type: "boolean", from: "Status" });
		const yes = screen.getByRole("textbox", { name: "Values read as yes" });
		const no = screen.getByRole("textbox", { name: "Values read as no" });
		// "no" is one of the usual no values.
		await user.type(yes, "ja, no");
		await user.tab();
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByText('"no" is both a yes and a no value')).toBeVisible();
		await user.type(no, "off");
		await user.tab();
		expect(last(onChange)).toStrictEqual({ type: "boolean", from: "Status", false: ["off"] });
		// With its own no values, "no" is free; the match ignores case and spaces.
		await user.clear(yes);
		await user.type(yes, "ja, no");
		await user.tab();
		expect(last(onChange)).toStrictEqual({
			type: "boolean",
			from: "Status",
			true: ["ja", "no"],
			false: ["off"],
		});
		expect(screen.queryByText('"no" is both a yes and a no value')).toBeNull();
		await user.clear(no);
		await user.type(no, " JA ");
		await user.tab();
		expect(screen.getByText('"ja" is both a yes and a no value')).toBeVisible();
		expect(last(onChange)).toStrictEqual({
			type: "boolean",
			from: "Status",
			true: ["ja", "no"],
			false: ["off"],
		});
	});

	it("counts an unset yes list as the usual yes values", async () => {
		const { user, onChange } = setup(fieldRow("boolean"), { type: "boolean", from: "Status" });
		const yes = screen.getByRole("textbox", { name: "Values read as yes" });
		const no = screen.getByRole("textbox", { name: "Values read as no" });
		await user.type(no, "nope, Yes");
		await user.tab();
		expect(screen.getByText('"yes" is both a yes and a no value')).toBeVisible();
		expect(onChange).not.toHaveBeenCalled();
		// Emptying a list brings the usual values back, which may clash with the other list.
		await user.type(yes, "ja");
		await user.tab();
		await user.tab();
		expect(last(onChange)).toStrictEqual({
			type: "boolean",
			from: "Status",
			true: ["ja"],
			false: ["nope", "Yes"],
		});
		onChange.mockClear();
		await user.clear(yes);
		await user.tab();
		expect(screen.getAllByText('"yes" is both a yes and a no value')).toHaveLength(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("refuses more than 50 tokens, or one longer than 100 characters", async () => {
		const CAP = "At most 50 values, each up to 100 characters";
		const { user, onChange } = setup(fieldRow("boolean"), { type: "boolean", from: "Status" });
		const yes = screen.getByRole("textbox", { name: "Values read as yes" });
		const many = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`).join(",");
		await user.click(yes);
		await user.paste(many(51));
		await user.tab();
		expect(screen.getByText(CAP)).toBeVisible();
		await user.clear(yes);
		await user.paste("x".repeat(101));
		await user.tab();
		expect(screen.getByText(CAP)).toBeVisible();
		expect(onChange).not.toHaveBeenCalled();
		await user.clear(yes);
		await user.paste(`${many(49)},${"x".repeat(100)}`);
		await user.tab();
		expect(screen.queryByText(CAP)).toBeNull();
		expect(last(onChange)?.true).toHaveLength(50);
	});

	it("maps select values onto the field's options", async () => {
		const { user, onChange } = setup(fieldRow("select", { options: ["Draft", "Published"] }), {
			type: "select",
			from: "Status",
		});
		const values = screen.getByRole("group", { name: "Source values" });
		expect(within(values).getAllByRole("combobox")).toHaveLength(2);
		await choose(user, "live", "Published");
		expect(last(onChange)).toStrictEqual({
			type: "select",
			from: "Status",
			map: { live: "Published" },
		});
		await user.click(screen.getByRole("checkbox", { name: "Ignore case" }));
		expect(last(onChange)).toStrictEqual({
			type: "select",
			from: "Status",
			map: { live: "Published" },
			ignoreCase: false,
		});
		await choose(user, "live", "As it is");
		expect(last(onChange)).toStrictEqual({ type: "select", from: "Status", ignoreCase: false });
	});

	it("adds a source value the sample lacks, up to 200 characters", async () => {
		const { user, onChange } = setup(fieldRow("select", { options: ["Draft", "Published"] }), {
			type: "select",
			from: "Status",
		});
		const add = screen.getByRole("textbox", { name: "Add a value" });
		// Nothing typed adds nothing.
		await user.click(screen.getByRole("button", { name: "Add" }));
		expect(
			within(screen.getByRole("group", { name: "Source values" })).getAllByRole("combobox"),
		).toHaveLength(2);
		await user.click(add);
		await user.paste("x".repeat(201));
		await user.click(screen.getByRole("button", { name: "Add" }));
		expect(screen.getByText("A source value is at most 200 characters")).toBeVisible();
		const values = screen.getByRole("group", { name: "Source values" });
		expect(within(values).getAllByRole("combobox")).toHaveLength(2);
		await user.clear(add);
		await user.type(add, " archived ");
		await user.click(screen.getByRole("button", { name: "Add" }));
		expect(screen.queryByText("A source value is at most 200 characters")).toBeNull();
		expect(add).toHaveValue("");
		expect(onChange).not.toHaveBeenCalled();
		await choose(user, "archived", "Published");
		expect(last(onChange)).toStrictEqual({
			type: "select",
			from: "Status",
			map: { archived: "Published" },
		});
		// A value already listed is not added twice.
		await user.type(add, "live");
		await user.click(screen.getByRole("button", { name: "Add" }));
		expect(within(values).getAllByRole("combobox")).toHaveLength(3);
	});

	it("splits multi-select values by the separator", async () => {
		const { user, onChange } = setup(fieldRow("multiSelect", { options: ["Red", "Blue"] }), {
			type: "multiSelect",
			from: "Tags",
		});
		// The default separator is a comma: "red, blue" is two values.
		const values = screen.getByRole("group", { name: "Source values" });
		expect(within(values).getAllByRole("combobox")).toHaveLength(2);
		expect(screen.getByRole("combobox", { name: "red" })).toBeInTheDocument();
		await choose(user, "blue", "Blue");
		await user.type(screen.getByRole("textbox", { name: "Separator" }), ";");
		await user.tab();
		expect(last(onChange)).toStrictEqual({
			type: "multiSelect",
			from: "Tags",
			map: { blue: "Blue" },
			separator: ";",
		});
		// With ";", "red, blue" is one value; the saved entry for "blue" stays listed.
		expect(screen.getByRole("combobox", { name: "red, blue" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "blue" })).toBeInTheDocument();
	});

	it("writes portableText format, required", async () => {
		const REQUIRED = "Choose the source's format: Portable Text needs it";
		const { user, onChange } = setup(fieldRow("portableText"), {
			type: "portableText",
			from: "Body",
		});
		expect(screen.getByText(REQUIRED)).toBeVisible();
		await choose(user, "Source format", "Markdown");
		expect(last(onChange)).toStrictEqual({
			type: "portableText",
			from: "Body",
			format: "markdown",
		});
		expect(screen.queryByText(REQUIRED)).toBeNull();
		await choose(user, "Images", "Skip them");
		const baseUrl = screen.getByRole("textbox", { name: "Base URL for relative links" });
		await user.type(baseUrl, "ftp://x");
		await user.tab();
		expect(screen.getByText("Enter an absolute http or https address")).toBeVisible();
		await user.clear(baseUrl);
		await user.type(baseUrl, "https://me@example.com/");
		await user.tab();
		expect(screen.getByText("Enter an absolute http or https address")).toBeVisible();
		await user.clear(baseUrl);
		await user.type(baseUrl, "https://:secret@example.com/");
		await user.tab();
		expect(screen.getByText("Enter an absolute http or https address")).toBeVisible();
		await user.clear(baseUrl);
		await user.type(baseUrl, "https://example.com/blog/");
		await user.tab();
		expect(last(onChange)).toStrictEqual({
			type: "portableText",
			from: "Body",
			format: "markdown",
			images: "skip",
			baseUrl: "https://example.com/blog/",
		});
	});

	it("writes json, reference, image and file settings", async () => {
		const json = setup(fieldRow("json"), { type: "json", from: "Name" });
		await json.user.click(screen.getByRole("checkbox", { name: "Parse text as JSON" }));
		expect(last(json.onChange)).toStrictEqual({ type: "json", from: "Name", parse: false });
		json.unmount();

		const ref = setup(fieldRow("reference"), { type: "reference", from: "Name" });
		await choose(ref.user, "Match by", "Import key");
		expect(last(ref.onChange)).toStrictEqual({ type: "reference", from: "Name", match: "key" });
		ref.unmount();

		const image = setup(fieldRow("image"), { type: "image", from: "Name" });
		const alt = screen.getByRole("radiogroup", { name: "Alt text" });
		await image.user.click(within(alt).getByRole("radio", { name: "Source key" }));
		await image.user.click(screen.getByRole("combobox", { name: "Alt text key" }));
		await image.user.click(screen.getByRole("option", { name: "Status" }));
		await image.user.click(
			screen.getByRole("checkbox", { name: "Download the file again on every run" }),
		);
		expect(last(image.onChange)).toStrictEqual({
			type: "image",
			from: "Name",
			alt: { from: "Status" },
			refresh: true,
		});
		await image.user.click(within(alt).getByRole("radio", { name: "None" }));
		expect(last(image.onChange)).toStrictEqual({ type: "image", from: "Name", refresh: true });
		image.unmount();

		const file = setup(fieldRow("file"), { type: "file", from: "Name" });
		await file.user.click(
			screen.getByRole("checkbox", { name: "Download the file again on every run" }),
		);
		expect(last(file.onChange)).toStrictEqual({ type: "file", from: "Name", refresh: true });
	});

	it("writes taxonomy and byline options", async () => {
		const taxonomy: TaxonomyInfo = {
			name: "category",
			label: "Categories",
			hierarchical: true,
			collections: ["posts"],
		};
		const tax = setup(
			{ id: "taxonomy:category", label: "Categories", kind: "taxonomy", taxonomy },
			{ from: "Cats" },
		);
		expect(screen.queryByRole("combobox", { name: "Mapping type" })).toBeNull();
		await choose(tax.user, "Match terms by", "Label");
		await tax.user.type(screen.getByRole("textbox", { name: "Path separator" }), ">");
		await tax.user.tab();
		await tax.user.click(screen.getByRole("checkbox", { name: "Create missing terms" }));
		expect(last(tax.onChange)).toStrictEqual({
			from: "Cats",
			match: "label",
			hierarchy: ">",
			create: true,
		});
		tax.unmount();

		setup(
			{
				id: "taxonomy:tag",
				label: "Tags",
				kind: "taxonomy",
				taxonomy: { ...taxonomy, hierarchical: false },
			},
			{ from: "Tags" },
		);
		expect(screen.queryByRole("textbox", { name: "Path separator" })).toBeNull();
		screen.getByRole("textbox", { name: "Term separator" });

		const bylines = setup({ id: "bylines", label: "Bylines", kind: "bylines" }, { from: "Name" });
		await choose(bylines.user, "Match bylines by", "Name");
		expect(last(bylines.onChange)).toStrictEqual({ from: "Name", match: "name" });
	});

	it("refuses a term separator equal to the path separator, flat taxonomies too", async () => {
		const flat: TaxonomyInfo = {
			name: "tag",
			label: "Tags",
			hierarchical: false,
			collections: ["posts"],
		};
		const tag = setup(
			{ id: "taxonomy:tag", label: "Tags", kind: "taxonomy", taxonomy: flat },
			{
				from: "Tags",
			},
		);
		const term = screen.getByRole("textbox", { name: "Term separator" });
		await tag.user.type(term, "/");
		await tag.user.tab();
		expect(screen.getByText("The term separator cannot be /, the path character")).toBeVisible();
		expect(tag.onChange).not.toHaveBeenCalled();
		await tag.user.clear(term);
		await tag.user.type(term, "|");
		await tag.user.tab();
		expect(last(tag.onChange)).toStrictEqual({ from: "Tags", separator: "|" });
		expect(screen.queryByText("The term separator cannot be /, the path character")).toBeNull();
		tag.unmount();

		const tree: TaxonomyInfo = { ...flat, name: "category", hierarchical: true };
		const cat = setup(
			{ id: "taxonomy:category", label: "Categories", kind: "taxonomy", taxonomy: tree },
			{ from: "Cats" },
		);
		const path = screen.getByRole("textbox", { name: "Path separator" });
		// The term separator is a comma when unset.
		await cat.user.type(path, ",");
		await cat.user.tab();
		expect(
			screen.getByText("The path separator must differ from the term separator"),
		).toBeVisible();
		expect(cat.onChange).not.toHaveBeenCalled();
		await cat.user.clear(path);
		await cat.user.type(path, ">");
		await cat.user.tab();
		expect(last(cat.onChange)).toStrictEqual({ from: "Cats", hierarchy: ">" });
		await cat.user.type(screen.getByRole("textbox", { name: "Term separator" }), ">");
		await cat.user.tab();
		expect(
			screen.getByText("The term separator must differ from the path separator"),
		).toBeVisible();
		expect(last(cat.onChange)).toStrictEqual({ from: "Cats", hierarchy: ">" });
		// An emptied setting counts as its default: "/" for the path, "," for terms.
		const catTerm = screen.getByRole("textbox", { name: "Term separator" });
		await cat.user.clear(catTerm);
		await cat.user.type(catTerm, "/");
		await cat.user.tab();
		expect(last(cat.onChange)).toStrictEqual({ from: "Cats", hierarchy: ">", separator: "/" });
		await cat.user.clear(path);
		await cat.user.tab();
		expect(
			screen.getByText("The path separator must differ from the term separator"),
		).toBeVisible();
		await cat.user.type(path, ",");
		await cat.user.tab();
		expect(last(cat.onChange)).toStrictEqual({ from: "Cats", hierarchy: ",", separator: "/" });
		cat.onChange.mockClear();
		await cat.user.clear(catTerm);
		await cat.user.tab();
		expect(
			screen.getByText("The term separator must differ from the path separator"),
		).toBeVisible();
		expect(cat.onChange).not.toHaveBeenCalled();
	});

	it("shows raw sample values and says conversions show in Preview", () => {
		setup(fieldRow("string"), { type: "text", from: "Name" });
		const samples = screen.getByRole("list", { name: "Sample values" });
		expect(
			within(samples)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["Mug", "Cup", "Bowl", "Plate", "Jug"]);
		expect(screen.getByText("Converted values show in Preview")).toBeVisible();
	});

	it("shows the rationale with 'AI · high' as text", () => {
		const ai = setup(
			fieldRow("string"),
			{ type: "text", from: "Name" },
			{ meta: { origin: "ai", confidence: 0.8, rationale: "Name holds the title", check: false } },
		);
		expect(screen.getByText("AI · high")).toBeVisible();
		expect(screen.getByText("Name holds the title")).toBeVisible();
		expect(screen.queryByText("check")).toBeNull();
		ai.unmount();

		const name = setup(
			fieldRow("string"),
			{ type: "text", from: "Name" },
			{ meta: { origin: "name", confidence: 0.3, rationale: "Close name", check: true } },
		);
		expect(screen.getByText("Name · low")).toBeVisible();
		expect(screen.getByText("check")).toBeVisible();
		name.unmount();

		const medium = setup(
			fieldRow("string"),
			{ type: "text", from: "Name" },
			{ meta: { origin: "ai", confidence: 0.5, check: false } },
		);
		expect(screen.getByText("AI · medium")).toBeVisible();
		medium.unmount();

		const template = setup(
			fieldRow("string"),
			{ type: "text", from: "Name" },
			{ meta: { origin: "template", check: false } },
		);
		expect(screen.getByText("Template")).toBeVisible();
		template.unmount();

		setup(
			fieldRow("string"),
			{ type: "text", from: "Name" },
			{ meta: { origin: "user", check: false } },
		);
		expect(screen.queryByText(/ · /)).toBeNull();
	});
});

describe("the review banner (StepMap.dc.html)", () => {
	const columns: SampleColumn[] = [
		{ key: "Price", values: ["0.5", "", "1.5", undefined, "2.5", "3.5"] },
		{ key: "Name", values: ["Mug"] },
	];

	it("says the AI was unsure, quotes the key's first values, and keeps the row on Keep it", async () => {
		const { user, onKeep, onChange } = setup(
			fieldRow("text"),
			{ type: "text", from: "Price" },
			{ meta: { origin: "ai", confidence: 0.3, check: true }, columns },
		);
		const banner = screen.getByText(
			"AI suggested Price with low confidence. Values look like 0.5, 1.5, 2.5.",
		);
		expect(banner).toBeVisible();
		const keep = screen.getByRole("button", { name: "Keep it" });
		expect(keep).toHaveAccessibleDescription(banner.textContent ?? "");
		await user.click(keep);
		expect(onKeep).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("clears the row on Remove the key", async () => {
		const { user, onKeep, onChange } = setup(
			fieldRow("text"),
			{ type: "text", from: "Price" },
			{ meta: { origin: "name", confidence: 0.2, check: true }, columns },
		);
		expect(
			screen.getByText(
				"Name matching suggested Price with low confidence. Values look like 0.5, 1.5, 2.5.",
			),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Remove the key" }));
		expect(onChange).toHaveBeenCalledWith(null);
		expect(onKeep).not.toHaveBeenCalled();
	});

	it("names the cause: an unclear format, or a key the sample lacks", () => {
		const format = setup(
			fieldRow("datetime"),
			{ type: "date", from: "Price" },
			{ meta: { origin: "ai", confidence: 0.9, check: true }, columns },
		);
		expect(
			screen.getByText(
				"AI suggested Price, but the format of its values is unclear. Values look like 0.5, 1.5, 2.5.",
			),
		).toBeVisible();
		format.unmount();

		setup(
			fieldRow("text"),
			{ type: "text", from: "Cost" },
			{ meta: { origin: "user", check: true }, columns },
		);
		expect(screen.getByText("The sample has no key Cost.")).toBeVisible();
		expect(screen.getByRole("button", { name: "Keep it" })).toBeVisible();
	});

	it("is not shown for a row without a check, or one that reads an expression", () => {
		const plain = setup(
			fieldRow("text"),
			{ type: "text", from: "Price" },
			{ meta: { origin: "ai", confidence: 0.9, check: false }, columns },
		);
		expect(screen.queryByRole("button", { name: "Keep it" })).toBeNull();
		plain.unmount();

		setup(
			fieldRow("text"),
			{ type: "text", expr: "Price & 'x'" },
			{ meta: { origin: "ai", confidence: 0.3, check: true }, columns },
		);
		expect(screen.queryByRole("button", { name: "Keep it" })).toBeNull();
	});
});

describe("badgeText", () => {
	it("gives the Map rows' badge text, and none for the user's rows", () => {
		const metas: RowMeta[] = [
			{ origin: "ai", confidence: 0.95, check: false },
			{ origin: "name", confidence: 0.6, check: false },
			{ origin: "ai", confidence: 0.49, check: true },
			{ origin: "ai", check: false },
			{ origin: "template", check: false },
			{ origin: "template", confidence: 0.9, check: false },
			{ origin: "user", check: false },
		];
		function Badges() {
			const t = useT();
			return <output>{metas.map((m) => badgeText(t, m) ?? "none").join(" | ")}</output>;
		}
		renderAdmin(<Badges />);
		expect(screen.getByRole("status")).toHaveTextContent(
			"AI · high | Name · medium | AI · low | AI | Template | Template | none",
		);
	});
});

describe("KeyPicker", () => {
	it("shows the chosen key and calls onPick with the picked one", async () => {
		const onPick = vi.fn();
		const { user } = renderAdmin(
			<KeyPicker columns={COLUMNS} value="Price" onPick={onPick} label="Key to use" />,
		);
		const input = screen.getByRole("combobox", { name: "Key to use" });
		expect(input).toHaveValue("Price");
		await user.click(input);
		await user.click(screen.getByRole("option", { name: "Status" }));
		expect(onPick).toHaveBeenCalledWith("Status");
	});
});
