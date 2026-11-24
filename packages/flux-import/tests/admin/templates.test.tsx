import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { TemplatesTab } from "../../src/admin/home/templates/TemplatesTab.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";
import { schedule, templateRow } from "./home-fixtures.js";

const saved = (over: Record<string, unknown> = {}) => ({
	template: { ...templateRow(), template: {}, ...over },
	check: { problems: [], warnings: [] },
});

function show() {
	return renderAdmin(
		<HomeProvider initialTab="templates">
			<TemplatesTab />
		</HomeProvider>,
	);
}

const page = (items: unknown[]) => ({ items, hasMore: false });

afterEach(() => vi.restoreAllMocks());

describe("Templates tab", () => {
	it("lists every template with collection and locale, description, revision and last change", async () => {
		mockRoutes({
			"templates/list": () =>
				page([templateRow({ description: "Hourly products", revision: 3, locale: "fr" })]),
			"schedules/list": () => page([]),
		});
		show();
		const row = (await screen.findByText("Products feed")).closest("tr")!;
		expect(within(row).getByText("posts \u00b7 fr")).toBeTruthy();
		expect(within(row).getByText("Hourly products")).toBeTruthy();
		expect(within(row).getByText("Revision 3")).toBeTruthy();
		expect(row.querySelector("time")).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "Description" })).toBeTruthy();
	});

	it("links Use to the wizard with ?template=", async () => {
		mockRoutes({ "templates/list": () => page([templateRow()]), "schedules/list": () => page([]) });
		show();
		const use = await screen.findByRole("link", { name: "Use Products feed" });
		expect(use.getAttribute("href")).toBe("/_emdash/admin/plugins/flux-import/import?template=T1");
	});

	it("exports through templates/export and saves the file under its filename", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		let download = "";
		const create = vi.fn(() => "blob:x");
		vi.stubGlobal(
			"URL",
			Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => {} }),
		);
		const original = document.body.append.bind(document.body);
		vi.spyOn(document.body, "append").mockImplementation((...nodes: (Node | string)[]) => {
			for (const n of nodes) if (n instanceof HTMLAnchorElement) download = n.download;
			original(...nodes);
		});
		const { calls } = mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () => page([]),
			"templates/export": () => ({ filename: "products-feed.json", file: { v: 1 } }),
		});
		const { user } = show();
		await user.click(await screen.findByRole("button", { name: "Export Products feed" }));
		await waitFor(() => expect(click).toHaveBeenCalled());
		expect(calls.find((c) => c.route === "templates/export")?.body).toEqual({ id: "T1" });
		expect(download).toBe("products-feed.json");
		expect(create).toHaveBeenCalled();
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
			"Exported Products feed.",
		);
	});

	async function rename(opts: { check?: boolean; failS2?: unknown } = {}) {
		const updateBodies: unknown[] = [];
		const scheduleBodies: unknown[] = [];
		mockRoutes({
			"templates/list": () => page([templateRow({ revision: 3 })]),
			"schedules/list": () =>
				page([
					schedule({ id: "S1", name: "Nightly", revision: 2, enabled: true }),
					schedule({ id: "S2", name: "Hourly", revision: 5, enabled: false }),
					schedule({ id: "S3", name: "Other", templateId: "T9" }),
				]),
			"templates/update": (body) => {
				updateBodies.push(body);
				return saved({ revision: 4, name: "Products feed v2" });
			},
			"schedules/update": (body) => {
				scheduleBodies.push(body);
				if ((body as { id: string }).id === "S2" && opts.failS2 !== undefined)
					return opts.failS2 as Response;
				return { schedule: schedule() };
			},
		});
		const view = show();
		await view.user.click(
			await screen.findByRole("button", { name: "Rename and describe Products feed" }),
		);
		const dialog = await screen.findByRole("dialog");
		const name = within(dialog).getByLabelText("Name");
		await view.user.clear(name);
		await view.user.type(name, "Products feed v2");
		await view.user.type(within(dialog).getByLabelText(/Description/), "Daily");
		if (opts.check === false) await view.user.click(within(dialog).getByRole("checkbox"));
		return { ...view, dialog, updateBodies, scheduleBodies };
	}

	it("renames and describes at the revision, then updates the pinned schedules (Review Focus 4)", async () => {
		const { user, dialog, updateBodies, scheduleBodies } = await rename();
		expect(
			within(dialog).getByText("These schedules run this template: Nightly, Hourly."),
		).toBeTruthy();
		expect(within(dialog).getByText("Enabled schedules will run as you from now on.")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(scheduleBodies).toHaveLength(2));
		expect(updateBodies).toEqual([
			{ id: "T1", revision: 3, name: "Products feed v2", description: "Daily" },
		]);
		expect(scheduleBodies).toEqual([
			{ id: "S1", revision: 2, templateId: "T1", templateRevision: 4 },
			{ id: "S2", revision: 5, templateId: "T1", templateRevision: 4 },
		]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
			"Saved Products feed v2. Schedules updated: 2.",
		);
	});

	it("names a pinned schedule whose update failed, and says it will pause (Review Focus 4)", async () => {
		const { user, dialog } = await rename({
			failS2: fail("SCHEDULE_BUSY", "busy", 409),
		});
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText(/Couldn't update Hourly: .* It will pause at its next run\./),
		).toBeTruthy();
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
			"Schedules updated: 1. Some schedules could not be updated.",
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("tells the user to edit a schedule whose update needs a missing-entries rule", async () => {
		const { user, dialog } = await rename({
			failS2: fail("MISSING_REQUIRED", "m", 400),
		});
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText(/Couldn't update Hourly: .*edit that schedule/),
		).toBeTruthy();
	});

	it("says the schedules will pause when Also update is unchecked, and updates none", async () => {
		const { user, dialog, scheduleBodies, updateBodies } = await rename({ check: false });
		expect(
			within(dialog).getByText("They will pause at their next run until they are updated."),
		).toBeTruthy();
		expect(within(dialog).queryByText("Enabled schedules will run as you from now on.")).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(updateBodies).toHaveLength(1));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(scheduleBodies).toEqual([]);
	});

	it("shows TEMPLATE_CHANGED as changed elsewhere, and Reload refetches", async () => {
		let lists = 0;
		mockRoutes({
			"templates/list": () => {
				lists += 1;
				return page([templateRow()]);
			},
			"schedules/list": () => page([]),
			"templates/update": () => fail("TEMPLATE_CHANGED", "x", 409),
		});
		const { user } = show();
		await user.click(
			await screen.findByRole("button", { name: "Rename and describe Products feed" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByLabelText(/Description/), "x");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(await within(dialog).findByText("This template changed elsewhere.")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Reload" }));
		await waitFor(() => expect(lists).toBe(2));
	});

	it("refuses to delete a template a schedule runs, naming the schedules", async () => {
		mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () => page([schedule({ id: "S1", name: "Nightly" })]),
			"templates/delete": () => fail("TEMPLATE_IN_USE", "x", 409, { scheduleIds: ["S1"] }),
		});
		const { user } = show();
		await user.click(await screen.findByRole("button", { name: "Delete Products feed" }));
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Delete the template Products feed? Jobs made from it keep their copy.",
			),
		).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(
			await within(dialog).findByText(
				"Nightly run this template. Delete or change those schedules first.",
			),
		).toBeTruthy();
	});

	it("deletes at the row's revision and announces it", async () => {
		const bodies: unknown[] = [];
		mockRoutes({
			"templates/list": () => page([templateRow({ revision: 3 })]),
			"schedules/list": () => page([]),
			"templates/delete": (b) => {
				bodies.push(b);
				return { deleted: true };
			},
		});
		const { user } = show();
		await user.click(await screen.findByRole("button", { name: "Delete Products feed" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(bodies).toEqual([{ id: "T1", revision: 3 }]));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
			"Deleted Products feed.",
		);
	});

	async function openImport() {
		const bodies: unknown[] = [];
		const answer: { current: unknown } = { current: saved({ name: "Imported feed" }) };
		mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () => page([]),
			"templates/import": (b) => {
				bodies.push(b);
				return answer.current;
			},
		});
		const view = show();
		await view.user.click(await screen.findByRole("button", { name: "Import a template" }));
		const dialog = await screen.findByRole("dialog");
		return { ...view, dialog, bodies, answer };
	}

	it("imports a file with a new name and owner, and shows OWNER_IN_USE and INVALID_FILE in words", async () => {
		const { user, dialog, bodies, answer } = await openImport();
		const file = new File([JSON.stringify({ v: 1 })], "t.json", { type: "application/json" });
		await user.upload(within(dialog).getByLabelText("Template file (.json)"), file);
		await user.type(within(dialog).getByLabelText("New name (optional)"), "Copy");
		const owner = within(dialog).getByLabelText(/Owner/);
		await user.type(owner, "feed:1");
		const go = within(dialog).getByRole("button", { name: "Import" });
		await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));

		answer.current = fail("OWNER_IN_USE", "x", 409);
		await user.click(go);
		expect(
			await within(dialog).findByText(
				/Another template that tracks missing entries already uses this owner/,
			),
		).toBeTruthy();
		expect(document.activeElement).toBe(owner);

		answer.current = fail("INVALID_FILE", "bad file", 400);
		await user.click(go);
		expect(
			await within(dialog).findByText(/This file is not a template that flux-import can read/),
		).toBeTruthy();

		answer.current = saved({ name: "Copy" });
		await user.click(go);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies.at(-1)).toEqual({ file: { v: 1 }, name: "Copy", owner: "feed:1" });
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Imported Copy.");
	});

	it("refuses a file that is not JSON or over 2 MiB before sending it", async () => {
		const { user, dialog, bodies } = await openImport();
		const input = within(dialog).getByLabelText("Template file (.json)");
		await user.upload(input, new File(["not json"], "t.json", { type: "application/json" }));
		expect(await within(dialog).findByText("This file is not JSON.")).toBeTruthy();
		const big = new File(["{}"], "big.json", { type: "application/json" });
		Object.defineProperty(big, "size", { value: 2_097_153 });
		await user.upload(input, big);
		expect(
			await within(dialog).findByText("This file is over 2 MiB, too large for a template."),
		).toBeTruthy();
		expect(
			(within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(bodies).toEqual([]);
	});

	it("refuses an owner outside the pattern before sending it", async () => {
		const { user, dialog } = await openImport();
		await user.type(within(dialog).getByLabelText(/Owner/), "bad owner");
		expect(await within(dialog).findByText(/An owner is letters, digits/)).toBeTruthy();
	});

	it("sends null for an emptied description, and nothing at all when nothing changed", async () => {
		const bodies: unknown[] = [];
		mockRoutes({
			"templates/list": () => page([templateRow({ description: "Old" })]),
			"schedules/list": () => page([]),
			"templates/update": (b) => {
				bodies.push(b);
				return saved({ revision: 2 });
			},
		});
		const { user } = show();
		const open = async () => {
			await user.click(
				await screen.findByRole("button", { name: "Rename and describe Products feed" }),
			);
			return screen.findByRole("dialog");
		};
		let dialog = await open();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies).toEqual([]);
		dialog = await open();
		await user.clear(within(dialog).getByLabelText(/Description/));
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bodies).toEqual([{ id: "T1", revision: 1, description: null }]));
	});

	it("shows the empty state with the pointer to Save as template", async () => {
		mockRoutes({ "templates/list": () => page([]), "schedules/list": () => page([]) });
		show();
		expect(await screen.findByText("No saved templates yet.")).toBeTruthy();
		expect(screen.getByText("Save one from the wizard: Options, Save as template.")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open the wizard" }).getAttribute("href")).toBe(
			"/_emdash/admin/plugins/flux-import/import",
		);
	});

	it("shows a load failure with Try again", async () => {
		let n = 0;
		mockRoutes({
			"templates/list": () =>
				++n === 1 ? fail("VALIDATION_ERROR", "x", 400) : page([templateRow()]),
			"schedules/list": () => page([]),
		});
		const { user } = show();
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Products feed")).toBeTruthy();
	});
});
