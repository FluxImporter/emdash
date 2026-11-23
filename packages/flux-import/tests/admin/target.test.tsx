import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import type { WizardState } from "../../src/admin/wizard/state.js";
import { TargetStep } from "../../src/admin/wizard/target/TargetStep.js";
import { MANIFEST, POSTS } from "./fixtures.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";

type Manifest = { collections: Record<string, unknown> } & Record<string, unknown>;
const manifest = MANIFEST as Manifest;

/** `sites/dev`'s manifest with a hidden collection added. */
const WITH_HIDDEN: Manifest = {
	...manifest,
	collections: {
		...manifest.collections,
		archive: { label: "Archive", labelSingular: "Archive", supports: [], hidden: true, fields: {} },
	},
};

/** A single-locale site: EmDash leaves `i18n` out of the manifest (Fact V1). */
const ONE_LOCALE: Manifest = (() => {
	const { i18n: _, ...rest } = manifest;
	return rest as Manifest;
})();

const PAGES: unknown = {
	item: {
		slug: "pages",
		label: "Pages",
		fields: (POSTS as { item: { fields: unknown[] } }).item.fields,
	},
};

/** Renders the wizard's state, so a test can read what the step dispatched. */
function StateProbe() {
	const { state } = useWizard();
	return (
		<output data-testid="state">
			{JSON.stringify({ step: state.step, target: state.target, rows: state.rows })}
		</output>
	);
}

function readState(): Pick<WizardState, "step" | "target" | "rows"> {
	return JSON.parse(screen.getByTestId("state").textContent ?? "{}") as Pick<
		WizardState,
		"step" | "target" | "rows"
	>;
}

function renderTarget(initial: Partial<WizardState> = {}) {
	return renderAdmin(
		<WizardProvider initial={{ step: "target", ...initial }}>
			<TargetStep />
			<StateProbe />
		</WizardProvider>,
	);
}

