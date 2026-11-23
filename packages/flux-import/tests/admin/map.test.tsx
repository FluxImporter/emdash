import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { act, type Dispatch, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { SampleColumn } from "../../src/admin/types.js";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import { MapStep } from "../../src/admin/wizard/map/MapStep.js";
import {
	initialState,
	type RowMeta,
	type WizardAction,
	type WizardState,
} from "../../src/admin/wizard/state.js";
import type { SuggestReply } from "../../src/plugin/suggest.js";
import { MANIFEST, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteHandler, renderAdmin, withRects } from "./harness.js";

/** Task 14's own fixtures (preflight F21: never in `fixtures.ts`). */

const COLUMNS: SampleColumn[] = [
	{ key: "SKU", values: ["SKU-001", "SKU-002"] },
	{ key: "Name", values: ["Blue mug", "Red cup"] },
	{ key: "Price", values: ["12,50", "8,00"] },
	{ key: "Released", values: ["07/03/2024", "31/12/2023"] },
	{ key: "Body", values: ["<p>Hi</p>", "<p>Bye</p>"] },
];

/** A schema API field row (`GET /_emdash/api/schema/collections/posts?includeFields=true`). */
const fieldRow = (
	slug: string,
	label: string,
	type: string,
	sortOrder: number,
	extra: Record<string, unknown> = {},
) => ({ slug, label, type, required: false, sortOrder, translatable: true, ...extra });

const FIELD_ROWS = [
	fieldRow("title", "Title", "string", 0, { required: true }),
	fieldRow("price", "Price", "number", 1),
	fieldRow("released", "Released", "datetime", 2),
	fieldRow("body", "Body", "portableText", 3),
];

const collection = (fields: unknown[]) => ({ item: { slug: "posts", label: "Posts", fields } });

type Suggestion = SuggestReply["key"];
type FieldSuggestion = SuggestReply["fields"][number];

const suggestion = (
	from: string | null,
	confidence: number,
	origin: Suggestion["origin"],
): Suggestion => ({ from, confidence, origin, rationale: `${origin} picked ${from}` });

const fieldSuggestion = (
	field: string,
	fieldType: string,
	mapping: FieldSuggestion["mapping"],
	s: Suggestion,
): FieldSuggestion => ({
	...s,
	field,
	fieldType,
	required: field === "title",
	...(mapping === undefined ? {} : { mapping }),
});

/** `templates/suggest`'s reply: the AI filled the title, name matching the rest. */
function reply(over: Partial<SuggestReply> = {}): SuggestReply {
	return {
		method: "ai",
		ai: { available: true, provider: "anthropic", model: "claude-test" },
		template: null,
		key: suggestion("SKU", 0.9, "fallback"),
		slug: suggestion("Name", 0.6, "fallback"),
		fields: [
			fieldSuggestion("title", "string", "text", suggestion("Name", 0.92, "ai")),
			fieldSuggestion("price", "number", "number", suggestion("Price", 0.6, "fallback")),
			fieldSuggestion("released", "datetime", "date", suggestion("Released", 0.3, "fallback")),
			fieldSuggestion("body", "portableText", undefined, suggestion(null, 0, "fallback")),
		],
		unmapped: { fields: ["body"], keys: ["Body"] },
		check: { problems: [], warnings: [] },
		warnings: [],
		sent: null,
		...over,
	};
}

const USER: RowMeta = { origin: "user", check: false };

/** Map's entry state: a CSV upload targeted at posts/en, nothing mapped yet. */
const DRAFT: Partial<WizardState> = {
	step: "map",
	source: { kind: "upload", uploadId: UPLOAD_ID, label: "products.csv" },
	sourceBlock: { format: "csv" },
	columns: COLUMNS,
	target: { collection: "posts", locale: "en", translationLocale: null },
	dirty: true,
};

/** The key and the title mapped by hand: no suggestion is asked for on entry. */
const MAPPED: Partial<WizardState> = {
	...DRAFT,
	rows: { key: { from: "SKU" }, "field:title": { from: "Name", type: "text" } },
	meta: { key: USER, "field:title": USER },
};

/** What the test reads of the wizard, and how it acts on it outside the step. */
const probe: { state: WizardState; dispatch: Dispatch<WizardAction> } = {
	state: initialState,
	dispatch: () => undefined,
};

function Shell() {
	const { state, dispatch } = useWizard();
	probe.state = state;
	probe.dispatch = dispatch;
	return state.step === "map" ? <MapStep /> : <p>{`step: ${state.step}`}</p>;
}

function routes(over: Record<string, RouteHandler> = {}) {
	return mockRoutes({
		"GET manifest": () => MANIFEST,
		"GET collection:posts": () => collection(FIELD_ROWS),
		"templates/suggest": () => reply(),
		...over,
	});
}

function renderMap(initial: Partial<WizardState> = MAPPED, opts: { strict?: boolean } = {}) {
	const ui = (
		<WizardProvider initial={initial}>
			<Shell />
		</WizardProvider>
	);
	return renderAdmin(opts.strict === true ? <StrictMode>{ui}</StrictMode> : ui);
}

/** A promise and the function that settles it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** `schema/apply`'s reply: `changes` planned, or applied unless a dry run. */
function applyReply(body: unknown, changes: { field: string; action: string; type: string }[]) {
	const { dryRun } = body as { dryRun: boolean };
	const applied = dryRun ? [] : changes.filter((c) => c.action === "create").map((c) => c.field);
	return { collection: "posts", dryRun, changes, applied, error: null };
}

/** A row of the fields pane, by its row ID. */
const row = (id: string) => screen.getByTestId(id);
/** A row's select button, by its row ID and label. */
const select = (id: string, label: string) =>
	within(row(id)).getByRole("button", { name: new RegExp(`^${label}`) });
const keysPane = () => screen.getByRole("region", { name: /^Source keys/ });
const details = () => screen.getByRole("complementary", { name: "Details" });
const next = () => screen.getByRole("button", { name: "Next" });

/** Waits until the fields pane lists the collection's fields. */
const fieldsLoaded = () => screen.findByTestId("field:title");

/** Drags `key` down by `presses` × 25 px with @dnd-kit's keyboard sensor (Fact V9). */
async function dragDown(user: UserEvent, key: string, presses: number) {
	within(keysPane())
		.getByRole("button", { name: new RegExp(`^${key}`) })
		.focus();
	await user.keyboard(` ${"{ArrowDown}".repeat(presses)} `);
}

describe("MapStep", () => {
	it("asks for suggestions on entry with collection, locale, uploadId and source, and no ai flag", async () => {
		const { calls } = routes();
		renderMap(DRAFT);
		await waitFor(() => expect(probe.state.suggestion.status).toBe("done"));
		const asked = calls.filter((c) => c.route === "templates/suggest");
		expect(asked.map((c) => c.body)).toEqual([
			{ collection: "posts", locale: "en", uploadId: UPLOAD_ID, source: { format: "csv" } },
		]);
		expect(probe.state.rows.key).toEqual({ from: "SKU" });
	});

	it("asks once on entry under StrictMode's double effects", async () => {
		const { calls } = routes();
		renderMap(DRAFT, { strict: true });
		await waitFor(() => expect(probe.state.suggestion.status).toBe("done"));
		expect(calls.filter((c) => c.route === "templates/suggest")).toHaveLength(1);
	});

	it("drops a late answer once the collection has changed, and asks for the new one", async () => {
		const first = deferred<SuggestReply>();
		const answers = [first.promise, Promise.resolve(reply({ fields: [] }))];
		const { calls } = routes({
			"templates/suggest": () => answers.shift(),
			"GET collection:pages": () => collection([fieldRow("title", "Title", "string", 0)]),
		});
		renderMap(DRAFT);
		await waitFor(() => expect(probe.state.suggestion.status).toBe("loading"));
		act(() => {
			probe.dispatch({
				type: "targetChosen",
				collection: "pages",
				locale: "en",
				translationLocale: null,
			});
		});
		await waitFor(() =>
			expect(calls.filter((c) => c.route === "templates/suggest")).toHaveLength(2),
		);
		await waitFor(() => expect(probe.state.suggestion.status).toBe("done"));
		await act(async () => {
			first.resolve(reply());
			await first.promise;
		});
		// The posts answer fills nothing on pages.
		expect(probe.state.rows["field:price"]).toBeUndefined();
		expect(probe.state.suggestion.reply?.fields).toEqual([]);
		expect(
			calls
				.filter((c) => c.route === "templates/suggest")
				.map((c) => (c.body as { collection: string }).collection),
		).toEqual(["posts", "pages"]);
	});

	it("does not ask on entry when rows are already mapped", async () => {
		const { calls } = routes();
		renderMap(MAPPED);
		await fieldsLoaded();
		expect(calls.filter((c) => c.route === "templates/suggest")).toEqual([]);
		expect(probe.state.suggestion.status).toBe("idle");
	});

	it("fills rows with badges: 'AI · high', 'Name · medium', 'check'", async () => {
		routes();
		renderMap(DRAFT);
		await within(await fieldsLoaded()).findByText("AI · high");
		expect(within(row("field:title")).getByText("Name")).toBeVisible();
		expect(within(row("key")).getByText("SKU")).toBeVisible();
		expect(within(row("key")).getByText("Name · high")).toBeVisible();
		expect(within(row("slug")).getByText("Name · medium")).toBeVisible();
		expect(within(row("field:price")).getByText("Name · medium")).toBeVisible();
		expect(within(row("field:released")).getByText("Name · low")).toBeVisible();
		expect(within(row("field:released")).getByText("check")).toBeVisible();
		expect(within(row("field:title")).queryByText("check")).toBeNull();
		// The body was left for the user.
		expect(within(row("field:body")).getByText("Drop a key")).toBeVisible();
	});

	it("shows the method and counts in the status line, and warnings as sentences", async () => {
		const replies = [
			reply({
				warnings: [
					{ code: "keys_not_matched", count: 12 },
					{ code: "date_format_ambiguous", fields: ["released"] },
				],
			}),
			reply({ method: "fallback", ai: { available: false, provider: "anthropic" } }),
			reply({ method: "fallback", ai: { available: false } }),
		];
		const { calls } = routes({ "templates/suggest": () => replies.shift() });
		const { user } = renderMap(DRAFT);
		// Key, slug, title and price are filled; the released date is to check.
		expect(await screen.findByText("AI (Anthropic) · 4 filled, 1 to check")).toBeVisible();
		expect(screen.getByText("About these suggestions")).toBeVisible();
		expect(
			screen.getByText("12 source keys past the first 1,000 were not considered."),
		).toBeVisible();
		expect(
			screen.getByText("The date format is unclear for these fields; check it: released."),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("About these suggestions")).toBeNull();
		expect(probe.state.suggestion.dismissed).toBe(true);

		// Every row is the suggestion's, so Ask again asks at once.
		await user.click(screen.getByRole("button", { name: "Ask again" }));
		expect(await screen.findByText("Name matching · AI unavailable")).toBeVisible();
		// A provider of "none" is not unavailable: nothing was expected.
		await user.click(screen.getByRole("button", { name: "Ask again" }));
		await waitFor(() =>
			expect(calls.filter((c) => c.route === "templates/suggest")).toHaveLength(3),
		);
		expect(await screen.findByText("Name matching")).toBeVisible();
		expect(screen.queryByText(/AI unavailable/)).toBeNull();
	});

	it("shows a failed suggestion as its sentence, and the rows stay mappable", async () => {
		routes({
			"templates/suggest": () =>
				fail("NO_SOURCE_KEYS", "The sample has no column or path to map", 400),
		});
		renderMap(DRAFT);
		expect(
			await screen.findByText(
				"No columns or fields were found in the data. Check the records path.",
			),
		).toBeVisible();
		expect(screen.queryByText("The sample has no column or path to map")).toBeNull();
		await fieldsLoaded();
		expect(select("field:title", "Title")).toBeEnabled();
	});

	it("maps by dragging a key onto a field with the keyboard sensor", async () => {
		routes();
		const { user } = renderMap({ ...DRAFT, rows: { key: { from: "SKU" } }, meta: { key: USER } });
		await fieldsLoaded();
		const restore = withRects({
			// @dnd-kit measures the `DragOverlay` by its content.
			"drag-overlay": new DOMRect(0, 0, 100, 20),
			"key:Name": new DOMRect(0, 0, 100, 20),
			"field:title": new DOMRect(0, 50, 100, 20),
		});
		try {
			within(keysPane()).getByRole("button", { name: /^Name/ }).focus();
			await user.keyboard(" ");
			// The key moves in an overlay above the panes; its row stays in the scrolling list.
			expect(screen.getByTestId("drag-overlay")).toHaveTextContent("Name");
			// The instructions lead with the picker, the path that needs no drag.
			const key = within(keysPane()).getByRole("button", { name: /^Name/ });
			expect(key).toHaveAccessibleDescription(
				/^To map a key, select a field, then choose its key in the details panel\./,
			);
			expect(within(keysPane()).getByRole("list")).toHaveClass("max-h-96", "overflow-y-auto");
			await user.keyboard("{ArrowDown}{ArrowDown} ");
			expect(screen.queryByTestId("drag-overlay")).toBeNull();
			expect(within(row("field:title")).getByText("Name")).toBeVisible();
			expect(probe.state.rows["field:title"]).toEqual({ type: "text", from: "Name" });
			expect(probe.state.meta["field:title"]).toEqual(USER);
			// Screen readers hear each step.
			expect(await screen.findByText("The key Name was dropped on Title.")).toBeInTheDocument();
		} finally {
			restore();
		}
	});

	it("maps by picking a key in the detail panel without dragging", async () => {
		routes();
		const { user } = renderMap({ ...DRAFT, rows: { key: { from: "SKU" } }, meta: { key: USER } });
		await fieldsLoaded();
		expect(
			within(details()).getByText("Select a field to choose its key and settings."),
		).toBeVisible();
		await user.click(select("field:price", "Price"));
		expect(select("field:price", "Price")).toHaveAttribute("aria-pressed", "true");
		await user.click(within(details()).getByRole("combobox", { name: "Source key" }));
		await user.click(await screen.findByRole("option", { name: "Price" }));
		expect(probe.state.rows["field:price"]).toEqual({ type: "number", from: "Price" });

		// The chip's remove button clears the row.
		await user.click(screen.getByRole("button", { name: "Remove Price from Price" }));
		expect(probe.state.rows["field:price"]).toBeUndefined();
		expect(within(row("field:price")).getByText("Drop a key")).toBeVisible();
	});

	it("dims used keys but still lets one key feed a second field", async () => {
		routes();
		const { user } = renderMap(MAPPED);
		await fieldsLoaded();
		const name = within(keysPane()).getByRole("button", { name: /^Name/ });
		const price = within(keysPane()).getByRole("button", { name: /^Price/ });
		expect(name).toHaveClass("opacity-50");
		expect(price).not.toHaveClass("opacity-50");
		const restore = withRects({
			// @dnd-kit measures the `DragOverlay` by its content.
			"drag-overlay": new DOMRect(0, 0, 100, 20),
			"key:Name": new DOMRect(0, 0, 100, 20),
			"field:released": new DOMRect(0, 75, 100, 20),
		});
		try {
			await dragDown(user, "Name", 3);
		} finally {
			restore();
		}
		expect(probe.state.rows["field:released"]).toEqual({ type: "date", from: "Name" });
		expect(probe.state.rows["field:title"]).toEqual({ from: "Name", type: "text" });
		expect(within(row("field:released")).getByText("Name")).toBeVisible();
		expect(within(row("field:title")).getByText("Name")).toBeVisible();
	});

	it("never overwrites a hand-set row on Ask again unless confirmed", async () => {
		const { calls } = routes();
		const { user } = renderMap({
			...MAPPED,
			rows: { key: { from: "SKU" }, "field:title": { from: "Body", type: "text" } },
		});
		await fieldsLoaded();
		const suggests = () => calls.filter((c) => c.route === "templates/suggest");

		// Cancel asks nothing.
		await user.click(screen.getByRole("button", { name: "Ask again" }));
		const dialog = await screen.findByRole("dialog", {
			name: "Replace the fields you mapped yourself?",
		});
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(suggests()).toHaveLength(0);

		// Keep: the suggestion fills the other rows only.
		await user.click(screen.getByRole("button", { name: "Ask again" }));
		await user.click(await screen.findByRole("button", { name: "Keep my choices" }));
		await waitFor(() => expect(probe.state.suggestion.status).toBe("done"));
		expect(suggests()).toHaveLength(1);
		expect(probe.state.rows["field:title"]).toEqual({ from: "Body", type: "text" });
		expect(probe.state.rows.key).toEqual({ from: "SKU" });
		expect(probe.state.meta.key).toEqual(USER);
		expect(probe.state.rows["field:price"]).toEqual({ from: "Price", type: "number" });
		expect(within(row("field:title")).getByText("Body")).toBeVisible();

		// Replace: the user's rows take the suggestion too.
		await user.click(screen.getByRole("button", { name: "Ask again" }));
		await user.click(await screen.findByRole("button", { name: "Replace them" }));
		await waitFor(() =>
			expect(probe.state.rows["field:title"]).toEqual({ from: "Name", type: "text" }),
		);
		expect(suggests()).toHaveLength(2);
		expect(within(row("field:title")).getByText("AI · high")).toBeVisible();
	});

	it("caps the Keys pane at 200 rows with a filter, and finds the 1,000th key (Review Focus 4)", async () => {
		const long = `long-${"x".repeat(295)}`;
		const columns: SampleColumn[] = [
			...Array.from({ length: 999 }, (_, i) => ({ key: `key-${i + 1}`, values: [i] })),
			{ key: long, values: ["far"] },
		];
		routes();
		const { user } = renderMap({ ...MAPPED, columns, rows: { key: { from: "key-1" } } });
		await fieldsLoaded();
		expect(within(keysPane()).getAllByRole("button")).toHaveLength(200);
		expect(within(keysPane()).getByText("Showing 200 of 1,000 keys")).toBeVisible();

		const filter = within(keysPane()).getByRole("textbox", { name: "Filter keys" });
		await user.type(filter, "KEY-999");
		expect(
			within(keysPane())
				.getAllByRole("button")
				.map((b) => b.title),
		).toEqual(["key-999"]);
		expect(within(keysPane()).queryByText(/^Showing/)).toBeNull();

		await user.clear(filter);
		await user.type(filter, "long-");
		const [found] = within(keysPane()).getAllByRole("button");
		expect(found).toHaveAttribute("title", long);
		expect(found?.getAttribute("aria-label") ?? found?.textContent).toContain(long);
		expect(found).toHaveAccessibleName(expect.stringContaining(long));
		const name = within(found!).getByText(long);
		expect(name).toHaveClass("truncate");
		expect(name).toHaveAttribute("title", long);

		await user.clear(filter);
		await user.type(filter, "nothing like it");
		expect(within(keysPane()).getByText("No key matches the filter")).toBeVisible();
	}, 20_000);

	it("disables an unmappable field and blocks Next when it is required (Review Focus 5)", async () => {
		routes({
			"GET collection:posts": () =>
				collection([
					...FIELD_ROWS,
					fieldRow("blocks", "Blocks", "repeater", 4, { required: true }),
				]),
		});
		const { user } = renderMap(MAPPED);
		const blocks = await screen.findByTestId("field:blocks");
		expect(within(blocks).getByRole("button", { name: /^Blocks/ })).toBeDisabled();
		expect(within(blocks).getByText("A repeater field cannot be imported")).toBeVisible();
		const sentence = "Every record would fail: Blocks is required and cannot be imported";
		expect(within(blocks).getByText(sentence)).toBeVisible();
		expect(next()).toBeDisabled();
		expect(next()).toHaveAccessibleDescription(sentence);

		// It is no drop target: a drop on it does nothing.
		const restore = withRects({
			// @dnd-kit measures the `DragOverlay` by its content.
			"drag-overlay": new DOMRect(0, 0, 100, 20),
			"key:Price": new DOMRect(0, 0, 100, 20),
			"field:blocks": new DOMRect(0, 50, 100, 20),
		});
		try {
			await dragDown(user, "Price", 2);
		} finally {
			restore();
		}
		expect(probe.state.rows["field:blocks"]).toBeUndefined();
		expect(within(blocks).queryByText("Price")).toBeNull();
	});

	it("blocks Next while the key is unmapped", async () => {
		routes();
		const { user } = renderMap({
			...DRAFT,
			rows: { "field:title": { from: "Name", type: "text" } },
			meta: { "field:title": USER },
		});
		await fieldsLoaded();
		const sentence = "Choose the source key that identifies each record";
		expect(next()).toBeDisabled();
		expect(next()).toHaveAccessibleDescription(sentence);
		expect(within(row("key")).getByText(sentence)).toBeVisible();

		await user.click(select("key", "Key"));
		await user.click(within(details()).getByRole("combobox", { name: "Source key" }));
		await user.click(await screen.findByRole("option", { name: "SKU" }));
		expect(probe.state.rows.key).toEqual({ from: "SKU" });
		expect(next()).toBeEnabled();
		await user.click(next());
		expect(probe.state.step).toBe("options");
	});

	it("blocks Next while a Portable Text field has no source format", async () => {
		routes();
		const { user } = renderMap(MAPPED);
		await fieldsLoaded();
		const restore = withRects({
			// @dnd-kit measures the `DragOverlay` by its content.
			"drag-overlay": new DOMRect(0, 0, 100, 20),
			"key:Body": new DOMRect(0, 0, 100, 20),
			"field:body": new DOMRect(0, 50, 100, 20),
		});
		try {
			await dragDown(user, "Body", 2);
		} finally {
			restore();
		}
		expect(probe.state.rows["field:body"]).toEqual({ type: "portableText", from: "Body" });
		const sentence = "Body is Portable Text: choose the format of its source";
		expect(next()).toBeDisabled();
		expect(next()).toHaveAccessibleDescription(sentence);
		expect(within(row("field:body")).getByText(sentence)).toBeVisible();
	});

	it("opens the schema diff before leaving when fields are proposed, then refetches fields", async () => {
		let fields = FIELD_ROWS;
		const order: string[] = [];
		const { calls } = routes({
			"GET collection:posts": () => {
				order.push(`fields:${fields.length}`);
				return collection(fields);
			},
			"schema/apply": (body) => {
				const { dryRun } = body as { dryRun: boolean };
				order.push(`apply:${dryRun}`);
				if (!dryRun) fields = [...FIELD_ROWS, fieldRow("weight_g", "Weight (g)", "integer", 4)];
				const changes = [{ field: "weight_g", action: "create", type: "integer" }];
				return {
					collection: "posts",
					dryRun,
					changes,
					applied: dryRun ? [] : ["weight_g"],
					error: null,
				};
			},
		});
		const { user } = renderMap({
			...MAPPED,
			columns: [...COLUMNS, { key: "Weight (g)", values: ["340", "120"] }],
		});
		await fieldsLoaded();
		const restore = withRects({
			// @dnd-kit measures the `DragOverlay` by its content.
			"drag-overlay": new DOMRect(0, 0, 100, 20),
			"key:Weight (g)": new DOMRect(0, 0, 100, 20),
			"new-field": new DOMRect(0, 50, 100, 20),
		});
		try {
			await dragDown(user, "Weight \\(g\\)", 2);
		} finally {
			restore();
		}
		expect(probe.state.newFields).toEqual([
			{
				key: "Weight (g)",
				slug: "weight_g",
				label: "Weight (g)",
				type: "integer",
				translatable: true,
				searchable: false,
			},
		]);
		expect(screen.getByText("From Weight (g) · slug weight_g")).toBeVisible();
		// A proposal blocks nothing: Next opens the schema diff instead of leaving.
		expect(next()).toBeEnabled();
		await user.click(next());
		const dialog = await screen.findByRole("dialog", {
			name: "Add these fields to the collection?",
		});
		await within(dialog).findByText("Weight (g) (weight_g): a new integer field");
		expect(probe.state.step).toBe("map");
		await user.click(within(dialog).getByRole("button", { name: "Add the fields" }));

		await waitFor(() => expect(probe.state.step).toBe("options"));
		// The fields were read again, with the new one, before Map was left.
		expect(order).toEqual(["fields:4", "apply:true", "apply:false", "fields:5"]);
		expect(calls.filter((c) => c.route === "GET collection:posts")).toHaveLength(2);
		expect(probe.state.newFields).toEqual([]);
		expect(probe.state.rows["field:weight_g"]).toEqual({ type: "number", from: "Weight (g)" });
	});

	it("keeps the schema diff open when a late conflict leaves a proposal", async () => {
		routes({
			"schema/apply": (body) =>
				applyReply(
					body,
					(body as { dryRun: boolean }).dryRun
						? [
								{ field: "weight_g", action: "create", type: "integer" },
								{ field: "colour", action: "create", type: "string" },
							]
						: [
								{ field: "weight_g", action: "create", type: "integer" },
								{ field: "colour", action: "conflict", type: "string" },
							],
				),
		});
		const { user } = renderMap({
			...MAPPED,
			columns: [
				...COLUMNS,
				{ key: "Weight (g)", values: ["340"] },
				{ key: "Colour", values: ["blue"] },
			],
		});
		await fieldsLoaded();
		await user.click(screen.getByRole("button", { name: "+ Add a new field" }));
		const picker = within(details()).getByRole("combobox", { name: "Key for the new field" });
		for (const key of ["Weight (g)", "Colour"]) {
			await user.click(picker);
			await user.click(await screen.findByRole("option", { name: key }));
		}
		await user.click(next());
		const dialog = await screen.findByRole("dialog", {
			name: "Add these fields to the collection?",
		});
		await within(dialog).findByText("Colour (colour): a new string field");
		await user.click(within(dialog).getByRole("button", { name: "Add the fields" }));
		await waitFor(() => expect(probe.state.newFields.map((f) => f.slug)).toEqual(["colour"]));
		expect(probe.state.rows["field:weight_g"]).toEqual({ type: "number", from: "Weight (g)" });
		expect(probe.state.step).toBe("map");
		expect(
			screen.getByRole("dialog", { name: "Add these fields to the collection?" }),
		).toBeVisible();
	});

	it("stays on Map after applying when a new field still needs a setting", async () => {
		routes({
			"schema/apply": (body) =>
				applyReply(body, [{ field: "summary", action: "create", type: "portableText" }]),
		});
		const { user } = renderMap({
			...MAPPED,
			columns: [...COLUMNS, { key: "Summary", values: ["<p>Short</p>"] }],
		});
		await fieldsLoaded();
		await user.click(screen.getByRole("button", { name: "+ Add a new field" }));
		await user.click(within(details()).getByRole("combobox", { name: "Key for the new field" }));
		await user.click(await screen.findByRole("option", { name: "Summary" }));
		act(() => {
			probe.dispatch({ type: "fieldChanged", slug: "summary", patch: { type: "portableText" } });
		});
		await user.click(next());
		const dialog = await screen.findByRole("dialog", {
			name: "Add these fields to the collection?",
		});
		await within(dialog).findByText("Summary (summary): a new portableText field");
		await user.click(within(dialog).getByRole("button", { name: "Add the fields" }));
		await waitFor(() => expect(probe.state.newFields).toEqual([]));
		expect(probe.state.rows["field:summary"]).toEqual({ type: "portableText", from: "Summary" });
		expect(probe.state.step).toBe("map");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(next()).toBeDisabled();
	});

	it("says why a reference or an unreadable field cannot be mapped", async () => {
		routes({
			"GET collection:posts": () =>
				collection([
					...FIELD_ROWS,
					fieldRow("author", "Author", "reference", 4, {
						validation: { targetCollection: "people" },
					}),
					fieldRow("place", "Place", "geo", 5, { unsupportedType: "geo" }),
				]),
		});
		renderMap(MAPPED);
		const author = await screen.findByTestId("field:author");
		expect(within(author).getByRole("button", { name: /^Author/ })).toBeDisabled();
		expect(
			within(author).getByText(
				"This reference field is not linked to a collection to look entries up in",
			),
		).toBeVisible();
		expect(
			within(row("field:place")).getByText("This version of EmDash cannot read this field type"),
		).toBeVisible();
		const sentence =
			"Place has a field type this version of EmDash cannot read, so nothing can be imported into this collection";
		expect(screen.getAllByText(sentence)).toHaveLength(2);
		expect(next()).toHaveAccessibleDescription(sentence);
	});

	it("proposes a field by picking a key without dragging", async () => {
		routes();
		const { user } = renderMap(MAPPED);
		await fieldsLoaded();
		await user.click(screen.getByRole("button", { name: "+ Add a new field" }));
		const picker = within(details()).getByRole("combobox", { name: "Key for the new field" });
		await user.click(picker);
		await user.click(await screen.findByRole("option", { name: "Released" }));
		expect(probe.state.newFields.map((f) => [f.key, f.slug, f.type])).toEqual([
			["Released", "released_2", "datetime"],
		]);
		// Every existing field and every other proposal is taken.
		await user.click(picker);
		await user.click(await screen.findByRole("option", { name: "Released" }));
		expect(probe.state.newFields.map((f) => f.slug)).toEqual(["released_2", "released_3"]);
		expect(screen.getByText("From Released · slug released_3")).toBeVisible();

		const removes = screen.getAllByRole("button", { name: "Remove Released" });
		expect(removes).toHaveLength(2);
		await user.click(removes[1]!);
		expect(probe.state.newFields.map((f) => f.slug)).toEqual(["released_2"]);
	});

	it("shows taxonomy rows for the collection's taxonomies only", async () => {
		const manifest = MANIFEST as { taxonomies: unknown[] } & Record<string, unknown>;
		routes({
			"GET manifest": () => ({
				...manifest,
				taxonomies: [
					...manifest.taxonomies,
					{
						name: "section",
						label: "Sections",
						labelSingular: "Section",
						hierarchical: false,
						collections: ["pages"],
						locale: "en",
					},
				],
			}),
		});
		renderMap({
			...MAPPED,
			target: { collection: "posts", locale: "fr", translationLocale: "en" },
		});
		await fieldsLoaded();
		expect(await screen.findByTestId("taxonomy:category")).toHaveTextContent("Categories");
		expect(row("taxonomy:tag")).toHaveTextContent("Tags");
		expect(screen.queryByTestId("taxonomy:section")).toBeNull();
		expect(screen.queryByText("Sections")).toBeNull();
		expect(row("bylines")).toHaveTextContent("Bylines");
		expect(row("translationOf")).toHaveTextContent("Translation of (en)");
		// The schedule is Options' (preflight F4).
		expect(screen.queryByTestId("publishAt")).toBeNull();
		const ids = [
			...screen.getByRole("region", { name: "Posts fields" }).querySelectorAll("[data-testid]"),
		].map((el) => el.getAttribute("data-testid"));
		expect(ids).toEqual([
			"key",
			"slug",
			"field:title",
			"field:price",
			"field:released",
			"field:body",
			"taxonomy:category",
			"taxonomy:tag",
			"bylines",
			"translationOf",
			"new-field",
		]);
	});

	it("hides the translationOf row without a translation locale", async () => {
		routes();
		renderMap(MAPPED);
		await fieldsLoaded();
		expect(screen.queryByTestId("translationOf")).toBeNull();
	});
});
