import { act, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { APPLY_FIELD_TYPES, MAX_APPLY_FIELDS } from "../../src/admin/limits.js";
import { queryKeys } from "../../src/admin/queries.js";
import { NewFields } from "../../src/admin/wizard/map/new-fields/NewFields.js";
import { SchemaDiffDialog } from "../../src/admin/wizard/map/new-fields/SchemaDiffDialog.js";
import type { ProposedField } from "../../src/admin/wizard/state.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";

const proposed = (key: string, slug: string, type: string): ProposedField => ({
	key,
	slug,
	label: key,
	type,
	translatable: true,
	searchable: false,
});

const FIELDS: ProposedField[] = [
	proposed("Released", "released", "datetime"),
	proposed("Price", "price", "number"),
	proposed("Summary", "summary", "text"),
];

/** The `fields` the dialog sends for `FIELDS`. */
const BODY_FIELDS = FIELDS.map(({ slug, type, label, translatable, searchable }) => ({
	slug,
	type,
	label,
	translatable,
	searchable,
}));

type Change = { field: string; action: string; type: string; message?: string };

const CREATE: Change[] = FIELDS.map((f) => ({ field: f.slug, action: "create", type: f.type }));

const PRICE_CONFLICT = 'Field "price" is "string"; requested "number"';

/** `schema/apply`'s reply to `body`: `changes` planned, and applied unless a dry run. */
function reply(body: unknown, changes: Change[], error: unknown = null) {
	const dryRun = (body as { dryRun: boolean }).dryRun;
	const applied = dryRun
		? []
		: changes
				.filter((c) => c.action === "create" || c.action === "add_options")
				.map((c) => c.field);
	return { collection: "posts", dryRun, changes, applied, error };
}

function renderDialog(
	fields: readonly ProposedField[] = FIELDS,
	props: Partial<{ onApplied(slugs: string[]): void; onCancel(): void }> = {},
) {
	const onApplied = vi.fn<(slugs: string[]) => void>(props.onApplied);
	const onCancel = vi.fn<() => void>(props.onCancel);
	const result = renderAdmin(
		<SchemaDiffDialog
			collection="posts"
			fields={fields}
			open
			onApplied={onApplied}
			onCancel={onCancel}
		/>,
	);
	return { ...result, onApplied, onCancel };
}

/** The dialog under a parent whose `open` and `fields` a test changes. */
function renderHost() {
	let set: (patch: { open?: boolean; fields?: ProposedField[] }) => void = () => {};
	function Host() {
		const [state, setState] = useState({ open: true, fields: FIELDS });
		set = (patch) => setState((s) => ({ ...s, ...patch }));
		return (
			<SchemaDiffDialog
				collection="posts"
				fields={state.fields}
				open={state.open}
				onApplied={() => {}}
				onCancel={() => {}}
			/>
		);
	}
	const result = renderAdmin(<Host />);
	return { ...result, set: (patch: Parameters<typeof set>[0]) => set(patch) };
}

const dialog = () => screen.findByRole("dialog", { name: "Add these fields to the collection?" });
const confirm = () => screen.getByRole("button", { name: "Add the fields" });

describe("SchemaDiffDialog", () => {
	it("plans with dryRun true on open and lists the changes", async () => {
		const { calls } = mockRoutes({
			"schema/apply": (body) =>
				reply(body, [
					{ field: "released", action: "create", type: "datetime" },
					{ field: "price", action: "conflict", type: "number", message: PRICE_CONFLICT },
					{ field: "summary", action: "unchanged", type: "text" },
				]),
		});
		renderDialog();
		const list = within(await dialog()).getByRole("list");
		await within(list).findByText("Released (released): a new datetime field");
		expect(within(list).getByText("Price (price) cannot be added")).toBeInTheDocument();
		expect(within(list).getByText(PRICE_CONFLICT)).toBeInTheDocument();
		expect(
			within(list).getByText("Summary (summary) already exists as a text field; nothing changes"),
		).toBeInTheDocument();
		expect(calls.map((c) => c.body)).toEqual([
			{ collection: "posts", fields: BODY_FIELDS, dryRun: true },
		]);
	});

	it("disables Confirm while a change is a conflict", async () => {
		mockRoutes({
			"schema/apply": (body) =>
				reply(body, [
					{ field: "released", action: "create", type: "datetime" },
					{ field: "price", action: "conflict", type: "number", message: PRICE_CONFLICT },
					{ field: "summary", action: "create", type: "text" },
				]),
		});
		renderDialog();
		await screen.findByText(PRICE_CONFLICT);
		expect(confirm()).toBeDisabled();
		expect(
			screen.getByText("Remove or change the fields that cannot be added to continue."),
		).toBeInTheDocument();
	});

	it("keeps Confirm disabled until the plan arrives", async () => {
		let answer: (value: unknown) => void = () => {};
		mockRoutes({
			"schema/apply": (body) =>
				new Promise((resolve) => {
					answer = () => resolve(reply(body, CREATE));
				}),
		});
		renderDialog();
		await dialog();
		expect(confirm()).toBeDisabled();
		answer(null);
		await waitFor(() => expect(confirm()).toBeEnabled());
	});

	it("plans again, without the old plan, when the fields change while open", async () => {
		const answers: ((value: unknown) => void)[] = [];
		const { calls } = mockRoutes({
			"schema/apply": (body) => {
				const fields = (body as { fields: { slug: string }[] }).fields;
				const changes = CREATE.filter((c) => fields.some((f) => f.slug === c.field));
				return new Promise((resolve) => answers.push(() => resolve(reply(body, changes))));
			},
		});
		const host = renderHost();
		await waitFor(() => expect(answers).toHaveLength(1));
		answers[0]?.(null);
		await waitFor(() => expect(confirm()).toBeEnabled());
		act(() => host.set({ fields: FIELDS.slice(0, 2) }));
		expect(confirm()).toBeDisabled();
		expect(screen.queryByText(/Summary \(summary\)/)).not.toBeInTheDocument();
		await waitFor(() => expect(answers).toHaveLength(2));
		answers[1]?.(null);
		await waitFor(() => expect(confirm()).toBeEnabled());
		expect(calls.map((c) => c.body)).toEqual([
			{ collection: "posts", fields: BODY_FIELDS, dryRun: true },
			{ collection: "posts", fields: BODY_FIELDS.slice(0, 2), dryRun: true },
		]);
	});

	it("ignores a plan that answers after the fields changed", async () => {
		const answers: ((changes: Change[]) => void)[] = [];
		mockRoutes({
			"schema/apply": (body) =>
				new Promise((resolve) => answers.push((changes) => resolve(reply(body, changes)))),
		});
		const host = renderHost();
		await waitFor(() => expect(answers).toHaveLength(1));
		act(() => host.set({ fields: FIELDS.slice(0, 2) }));
		await waitFor(() => expect(answers).toHaveLength(2));
		answers[1]?.(CREATE.slice(0, 2));
		await waitFor(() => expect(confirm()).toBeEnabled());
		answers[0]?.([{ field: "price", action: "conflict", type: "number", message: PRICE_CONFLICT }]);
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByText(PRICE_CONFLICT)).not.toBeInTheDocument();
		expect(confirm()).toBeEnabled();
	});

	it("drops a refused plan's error when it is closed and opened again", async () => {
		let refuse = true;
		mockRoutes({
			"schema/apply": (body) =>
				refuse ? fail("VALIDATION_ERROR", "labels are 1-200 characters", 400) : reply(body, CREATE),
		});
		const host = renderHost();
		await screen.findByRole("alert");
		refuse = false;
		act(() => host.set({ open: false }));
		act(() => host.set({ open: true }));
		await waitFor(() => expect(confirm()).toBeEnabled());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("applies with dryRun false on Confirm and reports the applied slugs", async () => {
		const { calls } = mockRoutes({ "schema/apply": (body) => reply(body, CREATE) });
		const { user, onApplied, queryClient } = renderDialog();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
		expect(onApplied).toHaveBeenCalledWith(["released", "price", "summary"]);
		expect(calls.map((c) => c.body)).toEqual([
			{ collection: "posts", fields: BODY_FIELDS, dryRun: true },
			{ collection: "posts", fields: BODY_FIELDS, dryRun: false },
		]);
		// The schema changed, so the collection's fields are read again (spec "New fields").
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.fields("posts") });
	});

	it("an unchanged change still counts as applied (preflight F16)", async () => {
		mockRoutes({
			"schema/apply": (body) =>
				reply(body, [
					{ field: "released", action: "create", type: "datetime" },
					{ field: "price", action: "unchanged", type: "number" },
					{ field: "summary", action: "add_options", type: "text" },
				]),
		});
		const { user, onApplied } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		await waitFor(() => expect(onApplied).toHaveBeenCalledWith(["released", "price", "summary"]));
	});

	it("leaves out a field that became a conflict meanwhile, and shows it", async () => {
		mockRoutes({
			"schema/apply": (body) =>
				(body as { dryRun: boolean }).dryRun
					? reply(body, CREATE)
					: reply(body, [
							{ field: "released", action: "create", type: "datetime" },
							{ field: "price", action: "conflict", type: "number", message: PRICE_CONFLICT },
							{ field: "summary", action: "create", type: "text" },
						]),
		});
		const { user, onApplied } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		await waitFor(() => expect(onApplied).toHaveBeenCalledWith(["released", "summary"]));
		expect(screen.getByText(PRICE_CONFLICT)).toBeInTheDocument();
	});

	it("shows result.error and stays open", async () => {
		const error = { code: "SCHEMA_FAILED", message: 'Could not create "price": disk full' };
		mockRoutes({
			"schema/apply": (body) => {
				const dryRun = (body as { dryRun: boolean }).dryRun;
				if (dryRun) return reply(body, CREATE);
				return { ...reply(body, CREATE), applied: ["released"], error };
			},
		});
		const { user, onApplied, onCancel } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Something went wrong.");
		expect(alert).toHaveTextContent('Could not create "price": disk full');
		expect(await dialog()).toBeInTheDocument();
		expect(onApplied).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
		// Applying again is safe: what was applied now plans as unchanged.
		expect(confirm()).toBeEnabled();
	});

	it("shows a refused plan with the route's specifics and allows no Confirm", async () => {
		mockRoutes({
			"schema/apply": () =>
				fail("VALIDATION_ERROR", 'Field "price": labels are 1-200 characters', 400),
		});
		renderDialog();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The request was not valid. Check your entries and try again.");
		expect(alert).toHaveTextContent('Field "price": labels are 1-200 characters');
		expect(confirm()).toBeDisabled();
	});

	it("reports a request that fails on Confirm without closing", async () => {
		mockRoutes({
			"schema/apply": (body) =>
				(body as { dryRun: boolean }).dryRun
					? reply(body, CREATE)
					: fail("INTERNAL_ERROR", "boom", 500),
		});
		const { user, onApplied } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Something went wrong on the server. Try again.",
		);
		expect(onApplied).not.toHaveBeenCalled();
		expect(confirm()).toBeEnabled();
	});

	it("writes nothing on Cancel", async () => {
		const { calls } = mockRoutes({ "schema/apply": (body) => reply(body, CREATE) });
		const { user, onCancel, onApplied } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onApplied).not.toHaveBeenCalled();
		expect(calls.map((c) => (c.body as { dryRun: boolean }).dryRun)).toEqual([true]);
	});

	it("cannot be cancelled while the fields are being added", async () => {
		let answer: () => void = () => {};
		mockRoutes({
			"schema/apply": (body) =>
				(body as { dryRun: boolean }).dryRun
					? reply(body, CREATE)
					: new Promise((resolve) => {
							answer = () => resolve(reply(body, CREATE));
						}),
		});
		const { user, onCancel, onApplied } = renderDialog();
		await waitFor(() => expect(confirm()).toBeEnabled());
		await user.click(confirm());
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(onCancel).not.toHaveBeenCalled();
		answer();
		await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
		await user.keyboard("{Escape}");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it(`says so and does not call over ${MAX_APPLY_FIELDS} fields`, async () => {
		const { calls } = mockRoutes({ "schema/apply": (body) => reply(body, CREATE) });
		const many = Array.from({ length: MAX_APPLY_FIELDS + 2 }, (_, i) =>
			proposed(`Key ${i}`, `key_${i}`, "string"),
		);
		renderDialog(many);
		await dialog();
		expect(
			screen.getByText("At most 100 fields can be added at once. Remove 2 to continue."),
		).toBeInTheDocument();
		expect(confirm()).toBeDisabled();
		expect(calls).toEqual([]);
	});

	it("does not call while closed", async () => {
		const { calls } = mockRoutes({ "schema/apply": (body) => reply(body, CREATE) });
		renderAdmin(
			<SchemaDiffDialog
				collection="posts"
				fields={FIELDS}
				open={false}
				onApplied={() => {}}
				onCancel={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(calls).toEqual([]);
	});
});

describe("NewFields", () => {
	function renderFields() {
		const onChange = vi.fn<(slug: string, patch: Partial<ProposedField>) => void>();
		const onRemove = vi.fn<(slug: string) => void>();
		const result = renderAdmin(
			<NewFields fields={FIELDS} onChange={onChange} onRemove={onRemove} />,
		);
		return { ...result, onChange, onRemove };
	}

	it("lets the user change a proposed field's type among APPLY_FIELD_TYPES", async () => {
		const { user, onChange } = renderFields();
		const row = screen.getByRole("group", { name: "Released" });
		await user.click(within(row).getByRole("combobox", { name: "Type" }));
		const options = await screen.findAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([...APPLY_FIELD_TYPES]);
		await user.click(screen.getByRole("option", { name: "text" }));
		expect(onChange).toHaveBeenCalledWith("released", { type: "text" });
	});

	it("shows each field's key, slug and type", () => {
		renderFields();
		const row = screen.getByRole("group", { name: "Price" });
		expect(within(row).getByText("From Price · slug price")).toBeInTheDocument();
		expect(within(row).getByRole("combobox", { name: "Type" })).toHaveTextContent("number");
	});

	it("edits the label and the flags", async () => {
		const { user, onChange } = renderFields();
		const row = screen.getByRole("group", { name: "Summary" });
		await user.type(within(row).getByRole("textbox", { name: "Label" }), "!");
		expect(onChange).toHaveBeenLastCalledWith("summary", { label: "Summary!" });
		await user.click(within(row).getByRole("checkbox", { name: "Translatable" }));
		expect(onChange).toHaveBeenLastCalledWith("summary", { translatable: false });
		await user.click(within(row).getByRole("checkbox", { name: "Searchable" }));
		expect(onChange).toHaveBeenLastCalledWith("summary", { searchable: true });
	});

	it("removes a field", async () => {
		const { user, onRemove } = renderFields();
		await user.click(screen.getByRole("button", { name: "Remove Price" }));
		expect(onRemove).toHaveBeenCalledWith("price");
	});

	it("renders nothing without proposed fields", () => {
		const { container } = renderAdmin(
			<NewFields fields={[]} onChange={() => {}} onRemove={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
