import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
		expect(screen.getByText(/^Failed .*: The address answered with an error\.$/)).toBeVisible();
		expect(screen.getByText("Never fetched")).toBeVisible();
		for (const secret of ["s3cret", "u:p", UPLOAD_ID, "HTTP 500 from"]) {
			expect(document.body.textContent).not.toContain(secret);
		}
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(screen.getByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Delete Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Delete Feed" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(bodies(calls, "sources/delete")).toEqual([{ id: "S1" }]);
	});

	it("adds a credential through a password input and never shows the value again (Review Focus 3)", async () => {
		const { calls, user } = setup({
			"credentials/set": () => ({ name: "feed-token", header: "Authorization" }),
		});
		await screen.findByText("Feed");
		const value = screen.getByLabelText("Value");
		expect(value).toHaveAttribute("type", "password");
		expect(value).toHaveAttribute("autocomplete", "off");
		await user.type(screen.getByRole("textbox", { name: "Name", hidden: false }), "feed-token");
		await user.type(screen.getByRole("textbox", { name: "Header" }), "Authorization");
		await user.type(value, "Bearer k-123");
		await user.click(screen.getByRole("button", { name: "Save credential" }));
		await waitFor(() => expect(bodies(calls, "credentials/set")).toHaveLength(1));
		expect(bodies(calls, "credentials/set")).toEqual([
			{ name: "feed-token", header: "Authorization", value: "Bearer k-123" },
		]);
		await waitFor(() => expect(screen.getByLabelText("Value")).toHaveValue(""));
		expect(document.body.textContent).not.toContain("k-123");
		expect((document.body as HTMLElement).innerHTML).not.toContain("k-123");
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
				"Sources that use it: Feed. Their fetches will fail until the credential is set again.",
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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
		await user.click(await screen.findByRole("button", { name: "Edit Feed" }));
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

	it("moves focus to the Value input when Replace is pressed", async () => {
		const { user } = setup({
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
		});
		await user.click(
			await screen.findByRole("button", { name: "Replace the credential feed-token" }),
		);
		expect(screen.getByLabelText("Value")).toHaveFocus();
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("feed-token");
	});

	it("names a source and a credential with one name apart", async () => {
		setup({
			"sources/list": () => page([sourceRow({ name: "shared" })]),
			"credentials/list": () => [{ name: "shared", header: "X-Key" }],
		});
		expect(await screen.findByRole("button", { name: "Delete shared" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Delete the credential shared" })).toBeVisible();
	});

	it("lists credentials by name and header only", async () => {
		setup({ "credentials/list": () => [{ name: "feed-token", header: "Authorization" }] });
		const heading = await screen.findByRole("heading", { level: 3, name: "Credentials" });
		expect(heading).toBeVisible();
		expect(await screen.findByText("Authorization")).toBeVisible();
	});

	it("shows both empty states", async () => {
		setup({ "sources/list": () => page([]) });
		expect(await screen.findByText("No URL sources yet.")).toBeVisible();
		expect(await screen.findByText("No credentials yet.")).toBeVisible();
	});
});
