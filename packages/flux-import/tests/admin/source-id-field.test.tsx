import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_ID_WIDGET, SourceIdField } from "../../src/admin/fields/SourceIdField.js";
import { SOURCE_ID_FIELD_WIDGET } from "../../src/emdash/schema.js";
import { renderAdmin } from "./harness.js";

/** The widget as the content editor renders it for `flux_source_id`. */
function renderField(value: unknown, minimal?: boolean) {
	const onChange = vi.fn();
	const result = renderAdmin(
		<SourceIdField
			value={value}
			onChange={onChange}
			label="Flux source ID"
			id="field-flux_source_id"
			{...(minimal === undefined ? {} : { minimal })}
		/>,
	);
	return { ...result, onChange };
}

describe("the flux_source_id field widget", () => {
	it("is the widget the server gives flux_source_id", () => {
		expect(SOURCE_ID_FIELD_WIDGET).toBe(`flux-import:${SOURCE_ID_WIDGET}`);
	});

	it("shows the label and a collapsed Import ID control, without the value", () => {
		renderField("SKU-0");
		const group = screen.getByRole("group", { name: "Flux source ID" });
		expect(group).toHaveAttribute("id", "field-flux_source_id");
		const toggle = screen.getByRole("button", { name: "Import ID" });
		expect(group).toContainElement(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("SKU-0")).toBeNull();
	});

	it("reveals the value as read-only text, and hides it again", async () => {
		const { user, onChange } = renderField("SKU-0");
		const toggle = screen.getByRole("button", { name: "Import ID" });
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("SKU-0")).toBeVisible();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(document.querySelector("input, textarea, [contenteditable]")).toBeNull();
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("SKU-0")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("opens from the keyboard", async () => {
		const { user, onChange } = renderField("SKU-0");
		await user.tab();
		expect(screen.getByRole("button", { name: "Import ID" })).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(screen.getByText("SKU-0")).toBeVisible();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("uses the built-in fields' compact label in the minimal layout", () => {
		const { unmount } = renderField("SKU-0");
		expect(screen.getByText("Flux source ID")).toHaveClass("text-base", "font-medium");
		unmount();
		renderField("SKU-0", true);
		const legend = screen.getByText("Flux source ID");
		expect(legend).toHaveClass("text-kumo-subtle/50", "text-xs", "font-normal");
		expect(legend).not.toHaveClass("text-base");
		expect(screen.getByRole("group", { name: "Flux source ID" })).toBeInTheDocument();
	});

	it("says so when the entry has no import ID", async () => {
		for (const value of [null, undefined, ""]) {
			const { user, onChange, unmount } = renderField(value);
			await user.click(screen.getByRole("button", { name: "Import ID" }));
			expect(screen.getByText("No import ID")).toBeVisible();
			expect(onChange).not.toHaveBeenCalled();
			unmount();
		}
	});
});