/** Opens the select named `name` and picks `option`. */
async function choose(user: UserEvent, name: string, option: string) {
	await user.click(screen.getByRole("combobox", { name }));
	const listbox = await screen.findByRole("listbox");
	await user.click(within(listbox).getByRole("option", { name: option }));
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** The option names the select named `name` offers; closes it again. */
async function optionsOf(user: UserEvent, name: string): Promise<string[]> {
	await user.click(screen.getByRole("combobox", { name }));
	const listbox = await screen.findByRole("listbox");
	const names = within(listbox)
		.getAllByRole("option")
		.map((o) => o.textContent ?? "");
	await user.keyboard("{Escape}");
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	return names;
}

const TRANSLATES = "These records translate entries in";

/** A stale saved locale's sentence shows under its select and as Next's reason. */
function expectStale(sentence: string) {
	const shown = screen.getAllByText(sentence);
	expect(shown).toHaveLength(2);
	for (const el of shown) expect(el).toBeVisible();
	expect(screen.getByRole("button", { name: "Next" })).toHaveAccessibleDescription(sentence);
}

describe("TargetStep", () => {
	it("lists the manifest's collections and preselects the default locale", async () => {
		const { calls } = mockRoutes({
			"GET manifest": () => WITH_HIDDEN,
			"GET collection:posts": () => POSTS,
		});
		const { user } = renderTarget();
		const collection = await screen.findByRole("combobox", { name: "Collection" });
		expect(screen.getByRole("combobox", { name: "Locale" })).toHaveTextContent("en");
		expect(await optionsOf(user, "Collection")).toEqual(["Pages", "Posts", "Archive (hidden)"]);

		// Next waits for a collection.
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
		expect(screen.getByText("Choose a collection to import into")).toBeVisible();

		await choose(user, "Collection", "Posts");
		expect(collection).toHaveTextContent("Posts");
		// The fields are prefetched for Map.
		await waitFor(() =>
			expect(calls.map((c) => c.path)).toContain(
				"/_emdash/api/schema/collections/posts?includeFields=true",
			),
		);
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState()).toMatchObject({
			step: "map",
			target: { collection: "posts", locale: "en", translationLocale: null },
		});
	});

	it("shows one locale as text on a single-locale site", async () => {
		mockRoutes({ "GET manifest": () => ONE_LOCALE, "GET collection:pages": () => PAGES });
		const { user } = renderTarget();
		await screen.findByRole("combobox", { name: "Collection" });
		expect(screen.getByText("Locale: en")).toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Locale" })).toBeNull();
		expect(screen.queryByRole("checkbox", { name: TRANSLATES })).toBeNull();

		await choose(user, "Collection", "Pages");
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "pages",
			locale: "en",
			translationLocale: null,
		});
	});

	it("offers 'translate entries in' only for a non-default locale", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget();
		await screen.findByRole("combobox", { name: "Collection" });
		await choose(user, "Collection", "Posts");
		expect(screen.queryByRole("checkbox", { name: TRANSLATES })).toBeNull();

		await choose(user, "Locale", "fr");
		const box = screen.getByRole("checkbox", { name: TRANSLATES });
		expect(box).not.toBeChecked();
		// Its locale is offered only once the box is ticked.
		expect(screen.queryByRole("combobox", { name: "Locale of the original entries" })).toBeNull();

		await user.click(box);
		expect(box).toBeChecked();
		const original = screen.getByRole("combobox", { name: "Locale of the original entries" });
		// Defaults to the site's default locale, and never offers the chosen one (preflight F8).
		expect(original).toHaveTextContent("en");
		expect(await optionsOf(user, "Locale of the original entries")).toEqual(["en", "de"]);
		expect(screen.getByText(/Translation of/)).toBeVisible();

		await choose(user, "Locale of the original entries", "de");
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "fr",
			translationLocale: "de",
		});
	});

	it("drops the translation locale when the box is unticked or the locale is the default again", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "fr", translationLocale: "de" },
		});
		// A revisited step shows the chosen target.
		expect(await screen.findByRole("combobox", { name: "Collection" })).toHaveTextContent("Posts");
		expect(screen.getByRole("combobox", { name: "Locale" })).toHaveTextContent("fr");
		const box = screen.getByRole("checkbox", { name: TRANSLATES });
		expect(box).toBeChecked();
		expect(
			screen.getByRole("combobox", { name: "Locale of the original entries" }),
		).toHaveTextContent("de");

		// "de" cannot translate itself: the original's locale falls back to the default.
		await choose(user, "Locale", "de");
		expect(
			screen.getByRole("combobox", { name: "Locale of the original entries" }),
		).toHaveTextContent("en");
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "de",
			translationLocale: "en",
		});
	});

	it("sends no translation locale for the default locale or an unticked box", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "fr", translationLocale: "de" },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		await user.click(screen.getByRole("checkbox", { name: TRANSLATES }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "fr",
			translationLocale: null,
		});
	});

	it("drops the translation locale when the default locale is chosen again", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "fr", translationLocale: "de" },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		await choose(user, "Locale", "en");
		expect(screen.queryByRole("checkbox", { name: TRANSLATES })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "en",
			translationLocale: null,
		});
	});

	it("says a new collection clears the mapping", async () => {
		mockRoutes({
			"GET manifest": () => MANIFEST,
			"GET collection:posts": () => POSTS,
			"GET collection:pages": () => PAGES,
		});
		const { user } = renderTarget({
			target: { collection: "posts", locale: "en", translationLocale: null },
			rows: { key: { from: "id" } },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		const notice = "Changing the collection clears the mapping.";
		expect(screen.queryByText(notice)).toBeNull();
		await choose(user, "Collection", "Pages");
		expect(screen.getByText(notice)).toBeVisible();
		await choose(user, "Collection", "Posts");
		expect(screen.queryByText(notice)).toBeNull();
	});

	it("says nothing about the mapping when there is none to clear", async () => {
		mockRoutes({
			"GET manifest": () => MANIFEST,
			"GET collection:posts": () => POSTS,
			"GET collection:pages": () => PAGES,
		});
		const { user } = renderTarget({
			target: { collection: "posts", locale: "en", translationLocale: null },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		await choose(user, "Collection", "Pages");
		expect(screen.queryByText("Changing the collection clears the mapping.")).toBeNull();
	});

	it("blocks Next on a stale saved locale until a site locale is chosen", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "es", translationLocale: null },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		const stale = "es is not one of this site's locales. Choose another.";
		expectStale(stale);
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

		await choose(user, "Locale", "fr");
		expect(screen.queryByText(stale)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "fr",
			translationLocale: null,
		});
	});

	it("blocks Next on a stale saved translation locale until a site locale is chosen", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "fr", translationLocale: "es" },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		const stale = "es is not one of this site's locales. Choose another.";
		expectStale(stale);
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

		await choose(user, "Locale of the original entries", "de");
		expect(screen.queryByText(stale)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "fr",
			translationLocale: "de",
		});
	});

	it("offers a select for a stale saved locale on a single-locale site", async () => {
		mockRoutes({ "GET manifest": () => ONE_LOCALE, "GET collection:posts": () => POSTS });
		const { user } = renderTarget({
			target: { collection: "posts", locale: "fr", translationLocale: null },
		});
		await screen.findByRole("combobox", { name: "Collection" });
		expectStale("fr is not one of this site's locales. Choose another.");
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

		await choose(user, "Locale", "en");
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(readState().target).toEqual({
			collection: "posts",
			locale: "en",
			translationLocale: null,
		});
	});

	it("shows the empty state when the site has no collections", async () => {
		mockRoutes({ "GET manifest": () => ({ ...manifest, collections: {} }) });
		renderTarget();
		expect(await screen.findByText("No collections")).toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Collection" })).toBeNull();
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
		// Nothing can be chosen, so the footer does not ask for it.
		expect(screen.queryByText("Choose a collection to import into")).toBeNull();
	});

	it("shows a schema read error as a sentence with Try again", async () => {
		let answer: () => unknown = () => fail("INTERNAL_ERROR", "Database is locked", 500);
		const { calls } = mockRoutes({
			"GET manifest": () => MANIFEST,
			"GET collection:posts": () => answer(),
		});
		const { user, queryClient } = renderTarget();
		// The schema read retries a 5xx once (queries.ts); without its delay here.
		queryClient.setDefaultOptions({ queries: { retry: false, retryDelay: 0 } });
		await screen.findByRole("combobox", { name: "Collection" });
		await choose(user, "Collection", "Posts");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Something went wrong on the server. Try again.");
		expect(alert).not.toHaveTextContent("Database is locked");
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

		answer = () => POSTS;
		const before = calls.length;
		await user.click(within(alert).getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(calls.length).toBe(before + 1);
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
	});

	it("shows the route's own message for a code the wizard does not know", async () => {
		mockRoutes({
			"GET manifest": () => MANIFEST,
			"GET collection:posts": () => fail("SCHEMA_BROKEN", "The posts table is missing", 404),
		});
		const { user } = renderTarget();
		await screen.findByRole("combobox", { name: "Collection" });
		await choose(user, "Collection", "Posts");
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Something went wrong.");
		expect(alert).toHaveTextContent("The posts table is missing");
	});

	it("shows a manifest read error as a sentence with Try again", async () => {
		let answer: () => unknown = () => fail("FORBIDDEN", "Insufficient permissions", 403);
		mockRoutes({ "GET manifest": () => answer() });
		const { user } = renderTarget();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Only administrators can import.");
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

		answer = () => MANIFEST;
		await user.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("combobox", { name: "Collection" })).toBeVisible();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
