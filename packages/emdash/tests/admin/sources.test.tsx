import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeProvider } from "../../src/admin/home/Home.js";
import { SourcesTab } from "../../src/admin/home/sources/SourcesTab.js";
import { UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteHandler, renderAdmin } from "./harness.js";
import { schedule, sourceRow } from "./home-fixtures.js";

const SECRET_URL = "https://u:p@feed.example.com/a/b.json?token=s3cret";
const page = <T,>(items: T[]) => ({ items, hasMore: false });

function setup(table: Record<string, RouteHandler>) {
	const routes = mockRoutes({
		"sources/list": () => page([sourceRow()]),
		"credentials/list": () => [],
		"schedules/list": () => page([]),
		...table,
	});
	const view = renderAdmin(
		<HomeProvider>
			<SourcesTab />
		</HomeProvider>,
	);
	return { ...routes, ...view };
}

/** Opens the source's menu and picks `item` (its accessible name names the row). */
async function pick(user: UserEvent, name: string, item: string) {
	await user.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
	await user.click(await screen.findByRole("menuitem", { name: `${item} ${name}` }));
}

const bodies = (calls: { route: string; body: unknown }[], route: string) =>
	calls.filter((c) => c.route === route).map((c) => c.body);

describe("SourcesTab", () => {
	it("lists name, host and path only, the credential's name, and the last fetch in words (Review Focus 3)", async () => {
		setup({
			"sources/list": () =>
				page([
					sourceRow({
						url: SECRET_URL,
						credential: "feed-token",
						lastFetch: {
							at: "2026-11-20T10:00:00.000Z",
							status: 200,
							sha256: "abc",
							bytes: 10,
							uploadId: UPLOAD_ID,
						},
						lastError: {
							at: "2026-11-21T10:00:00.000Z",
							code: "HTTP_ERROR",
							message: `HTTP 500 from ${SECRET_URL}`,
						},
					}),
					sourceRow({ id: "S2", name: "Plain", url: "https://plain.example.com/x.csv" }),
				]),
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
		});
		expect(await screen.findByText("feed.example.com/a/b.json")).toBeVisible();
		expect(screen.getByText("plain.example.com/x.csv")).toBeVisible();
		expect(screen.getAllByText("feed-token").length).toBeGreaterThan(0);
		expect(screen.getByText("No credential")).toBeVisible();
		// The newer failure, with its code in words under the time (never its message).
		const failed = screen.getByText(/^Failed /);
		expect(failed).toHaveTextContent(/^Failed (Today|Yesterday|.+) 10:00 UTC$/);
		expect(failed.nextElementSibling).toHaveTextContent(/^The address answered with an error\.$/);
		expect(screen.getByText("Never fetched")).toBeVisible();
		for (const head of ["Source", "Credential", "Last fetch"]) {
			expect(screen.getByRole("columnheader", { name: head })).toBeVisible();
		}
		// The summary line: the sources, then the credentials.
		expect(screen.getByText("2 URL sources").parentElement).toHaveTextContent(
			/^2 URL sources · 1 credential$/,
		);
		for (const secret of ["s3cret", "u:p", UPLOAD_ID, "HTTP 500 from"]) {
			expect(document.body.textContent).not.toContain(secret);
		}
	});

	it("says a source's credential is missing once it is no longer saved", async () => {
		setup({
			"sources/list": () =>
				page([
					sourceRow({ credential: "gone-token" }),
					sourceRow({ id: "S2", name: "Kept", credential: "feed-token" }),
				]),
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
		});
		expect(await screen.findByText("gone-token (missing)")).toBeVisible();
		const kept = screen.getByText("Kept").closest("tr")!;
		expect(within(kept).getByText("feed-token")).toBeVisible();
		expect(screen.queryByText("feed-token (missing)")).toBeNull();
	});

	it("offers no Try again after a 403 on the list", async () => {
		setup({ "sources/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
		expect(await screen.findByText("Only administrators can import.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("says Fetched when the fetch is newer than the last failure", async () => {
		setup({
			"sources/list": () =>
				page([
					sourceRow({
						lastFetch: {
							at: "2026-11-22T10:00:00.000Z",
							status: 200,
							sha256: "abc",
							bytes: 10,
							uploadId: UPLOAD_ID,
						},
						lastError: { at: "2026-11-21T10:00:00.000Z", code: "HTTP_ERROR", message: "x" },
					}),
				]),
		});
		expect(await screen.findByText(/^Fetched /)).toBeVisible();
		expect(screen.queryByText(/^Failed /)).toBeNull();
		// The fetch's size, in the viewer's words.
		expect(screen.getByText("10 byte")).toBeVisible();
	});

	it("says how many records the last fetch held, and the HTTP status a failed one got", async () => {
		const fetch = { status: 200, sha256: "abc", bytes: 4096, uploadId: UPLOAD_ID };
		setup({
			"sources/list": () =>
				page([
					sourceRow({
						lastFetch: { ...fetch, at: "2026-11-22T10:00:00.000Z", records: 10 },
					}),
					sourceRow({
						id: "S2",
						name: "Stock",
						lastFetch: { ...fetch, at: "2026-11-20T10:00:00.000Z" },
						lastError: {
							at: "2026-11-22T10:00:00.000Z",
							code: "HTTP_ERROR",
							message: `The server answered HTTP 503 at ${SECRET_URL}`,
							status: 503,
						},
					}),
				]),
		});
		expect(await screen.findByText("10 records · 4 kB")).toBeVisible();
		const failed = screen.getByText("Stock").closest("tr")!;
		expect(within(failed).getByText("HTTP 503 from the server")).toBeVisible();
		expect(document.body.textContent).not.toContain("s3cret");
	});

	it("adds a source with name, URL and credential", async () => {
		const { calls, user } = setup({
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
			"sources/create": () => sourceRow({ id: "S9", name: "New feed" }),
		});
		await user.click(await screen.findByRole("button", { name: "Add a source" }));
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "New feed");
		await user.type(
			within(dialog).getByRole("textbox", { name: "Address" }),
			"https://new.example.com/f.json",
		);
		await user.click(within(dialog).getByRole("combobox", { name: "Credential" }));
		await user.click(await screen.findByRole("option", { name: "feed-token" }));
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/create")).toEqual([
			{ name: "New feed", url: "https://new.example.com/f.json", credential: "feed-token" },
		]);
	});

	it("says the name is taken for a CONFLICT from create", async () => {
		const { user } = setup({
			"sources/create": () => fail("CONFLICT", "name", 409),
		});
		await user.click(await screen.findByRole("button", { name: "Add a source" }));
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Feed");
		await user.type(
			within(dialog).getByRole("textbox", { name: "Address" }),
			"https://a.example/x",
		);
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText("A source with this name already exists."),
		).toBeVisible();
	});

	it("offers Also update for enabled schedules only when the URL or credential changes (Review Focus 4)", async () => {
		const schedules = [
			schedule({ id: "SC1", name: "Nightly", revision: 2 }),
			schedule({ id: "SC2", name: "Weekly", enabled: false }),
		];
		const { calls, user } = setup({
			"schedules/list": () => page(schedules),
			"sources/update": () => sourceRow(),
			"schedules/update": () => ({ schedule: schedules[0] }),
		});
		// A name-only edit offers nothing and updates no schedule.
		await pick(user, "Feed", "Edit");
		let dialog = await screen.findByRole("dialog");
		const name = within(dialog).getByRole("textbox", { name: "Name" });
		await user.clear(name);
		await user.type(name, "Renamed");
		expect(within(dialog).queryByText("Also update these schedules")).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/update")).toEqual([{ id: "S1", name: "Renamed" }]);
		expect(bodies(calls, "schedules/update")).toEqual([]);

		// A URL edit names the enabled schedule and updates it after the save.
		await pick(user, "Feed", "Edit");
		dialog = await screen.findByRole("dialog");
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		expect(within(dialog).getByText("These schedules read this source: Nightly.")).toBeVisible();
		expect(
			within(dialog).getByRole("checkbox", { name: "Also update these schedules" }),
		).toBeChecked();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/update")[1]).toEqual({
			id: "S1",
			url: "https://feed.example.com/new.json",
		});
		expect(bodies(calls, "schedules/update")).toEqual([{ id: "SC1", revision: 2, enabled: true }]);
		expect(await screen.findByText("Saved Feed. Schedules updated: 1.")).toBeInTheDocument();
	});

	it("leaves the schedules alone when Also update is unchecked", async () => {
		const { calls, user } = setup({
			"schedules/list": () => page([schedule()]),
			"sources/update": () => sourceRow(),
		});
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		await user.click(within(dialog).getByRole("checkbox", { name: "Also update these schedules" }));
		expect(
			within(dialog).getByText("They will pause at their next run until they are updated."),
		).toBeVisible();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "schedules/update")).toEqual([]);
	});

	it("removes the credential with null and offers the update for it too", async () => {
		const { calls, user } = setup({
			"sources/list": () => page([sourceRow({ credential: "feed-token" })]),
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
			"schedules/list": () => page([schedule()]),
			"sources/update": () => sourceRow(),
			"schedules/update": () => ({ schedule: schedule() }),
		});
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "Credential" }));
		await user.click(await screen.findByRole("option", { name: "No credential" }));
		expect(within(dialog).getByText("These schedules read this source: Nightly.")).toBeVisible();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/update")).toEqual([{ id: "S1", credential: null }]);
		expect(bodies(calls, "schedules/update")).toHaveLength(1);
	});

	it("names a schedule whose update failed and announces it", async () => {
		const { user } = setup({
			"schedules/list": () => page([schedule()]),
			"sources/update": () => sourceRow(),
			"schedules/update": () => fail("SCHEDULE_BUSY", "busy", 409),
		});
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText(
				/Couldn't update Nightly: .* It will pause at its next run\./,
			),
		).toBeVisible();
		expect(
			await screen.findByText("Saved Feed. Schedules updated: 0. Not updated: Nightly."),
		).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("uses the global conflict sentence for a CONFLICT from an update that kept the name", async () => {
		const { user } = setup({ "sources/update": () => fail("CONFLICT", "x", 409) });
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText("Something else changed this at the same time. Try again."),
		).toBeVisible();
		expect(within(dialog).queryByText("A source with this name already exists.")).toBeNull();
	});

	it("fetches now and says whether the content changed", async () => {
		let changed = true;
		const { calls, user } = setup({
			"sources/fetch": () => ({ changed, uploadId: UPLOAD_ID, bytes: 1, sha256: "a" }),
		});
		await user.click(await screen.findByRole("button", { name: "Fetch now Feed" }));
		expect(await screen.findByText("New content fetched.")).toBeInTheDocument();
		changed = false;
		await user.click(screen.getByRole("button", { name: "Fetch now Feed" }));
		expect(await screen.findByText("No change since the last fetch.")).toBeInTheDocument();
		expect(bodies(calls, "sources/fetch")).toEqual([{ id: "S1" }, { id: "S1" }]);
		expect(document.body.textContent).not.toContain(UPLOAD_ID);
	});

	it("refuses to delete a source a schedule reads, naming the schedules", async () => {
		const { user } = setup({
			"schedules/list": () => page([schedule()]),
			"sources/delete": () => fail("SOURCE_IN_USE", "in use", 409, { scheduleIds: ["SC1"] }),
		});
		await pick(user, "Feed", "Delete");
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(
			await within(dialog).findByText("Schedules that read this source: Nightly."),
		).toBeVisible();
		expect(
			within(dialog).getByText(
				"A schedule reads this source. Delete or change the schedule first.",
			),
		).toBeVisible();
	});

	it("deletes a source", async () => {
		const { calls, user } = setup({ "sources/delete": () => ({ deleted: true }) });
		await pick(user, "Feed", "Delete");
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/delete")).toEqual([{ id: "S1" }]);
	});

	it("adds a credential in a dialog through a password input and never shows the value again (Review Focus 3)", async () => {
		const { calls, user } = setup({
			"credentials/set": () => ({ name: "feed-token", header: "Authorization" }),
		});
		await screen.findByText("Feed");
		// No form until it is asked for (Critique 9).
		expect(screen.queryByLabelText("Value")).toBeNull();
		const add = screen.getByRole("button", { name: "Add a credential" });
		await user.click(add);
		const dialog = await screen.findByRole("dialog", { name: "Add a credential" });
		const value = within(dialog).getByLabelText("Value");
		expect(value).toHaveAttribute("type", "password");
		expect(value).toHaveAttribute("autocomplete", "off");
		const save = within(dialog).getByRole("button", { name: "Save credential" });
		expect(save).toBeDisabled();
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "feed-token");
		await user.type(within(dialog).getByRole("textbox", { name: "Header" }), "Authorization");
		expect(save).toBeDisabled();
		await user.type(value, "Bearer k-123");
		await user.click(save);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "credentials/set")).toEqual([
			{ name: "feed-token", header: "Authorization", value: "Bearer k-123" },
		]);
		expect(await screen.findByText("Saved the credential feed-token.")).toBeInTheDocument();
		await waitFor(() => expect(add).toHaveFocus());
		expect(document.body.textContent).not.toContain("k-123");
		expect((document.body as HTMLElement).innerHTML).not.toContain("k-123");
	});

	it("refuses a credential name or header outside the pattern before sending it", async () => {
		const { calls, user } = setup({});
		await user.click(await screen.findByRole("button", { name: "Add a credential" }));
		const dialog = await screen.findByRole("dialog", { name: "Add a credential" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Feed Token");
		await user.type(within(dialog).getByRole("textbox", { name: "Header" }), "Authorization");
		await user.type(within(dialog).getByLabelText("Value"), "x");
		expect(within(dialog).getByRole("button", { name: "Save credential" })).toBeDisabled();
		await user.keyboard("{Enter}");
		expect(bodies(calls, "credentials/set")).toEqual([]);
	});

	it("deletes a credential after naming the sources that use it", async () => {
		const { calls, user } = setup({
			"sources/list": () => page([sourceRow({ credential: "feed-token" })]),
			"credentials/list": () => [
				{ name: "feed-token", header: "Authorization" },
				{ name: "spare", header: "X-Key" },
			],
			"credentials/delete": () => ({ deleted: true }),
		});
		await user.click(
			await screen.findByRole("button", { name: "Delete the credential feed-token" }),
		);
		let dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Sources that use it: Feed. Their fetches will fail until the credential is set again, and schedules that read them will pause.",
			),
		).toBeVisible();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "credentials/delete")).toEqual([{ name: "feed-token" }]);

		await user.click(screen.getByRole("button", { name: "Delete the credential spare" }));
		dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("No source uses it.")).toBeVisible();
	});

	it("says the schedules could not be checked when they cannot be read, and offers Try again", async () => {
		let failing = true;
		const { calls, user } = setup({
			"schedules/list": () => (failing ? fail("VALIDATION_ERROR", "bad", 400) : page([schedule()])),
			"sources/update": () => sourceRow(),
		});
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		// A name-only edit needs no schedules, so there is nothing to say.
		expect(within(dialog).queryByText(/Couldn't check/)).toBeNull();
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		expect(
			await within(dialog).findByText(
				"Couldn't check which schedules read this source: The request was not valid. Check your entries and try again.",
			),
		).toBeVisible();
		expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
		failing = false;
		await user.click(within(dialog).getByRole("button", { name: "Try again" }));
		expect(
			await within(dialog).findByText("These schedules read this source: Nightly."),
		).toBeVisible();
		expect(within(dialog).queryByText(/Couldn't check/)).toBeNull();
		expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
		expect(bodies(calls, "sources/update")).toEqual([]);
	});

	it("names the saved source, trimmed, when schedules failed to update", async () => {
		const { user } = setup({
			"schedules/list": () => page([schedule()]),
			"sources/update": () => sourceRow({ name: "Feed" }),
			"schedules/update": () => fail("SCHEDULE_BUSY", "busy", 409),
		});
		await pick(user, "Feed", "Edit");
		const dialog = await screen.findByRole("dialog");
		const name = within(dialog).getByRole("textbox", { name: "Name" });
		await user.clear(name);
		await user.type(name, "  Feed  ");
		const url = within(dialog).getByRole("textbox", { name: "Address" });
		await user.clear(url);
		await user.type(url, "https://feed.example.com/new.json");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(
			await within(dialog).findByText("Saved Feed, but some schedules could not be updated."),
		).toBeVisible();
	});

	it("replaces a credential in a dialog with its name and header filled in and the value focused", async () => {
		const { calls, user } = setup({
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
			"credentials/set": () => ({ name: "feed-token", header: "Authorization" }),
		});
		const replace = await screen.findByRole("button", {
			name: "Replace the credential feed-token",
		});
		await user.click(replace);
		const dialog = await screen.findByRole("dialog", {
			name: "Replace the credential feed-token",
		});
		await waitFor(() => expect(within(dialog).getByLabelText("Value")).toHaveFocus());
		expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("feed-token");
		expect(within(dialog).getByRole("textbox", { name: "Header" })).toHaveValue("Authorization");
		await user.keyboard("new-secret{Enter}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "credentials/set")).toEqual([
			{ name: "feed-token", header: "Authorization", value: "new-secret" },
		]);
		// Closed, focus is back on the button that opened it.
		await waitFor(() => expect(replace).toHaveFocus());
	});

	it("closes the credential dialog with Cancel, sending nothing, and opens it empty again", async () => {
		const { calls, user } = setup({});
		const add = await screen.findByRole("button", { name: "Add a credential" });
		await user.click(add);
		let dialog = await screen.findByRole("dialog", { name: "Add a credential" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "draft");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(add).toHaveFocus());
		await user.click(add);
		dialog = await screen.findByRole("dialog", { name: "Add a credential" });
		expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("");
		expect(bodies(calls, "credentials/set")).toEqual([]);
	});

	it("keeps the credential dialog open with the refusal in words, and clears the value", async () => {
		const { user } = setup({
			"credentials/set": () => fail("VALIDATION_ERROR", "bad", 400),
		});
		await user.click(await screen.findByRole("button", { name: "Add a credential" }));
		const dialog = await screen.findByRole("dialog", { name: "Add a credential" });
		await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "feed-token");
		await user.type(within(dialog).getByRole("textbox", { name: "Header" }), "Authorization");
		await user.type(within(dialog).getByLabelText("Value"), "Bearer k-123");
		await user.click(within(dialog).getByRole("button", { name: "Save credential" }));
		expect(
			await within(dialog).findByText(
				"The request was not valid. Check your entries and try again.",
			),
		).toBeVisible();
		expect(within(dialog).getByLabelText("Value")).toHaveValue("");
		expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("feed-token");
		expect(document.body.innerHTML).not.toContain("k-123");
	});

	it("names a source and a credential with one name apart", async () => {
		const { user } = setup({
			"sources/list": () => page([sourceRow({ name: "shared" })]),
			"credentials/list": () => [{ name: "shared", header: "X-Key" }],
		});
		expect(await screen.findByRole("button", { name: "Actions for shared" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Delete the credential shared" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Actions for shared" }));
		expect(await screen.findByRole("menuitem", { name: "Delete shared" })).toBeVisible();
	});

	it("keeps row actions short, names the row in each accessible name, and scrolls the table (Task 16)", async () => {
		const name = "127.0.0.1:4602/products.json";
		const { user } = setup({
			"sources/list": () => page([sourceRow({ name })]),
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
		});
		const cases: [string, string][] = [
			[`Fetch now ${name}`, "Fetch now"],
			["Replace the credential feed-token", "Replace"],
			["Delete the credential feed-token", "Delete"],
		];
		for (const [accessible, visible] of cases) {
			expect(await screen.findByRole("button", { name: accessible })).toHaveTextContent(
				new RegExp(`^${visible}$`),
			);
		}
		// Edit and Delete sit in the row's menu, Delete last in the danger colour.
		await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
		const items = await screen.findAllByRole("menuitem");
		expect(items.map((i) => [i.getAttribute("aria-label"), i.textContent])).toEqual([
			[`Edit ${name}`, "Edit"],
			[`Delete ${name}`, "Delete"],
		]);
		expect(items[1]).toHaveClass("text-kumo-danger");
		// A long name widens the table, never the page: it scrolls in its own box.
		const table = screen.getAllByRole("table")[0] as HTMLElement;
		expect(table.parentElement).toHaveClass("overflow-x-auto");
	});

	it("stacks the source rows when the tab is narrow", async () => {
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
		setup({});
		const row = (await screen.findByText("Feed")).closest("li") as HTMLElement;
		expect(row).not.toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
		expect(within(row).getByRole("button", { name: "Fetch now Feed" })).toBeVisible();
		expect(within(row).getByRole("button", { name: "Actions for Feed" })).toBeVisible();
	});

	it("lists credentials by name, header and use, with the value masked", async () => {
		setup({
			"sources/list": () => page([sourceRow({ credential: "feed-token" })]),
			"credentials/list": () => [
				{ name: "feed-token", header: "Authorization" },
				{ name: "spare", header: "X-Key" },
			],
		});
		const heading = await screen.findByRole("heading", { level: 2, name: "Credentials" });
		expect(heading).toBeVisible();
		expect(
			screen.getByText("Write-only. Values are stored on the site and never shown again."),
		).toBeVisible();
		const used = screen.getByText("Sent in the Authorization header · used by 1 source");
		expect(used).toBeVisible();
		expect(screen.getByText("Sent in the X-Key header · not used yet")).toBeVisible();
		expect(screen.getAllByText("Value hidden")).toHaveLength(2);
		expect(screen.getByRole("heading", { level: 2, name: "URL sources" })).toBeVisible();
	});

	it("shows both empty states", async () => {
		setup({ "sources/list": () => page([]) });
		expect(await screen.findByText("No URL sources yet")).toBeVisible();
		expect(await screen.findByText("No credentials yet")).toBeVisible();
		expect(screen.getByText("0 URL sources")).toBeVisible();
	});

	it("shows a failed list with Try again", async () => {
		let failing = true;
		const { user } = setup({
			"sources/list": () => (failing ? fail("VALIDATION_ERROR", "bad", 400) : page([sourceRow()])),
		});
		expect(await screen.findByText("Sources could not be loaded.")).toBeVisible();
		expect(
			screen.getByText(
				"The request was not valid. Check your entries and try again. Your imports are not affected.",
			),
		).toBeVisible();
		failing = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Feed")).toBeVisible();
	});
});
