import { LinkButton } from "@cloudflare/kumo";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { TemplatesTab } from "../../src/admin/home/templates/TemplatesTab.js";
import { queryKeys } from "../../src/admin/queries.js";
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

/** Opens the template's menu and picks `item` (its accessible name names the row). */
async function pick(user: UserEvent, name: string, item: string) {
	await user.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
	await user.click(await screen.findByRole("menuitem", { name: `${item} ${name}` }));
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Templates tab", () => {
	it("lists every template with its description under the name, collection and locale, revision and last change", async () => {
		mockRoutes({
			"templates/list": () =>
				page([
					templateRow({ description: "Hourly products", revision: 3, locale: "fr" }),
					templateRow({ id: "T2", name: "Events" }),
				]),
			"schedules/list": () => page([]),
		});
		show();
		const row = (await screen.findByText("Products feed")).closest("tr")!;
		const cells = within(row).getAllByRole("cell");
		expect(cells[0]).toHaveTextContent(/^Products feedHourly products$/);
		expect(cells[1]).toHaveTextContent(/^posts \u00b7 fr$/);
		// Under "Revision", just the number.
		expect(cells[2]).toHaveTextContent(/^3$/);
		expect(cells[3]).toHaveTextContent(/09:00 UTC/);
		expect(row.querySelector("time")).toBeTruthy();
		for (const head of ["Template", "Collection", "Revision", "Last change"]) {
			expect(screen.getByRole("columnheader", { name: head })).toBeTruthy();
		}
		expect(screen.queryByRole("columnheader", { name: "Description" })).toBeNull();
		const events = (await screen.findByText("Events")).closest("tr")!;
		expect(within(events).getByText("No description")).toBeTruthy();
		// The summary line: the count, and what templates are for.
		expect(screen.getByText("2 templates").parentElement).toHaveTextContent(
			/^2 templates · saved mappings you can reuse or share$/,
		);
	});

	it("puts Export, Rename and describe, and Delete in the row's menu, Delete last in the danger colour", async () => {
		mockRoutes({ "templates/list": () => page([templateRow()]), "schedules/list": () => page([]) });
		const { user } = show();
		const trigger = await screen.findByRole("button", { name: "Actions for Products feed" });
		await user.click(trigger);
		const items = await screen.findAllByRole("menuitem");
		expect(items.map((i) => [i.getAttribute("aria-label"), i.textContent])).toEqual([
			["Export Products feed", "Export"],
			["Rename and describe Products feed", "Rename and describe"],
			["Delete Products feed", "Delete"],
		]);
		expect(items[2]).toHaveClass("text-kumo-danger");
		// One visible action besides the menu: Use.
		const row = (await screen.findByText("Products feed")).closest("tr")!;
		expect(within(row).getAllByRole("button")).toEqual([trigger]);
		expect(within(row).getByRole("link", { name: "Use Products feed" })).toHaveTextContent(/^Use$/);
	});

	it("stacks the rows when the tab is narrow", async () => {
		// The width is measured on the tab (ResizeObserver), not the viewport.
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width: 460,
		} as DOMRect);
		mockRoutes({
			"templates/list": () => page([templateRow({ revision: 3 })]),
			"schedules/list": () => page([]),
		});
		show();
		const row = (await screen.findByText("Products feed")).closest("li")!;
		expect(row).not.toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
		expect(row).toHaveTextContent(/posts \u00b7 en \u00b7 Rev\. 3 \u00b7 /);
		expect(within(row).getByRole("link", { name: "Use Products feed" })).toBeTruthy();
		expect(within(row).getByRole("button", { name: "Actions for Products feed" })).toBeTruthy();
	});

	it("links Use to the wizard with ?template=", async () => {
		mockRoutes({ "templates/list": () => page([templateRow()]), "schedules/list": () => page([]) });
		show();
		const use = await screen.findByRole("link", { name: "Use Products feed" });
		expect(use.getAttribute("href")).toBe("/_emdash/admin/plugins/fluximporter/import?template=T1");
	});

	it("exports through templates/export and saves the file under its filename", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		let download = "";
		// Spied, so the real `URL` is restored after the test.
		const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
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
		await pick(user, "Products feed", "Export");
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
		await pick(view.user, "Products feed", "Rename and describe");
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

	it("makes the renamed template's own body stale", async () => {
		const { user, dialog, queryClient, updateBodies } = await rename({ check: false });
		queryClient.setQueryData(queryKeys.template("T1"), { id: "T1", revision: 3 });
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(updateBodies).toHaveLength(1));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(queryClient.getQueryState(queryKeys.template("T1"))?.isInvalidated).toBe(true);
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
		await pick(user, "Products feed", "Rename and describe");
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
		await pick(user, "Products feed", "Delete");
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
		await pick(user, "Products feed", "Delete");
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
		await user.upload(
			within(dialog).getByLabelText("Template file (.json)", { selector: "input" }),
			file,
		);
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
			await within(dialog).findByText(/This file is not a template that Flux Importer can read/),
		).toBeTruthy();

		answer.current = saved({ name: "Copy" });
		await user.click(go);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies.at(-1)).toEqual({ file: { v: 1 }, name: "Copy", owner: "feed:1" });
		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Imported Copy.");
	});

	it("opens the file chooser from a Browse files button and names the chosen file (Task 16)", async () => {
		const { user, dialog } = await openImport();
		const input = within(dialog).getByLabelText("Template file (.json)", { selector: "input" });
		// The browser's own control has no button look in the admin: kept for its label and file only.
		expect(input).toHaveClass("sr-only");
		expect(input).toHaveAttribute("tabindex", "-1");
		expect(input).toHaveAttribute("aria-hidden", "true");
		const browse = within(dialog).getByRole("button", {
			name: "Template file (.json) Browse files",
		});
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		await user.click(browse);
		expect(click).toHaveBeenCalledTimes(1);
		click.mockRestore();
		const file = new File([JSON.stringify({ v: 1 })], "products-feed.json", {
			type: "application/json",
		});
		await user.upload(input, file);
		expect(await within(dialog).findByText("Chosen file: products-feed.json")).toBeVisible();
	});

	it("refuses a file that is not JSON or over 2 MiB before sending it", async () => {
		const { user, dialog, bodies } = await openImport();
		const input = within(dialog).getByLabelText("Template file (.json)", { selector: "input" });
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
			await pick(user, "Products feed", "Rename and describe");
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

	it("keeps Save disabled while the schedules load, with a named Loader", async () => {
		mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () => new Promise(() => {}),
		});
		const { user } = show();
		await pick(user, "Products feed", "Rename and describe");
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByRole("status", { name: "Checking the schedules" })).toBeTruthy();
		await user.type(within(dialog).getByLabelText(/Description/), "x");
		expect(
			(within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("says when the schedules could not be checked, and Try again lists them and enables Save", async () => {
		let n = 0;
		mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () =>
				++n === 1
					? fail("VALIDATION_ERROR", "x", 400)
					: page([schedule({ id: "S1", name: "Nightly" }), schedule({ id: "S2", name: "Hourly" })]),
		});
		const { user } = show();
		await pick(user, "Products feed", "Rename and describe");
		const dialog = await screen.findByRole("dialog");
		expect(
			await within(dialog).findByText(/couldn't check which schedules run this template/i),
		).toBeTruthy();
		await user.type(within(dialog).getByLabelText(/Description/), "x");
		expect(
			(within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
		).toBe(true);
		await user.click(within(dialog).getByRole("button", { name: "Try again" }));
		expect(
			await within(dialog).findByText("These schedules run this template: Nightly, Hourly."),
		).toBeTruthy();
		expect(
			(within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("offers no Try again after a 403 on the schedules", async () => {
		mockRoutes({
			"templates/list": () => page([templateRow()]),
			"schedules/list": () => fail("FORBIDDEN", "x", 403),
		});
		const { user } = show();
		await pick(user, "Products feed", "Rename and describe");
		const dialog = await screen.findByRole("dialog");
		expect(await within(dialog).findByText(/couldn't check which schedules/i)).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("keeps the newer file when an older read finishes last", async () => {
		const { user, dialog, bodies } = await openImport();
		const input = within(dialog).getByLabelText("Template file (.json)", { selector: "input" });
		// The older file's read ends only when the test says so, after the newer one's.
		let finishOld!: (text: string) => void;
		const oldText = new Promise<string>((r) => {
			finishOld = r;
		});
		const slow = new File(["{}"], "a.json", { type: "application/json" });
		Object.defineProperty(slow, "text", { value: () => oldText });
		await user.upload(input, slow);
		await user.upload(
			input,
			new File([JSON.stringify({ v: "new" })], "b.json", { type: "application/json" }),
		);
		const go = within(dialog).getByRole("button", { name: "Import" });
		await waitFor(() => expect(go).toBeEnabled());
		await act(async () => {
			finishOld(JSON.stringify({ v: "old" }));
			await oldText;
		});
		await user.click(go);
		await waitFor(() => expect(bodies).toEqual([{ file: { v: "new" } }]));
	});

	it("shows the empty state with the pointer to Save as template", async () => {
		mockRoutes({ "templates/list": () => page([]), "schedules/list": () => page([]) });
		show();
		expect(await screen.findByRole("heading", { name: "No templates yet" })).toBeTruthy();
		expect(screen.getByText("Save one from the wizard: Options, Save as template.")).toBeTruthy();
		expect(screen.getByText("0 templates")).toBeTruthy();
		const link = screen.getByRole("link", { name: "Open the wizard" });
		expect(link.getAttribute("href")).toBe("/_emdash/admin/plugins/fluximporter/import");
		// A button look, but secondary: New import on the home is the page's only primary button.
		const { container } = render(
			<LinkButton variant="secondary" href="/x">
				x
			</LinkButton>,
		);
		expect(link.className).toBe((container.firstElementChild as HTMLElement).className);
	});

	it("offers no Try again after a 403 on the list", async () => {
		mockRoutes({
			"templates/list": () => fail("FORBIDDEN", "Insufficient permissions", 403),
			"schedules/list": () => page([]),
		});
		show();
		expect(await screen.findByText("Only administrators can import.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("shows a load failure with Try again", async () => {
		let n = 0;
		mockRoutes({
			"templates/list": () =>
				++n === 1 ? fail("VALIDATION_ERROR", "x", 400) : page([templateRow()]),
			"schedules/list": () => page([]),
		});
		const { user } = show();
		expect(await screen.findByText("Templates could not be loaded.")).toBeTruthy();
		expect(
			screen.getByText(
				"The request was not valid. Check your entries and try again. Your imports are not affected.",
			),
		).toBeTruthy();
		// Importing a file needs no list: the action stays.
		expect(screen.getByRole("button", { name: "Import a template" })).toBeTruthy();
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Products feed")).toBeTruthy();
	});
});
