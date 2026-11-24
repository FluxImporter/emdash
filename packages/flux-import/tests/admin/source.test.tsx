import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PASTE_MAX_BYTES, SAMPLE_MAX } from "../../src/admin/limits.js";
import { useWizard, WizardProvider } from "../../src/admin/wizard/context.js";
import { formatOf, formatOfUrl } from "../../src/admin/wizard/source/SourceSettings.js";
import { SourceStep } from "../../src/admin/wizard/source/SourceStep.js";
import { nameFromUrl } from "../../src/admin/wizard/source/UrlTab.js";
import { templateSchema } from "../../src/engine/template.js";
import { sampleCsv, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes, type RouteHandler, renderAdmin } from "./harness.js";

/** A second, well-formed upload ID (never shown). */
const FETCHED_ID = `01JZ0000000000000000000001${"1".repeat(32)}`;

/** The parts of the wizard's state these tests read, as text. */
function StateView() {
	const { state } = useWizard();
	return (
		<output data-testid="state">
			{JSON.stringify({
				step: state.step,
				source: state.source,
				sourceBlock: state.sourceBlock,
				keys: state.columns?.map((c) => c.key) ?? null,
				target: state.target,
				rows: Object.keys(state.rows),
				base: state.base === null ? null : { id: state.base.id, revision: state.base.revision },
			})}
		</output>
	);
}

function readState(): {
	step: string;
	source: { kind: string; uploadId: string; label: string } | null;
	sourceBlock: Record<string, unknown>;
	keys: string[] | null;
	target: { collection: string; locale: string } | null;
	rows: string[];
	base: { id: string; revision: number } | null;
} {
	return JSON.parse(screen.getByTestId("state").textContent ?? "null");
}

function renderSource() {
	return renderAdmin(
		<WizardProvider>
			<SourceStep />
			<StateView />
		</WizardProvider>,
	);
}

const CSV_SAMPLE = sampleCsv(
	["id", "title"],
	[
		["1", "First"],
		["2", "Second"],
	],
);

/** The routes every test answers, plus `extra`. */
function routes(extra: Record<string, RouteHandler>) {
	return mockRoutes({
		"templates/list": () => ({ items: [], hasMore: false }),
		upload: () => ({ uploadId: UPLOAD_ID, bytes: 20 }),
		"sources/sample": () => CSV_SAMPLE,
		...extra,
	});
}

const fileInput = () => screen.getByLabelText<HTMLInputElement>("Choose a file");

/** Chooses `name` in the Upload tab. */
function chooseFile(name: string, text = "id,title\n1,First\n") {
	const file = new File([text], name);
	fireEvent.change(fileInput(), { target: { files: [file] } });
	return file;
}

const next = () => screen.getByRole("button", { name: "Next" });

/** Opens the Upload tab; returns its file input. */
async function openUpload(user: { click(e: Element): Promise<void> }) {
	await user.click(screen.getByRole("tab", { name: "Upload file" }));
	return fileInput();
}

function chooseFileIn(input: HTMLInputElement) {
	fireEvent.change(input, { target: { files: [new File(["id,title\n1,a\n"], "posts.csv")] } });
}

/** A promise and the function that settles it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const SAVED_TEMPLATE = {
	id: "01JZ000000000000000000TPL1",
	name: "Posts from CSV",
	template: templateSchema.parse({
		version: 1,
		collection: "posts",
		locale: "en",
		key: { from: "id" },
		fields: { title: { from: "title", type: "text" } },
	}),
	revision: 3,
	collection: "posts",
	locale: "en",
	format: "csv",
	createdAt: "2026-11-23T12:00:00.000Z",
	updatedAt: "2026-11-23T12:00:00.000Z",
	createdBy: "u1",
	updatedBy: "u1",
};
const { template: _, ...SUMMARY } = SAVED_TEMPLATE;

const SOURCE_ROW = {
	id: "01JZ00000000000000000SRC01",
	name: "example.com/feeds/products.json",
	url: "https://example.com/feeds/products.json",
	createdAt: "2026-11-23T12:00:00.000Z",
	updatedAt: "2026-11-23T12:00:00.000Z",
};

describe("the Source step", () => {
	it("uploads a file with its name, the CSRF header and progress, then samples it", async () => {
		const reply = deferred<unknown>();
		const { calls } = routes({ upload: () => reply.promise });
		renderSource();
		const file = chooseFile("posts.csv");
		// The harness fires progress at half and at full size before it answers.
		const meter = await screen.findByRole("meter");
		await waitFor(() => expect(meter).toHaveAttribute("aria-valuenow", "100"));
		reply.resolve({ uploadId: UPLOAD_ID, bytes: file.size });
		await waitFor(() => expect(readState().keys).toEqual(["id", "title"]));
		expect(screen.queryByRole("meter")).toBeNull();
		expect(calls.filter((c) => c.route !== "templates/list")).toEqual([
			{
				method: "POST",
				path: "/_emdash/api/flux-import/uploads?filename=posts.csv",
				route: "upload",
				body: file,
			},
			expect.objectContaining({
				route: "sources/sample",
				body: { uploadId: UPLOAD_ID, n: SAMPLE_MAX, source: { format: "csv" } },
			}),
		]);
		expect(readState().source).toEqual({ kind: "upload", uploadId: UPLOAD_ID, label: "posts.csv" });
		// The sample shows each key and its values.
		const preview = screen.getByRole("table", { name: "Sample" });
		expect(within(preview).getByText("title")).toBeInTheDocument();
		expect(within(preview).getByText("Second")).toBeInTheDocument();
		expect(next()).toBeEnabled();
		await screen.findByText(/no saved templates/i);
	});

	it("detects the format from the extension: .ndjson and .jsonl read as JSON Lines", async () => {
		const { calls } = routes({ "sources/sample": () => ({ records: [{ a: 1 }], paths: ["a"] }) });
		renderSource();
		chooseFile("feed.ndjson", '{"a":1}\n');
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "jsonl" }));
		expect(calls.find((c) => c.route === "sources/sample")?.body).toMatchObject({
			source: { format: "jsonl" },
		});
		expect(screen.getByRole("combobox", { name: "Format" })).toHaveTextContent("JSON Lines");
	});

	it("refuses a .txt file before sending it", async () => {
		const { calls } = routes({});
		renderSource();
		chooseFile("notes.txt");
		expect(
			await screen.findByText(
				"This kind of file cannot be imported. Use CSV, JSON, JSON Lines, XML or XLSX.",
			),
		).toBeVisible();
		expect(calls.filter((c) => c.route !== "templates/list")).toEqual([]);
		expect(fileInput()).toHaveAttribute("accept", ".csv,.json,.jsonl,.ndjson,.xml,.xlsx");
		expect(next()).toBeDisabled();
	});

	it("keeps the Credential select's name, and disables it, while the credentials load", async () => {
		const list = deferred<unknown>();
		routes({ "credentials/list": () => list.promise });
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		// Kumo's Select shows an unlabelled skeleton in place of the value, so, unlike its Button,
		// it adds no "Loading" to the name: the label alone names it.
		const select = screen.getByRole("combobox", { name: "Credential" });
		expect(select).toBeDisabled();
		list.resolve([]);
		await waitFor(() => expect(select).toBeEnabled());
		expect(screen.getByRole("combobox", { name: "Credential" })).toBe(select);
	});

	it("creates and fetches a URL source, then samples the fetched upload", async () => {
		const { calls } = routes({
			"credentials/list": () => [{ name: "feed-token", header: "Authorization" }],
			"sources/create": () => SOURCE_ROW,
			"sources/fetch": () => ({ changed: true, uploadId: FETCHED_ID, bytes: 10, sha256: "x" }),
			"sources/sample": () => ({ records: [{ sku: "A" }], paths: ["sku"] }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		await user.type(
			screen.getByRole("textbox", { name: "Address" }),
			"https://example.com/feeds/products.json",
		);
		// The name is derived from the host and path, and stays editable.
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
			"example.com/feeds/products.json",
		);
		await user.click(screen.getByRole("combobox", { name: "Credential" }));
		await user.click(await screen.findByRole("option", { name: "feed-token" }));
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		await waitFor(() => expect(readState().keys).toEqual(["sku"]));
		expect(calls.filter((c) => c.route.startsWith("sources/")).map((c) => c.body)).toEqual([
			{
				name: "example.com/feeds/products.json",
				url: "https://example.com/feeds/products.json",
				credential: "feed-token",
			},
			{ id: SOURCE_ROW.id },
			{ uploadId: FETCHED_ID, n: SAMPLE_MAX, source: { format: "json" } },
		]);
		expect(readState().source).toEqual({
			kind: "url",
			uploadId: FETCHED_ID,
			label: "example.com/feeds/products.json",
		});
	});

	it("offers the saved source when the name is taken (CONFLICT 409)", async () => {
		const { calls } = routes({
			"credentials/list": () => [],
			"sources/create": () =>
				fail("CONFLICT", 'A source named "example.com/feeds/products.json" already exists', 409),
			"sources/list": () => ({ items: [SOURCE_ROW], hasMore: false }),
			"sources/fetch": () => ({ changed: false, uploadId: FETCHED_ID, bytes: 10, sha256: "x" }),
			"sources/sample": () => ({ records: [{ sku: "A" }], paths: ["sku"] }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		await user.type(
			screen.getByRole("textbox", { name: "Address" }),
			"https://example.com/feeds/products.json",
		);
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		expect(await screen.findByText(/already named .* and fetches this address/i)).toBeVisible();
		// Same credential (none on either side): nothing more to say.
		expect(screen.queryByText(/fetches with/i)).toBeNull();
		await user.click(await screen.findByRole("button", { name: "Use the saved source" }));
		await waitFor(() => expect(readState().keys).toEqual(["sku"]));
		expect(calls.find((c) => c.route === "sources/fetch")?.body).toEqual({ id: SOURCE_ROW.id });
		expect(readState().source?.kind).toBe("saved");
	});

	/** Types the address, picks `chosen` (or none), fetches; returns the offer's text and `user`. */
	async function clash(saved: { credential?: string }, chosen: string | null) {
		routes({
			"credentials/list": () => [
				{ name: "feed-token", header: "Authorization" },
				{ name: "other-token", header: "X-Key" },
			],
			"sources/create": () => fail("CONFLICT", "A source named … already exists", 409),
			"sources/list": () => ({ items: [{ ...SOURCE_ROW, ...saved }], hasMore: false }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		await user.type(
			screen.getByRole("textbox", { name: "Address" }),
			"https://example.com/feeds/products.json",
		);
		if (chosen !== null) {
			await user.click(screen.getByRole("combobox", { name: "Credential" }));
			await user.click(await screen.findByRole("option", { name: chosen }));
		}
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		const offer = await screen.findByText(/already named .* and fetches this address/i);
		expect(screen.getByRole("button", { name: "Use the saved source" })).toBeEnabled();
		return { text: offer.closest("div")?.textContent ?? "", user };
	}

	it("says which credential the saved source uses when it differs from the one chosen", async () => {
		const { text } = await clash({ credential: "other-token" }, "feed-token");
		expect(text).toContain("It fetches with the credential other-token, not the one chosen here.");
	});

	it("says the saved source uses no credential when one was chosen", async () => {
		const { text } = await clash({}, "feed-token");
		expect(text).toContain("It fetches with no credential, not the one chosen here.");
	});

	it("says which credential the saved source uses when none was chosen", async () => {
		const { text, user } = await clash({ credential: "other-token" }, null);
		expect(text).toContain("It fetches with the credential other-token, not the one chosen here.");
		// Choosing a credential withdraws the offer, which was made for the form as it was.
		await user.click(screen.getByRole("combobox", { name: "Credential" }));
		await user.click(await screen.findByRole("option", { name: "other-token" }));
		expect(screen.queryByRole("button", { name: "Use the saved source" })).toBeNull();
	});

	it("adds nothing about credentials when the saved source uses the one chosen", async () => {
		const { text } = await clash({ credential: "feed-token" }, "feed-token");
		expect(text).not.toMatch(/fetches with/);
	});

	it("does not offer a taken name's saved source when it fetches another address", async () => {
		const { calls } = routes({
			"credentials/list": () => [],
			"sources/create": () => fail("CONFLICT", "A source named … already exists", 409),
			"sources/list": () => ({
				items: [{ ...SOURCE_ROW, url: "https://example.com/feeds/products.json?page=1" }],
				hasMore: false,
			}),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		const address = screen.getByRole("textbox", { name: "Address" });
		// The derived name drops the query, so both addresses get the same name.
		await user.type(address, "https://example.com/feeds/products.json?page=2");
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		const note = await screen.findByText(/fetches a different address/i);
		expect(note).toHaveTextContent("example.com/feeds/products.json");
		expect(note).not.toHaveTextContent("page=1");
		expect(note).toHaveTextContent(/choose another name/i);
		expect(screen.queryByRole("button", { name: "Use the saved source" })).toBeNull();
		expect(calls.some((c) => c.route === "sources/fetch")).toBe(false);
		// Editing the name withdraws the note.
		await user.type(screen.getByRole("textbox", { name: "Name" }), " 2");
		expect(screen.queryByText(/fetches a different address/i)).toBeNull();
	});

	it("shows a Loader, not a stale answer, while the sources list refetches on a clash", async () => {
		const list = deferred<unknown>();
		let reads = 0;
		routes({
			"credentials/list": () => [],
			"sources/create": () => fail("CONFLICT", "A source named … already exists", 409),
			// The first read (the Saved source tab) predates the source with this name.
			"sources/list": () => (++reads === 1 ? { items: [], hasMore: false } : list.promise),
			"sources/fetch": () => ({ changed: false, uploadId: FETCHED_ID, bytes: 10, sha256: "x" }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Saved source" }));
		expect(await screen.findByText("No saved sources")).toBeVisible();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		await user.type(
			screen.getByRole("textbox", { name: "Address" }),
			"https://example.com/feeds/products.json",
		);
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		expect(await screen.findByRole("status", { name: "Loading saved sources" })).toBeVisible();
		expect(screen.queryByText(/can no longer be found/i)).toBeNull();
		list.resolve({ items: [SOURCE_ROW], hasMore: false });
		expect(await screen.findByRole("button", { name: "Use the saved source" })).toBeEnabled();
		expect(screen.queryByText(/can no longer be found/i)).toBeNull();
	});

	it("says so when the taken name's saved source cannot be found", async () => {
		routes({
			"credentials/list": () => [],
			"sources/create": () => fail("CONFLICT", "A source named … already exists", 409),
			"sources/list": () => ({ items: [], hasMore: false }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		const address = screen.getByRole("textbox", { name: "Address" });
		await user.type(address, "https://example.com/feeds/products.json");
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		expect(await screen.findByText(/can no longer be found/i)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Use the saved source" })).toBeNull();
		// Editing the address withdraws the note.
		await user.type(address, "/x");
		expect(screen.queryByText(/can no longer be found/i)).toBeNull();
	});

	it("says CSV was assumed when a URL names no format", async () => {
		routes({
			"credentials/list": () => [],
			"sources/create": () => ({ ...SOURCE_ROW, url: "https://example.com/api/products" }),
			"sources/fetch": () => ({ changed: true, uploadId: FETCHED_ID, bytes: 10, sha256: "x" }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		await user.type(
			screen.getByRole("textbox", { name: "Address" }),
			"https://example.com/api/products",
		);
		await user.click(screen.getByRole("button", { name: "Fetch" }));
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "csv" }));
		const format = screen.getByRole("combobox", { name: "Format" });
		expect(format).toHaveAccessibleDescription(/CSV was assumed/);
		await user.click(format);
		await user.click(await screen.findByRole("option", { name: "JSON" }));
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "json" }));
		expect(screen.getByRole("combobox", { name: "Format" })).not.toHaveAccessibleDescription(
			/CSV was assumed/,
		);
	});

	it("does not say CSV was assumed for a file with an extension", async () => {
		routes({});
		renderSource();
		chooseFile("posts.csv");
		await waitFor(() => expect(next()).toBeEnabled());
		expect(screen.getByRole("combobox", { name: "Format" })).not.toHaveAccessibleDescription(
			/CSV was assumed/,
		);
	});

	it("shows TOO_LARGE from the upload as its sentence", async () => {
		routes({ upload: () => fail("TOO_LARGE", "Upload exceeds 50 MB", 413) });
		renderSource();
		chooseFile("huge.csv");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The file or text is larger than the site accepts.",
		);
		expect(next()).toBeDisabled();
	});

	it("puts the active tab's content in a labelled tab panel", async () => {
		routes({ "credentials/list": () => [] });
		const { user } = renderSource();
		const panel = screen.getByRole("tabpanel", { name: "Upload file" });
		expect(within(panel).getByLabelText("Choose a file")).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		expect(screen.getByRole("tabpanel", { name: "From URL" })).toBeInTheDocument();
	});

	it("does not switch tabs while an upload runs, so its progress stays visible", async () => {
		const reply = deferred<unknown>();
		routes({ upload: () => reply.promise });
		const { user } = renderSource();
		chooseFile("posts.csv");
		expect(await screen.findByRole("meter")).toBeInTheDocument();
		const paste = screen.getByRole("tab", { name: "Paste" });
		expect(paste).toBeDisabled();
		await user.click(paste);
		expect(screen.getByRole("tabpanel", { name: "Upload file" })).toBeInTheDocument();
		expect(screen.getByRole("meter")).toBeInTheDocument();
		reply.resolve({ uploadId: UPLOAD_ID, bytes: 20 });
		await waitFor(() => expect(next()).toBeEnabled());
		expect(screen.getByRole("tab", { name: "Paste" })).toBeEnabled();
	});

	it("hides the paste counter while there is no text", async () => {
		routes({});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Paste" }));
		expect(screen.queryByText(/KiB of/)).toBeNull();
		fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "a" } });
		expect(screen.getByText("1 KiB of 1,024 KiB")).toBeInTheDocument();
	});

	it("does not offer XLSX for Paste and disables Next past 1 MiB of UTF-8", async () => {
		const { calls } = routes({
			"sources/paste": () => ({ uploadId: FETCHED_ID, bytes: 9 }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Paste" }));
		await user.click(screen.getByRole("combobox", { name: "Format" }));
		const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
		expect(options).toEqual(["CSV", "JSON", "JSON Lines", "XML"]);
		await user.keyboard("{Escape}");

		// A sampled source does not let Next past text that is too large to paste.
		chooseFileIn(await openUpload(user));
		await waitFor(() => expect(next()).toBeEnabled());
		await user.click(screen.getByRole("tab", { name: "Paste" }));
		const area = screen.getByRole("textbox", { name: "Text" });
		fireEvent.change(area, { target: { value: "a" } });
		expect(area).toHaveAccessibleDescription("1 KiB of 1,024 KiB");
		// Under the limit as text, over it once JSON escapes each newline (preflight F18).
		const text = "\n".repeat(PASTE_MAX_BYTES / 2 + 1);
		fireEvent.change(area, { target: { value: text } });
		expect(next()).toBeDisabled();
		expect(screen.getAllByText(/larger than 1 MiB/i).length).toBeGreaterThan(0);
		expect(screen.getByRole("button", { name: "Use this text" })).toBeDisabled();
		// Exactly the limit: the body \`{"format":"csv","text":"…"}\` has 26 bytes besides the text.
		fireEvent.change(area, { target: { value: "a".repeat(PASTE_MAX_BYTES - 26) } });
		expect(screen.getByRole("button", { name: "Use this text" })).toBeEnabled();
		expect(screen.queryByText(/larger than 1 MiB/i)).toBeNull();
		fireEvent.change(area, { target: { value: "a".repeat(PASTE_MAX_BYTES - 25) } });
		expect(screen.getByRole("button", { name: "Use this text" })).toBeDisabled();

		fireEvent.change(area, { target: { value: "id,title\n1,First" } });
		await user.click(screen.getByRole("button", { name: "Use this text" }));
		await waitFor(() => expect(readState().keys).toEqual(["id", "title"]));
		expect(calls.find((c) => c.route === "sources/paste")?.body).toEqual({
			format: "csv",
			text: "id,title\n1,First",
		});
		expect(readState().source).toMatchObject({ kind: "paste", label: "Pasted text" });
		expect(next()).toBeEnabled();
	});

	it("maps a 413 from sources/paste to the too-large sentence (preflight F18)", async () => {
		routes({
			"sources/paste": () => fail("INVALID_PLUGIN_REQUEST", "Request body too large", 413),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Paste" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "a,b" } });
		await user.click(screen.getByRole("button", { name: "Use this text" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 1 MiB/i);
	});

	it("shows sheet and header row for XLSX, records path for JSON and XML", async () => {
		routes({});
		const { user } = renderSource();
		chooseFile("posts.csv");
		await waitFor(() => expect(readState().keys).not.toBeNull());
		expect(screen.queryByRole("textbox", { name: "Records path" })).toBeNull();
		expect(screen.getByRole("textbox", { name: "Row filter" })).toBeInTheDocument();

		const pick = async (label: string) => {
			await user.click(screen.getByRole("combobox", { name: "Format" }));
			await user.click(await screen.findByRole("option", { name: label }));
		};
		await pick("JSON");
		expect(screen.getByRole("textbox", { name: "Records path" })).toHaveAccessibleDescription(
			/dot-separated keys, e\.g\. data\.products/,
		);
		expect(screen.queryByRole("textbox", { name: "Sheet" })).toBeNull();
		await pick("XML");
		expect(screen.getByRole("textbox", { name: "Records path" })).toHaveAccessibleDescription(
			/element names from the root, e\.g\. feed\/item/,
		);
		await pick("XLSX");
		expect(screen.queryByRole("textbox", { name: "Records path" })).toBeNull();
		expect(screen.getByRole("textbox", { name: "Sheet" })).toBeInTheDocument();
		expect(screen.getByRole("spinbutton", { name: "Header row" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Row filter" })).toBeInTheDocument();
	});

	it("re-samples when the records path changes", async () => {
		const { calls } = routes({
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "data.items"
					? { records: [{ sku: "A", price: 2 }], paths: ["price", "sku"] }
					: { records: [{ data: { items: [] } }], paths: ["data.items"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", '{"data":{"items":[]}}');
		await waitFor(() => expect(readState().keys).toEqual(["data.items"]));
		await user.type(screen.getByRole("textbox", { name: "Records path" }), "data.items{Enter}");
		await waitFor(() => expect(readState().keys).toEqual(["price", "sku"]));
		expect(readState().sourceBlock).toEqual({ format: "json", records: "data.items" });
		expect(
			calls
				.filter((c) => c.route === "sources/sample")
				.map((c) => (c.body as { source: unknown }).source),
		).toEqual([{ format: "json" }, { format: "json", records: "data.items" }]);
	});

	it("re-samples when the format changes, and drops settings the new format refuses", async () => {
		const { calls } = routes({});
		const { user } = renderSource();
		chooseFile("feed.json", "[]");
		await waitFor(() => expect(readState().keys).not.toBeNull());
		await user.type(screen.getByRole("textbox", { name: "Records path" }), "items{Enter}");
		await waitFor(() => expect(readState().sourceBlock).toMatchObject({ records: "items" }));
		await user.click(screen.getByRole("combobox", { name: "Format" }));
		await user.click(await screen.findByRole("option", { name: "CSV" }));
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "csv" }));
		expect(calls.filter((c) => c.route === "sources/sample")).toHaveLength(3);
	});

	it("blocks Next with an empty state when the sample has no records (Review Focus 3)", async () => {
		routes({ "sources/sample": () => ({ records: [], paths: [] }) });
		renderSource();
		chooseFile("empty.json", "[]");
		expect(await screen.findByText(/no records/i)).toBeVisible();
		expect(screen.getByText(/check the records path/i)).toBeVisible();
		expect(next()).toBeDisabled();
	});

	it("blocks Next for a CSV with only a header (preflight F7)", async () => {
		routes({ "sources/sample": () => sampleCsv(["id", "title"], []) });
		renderSource();
		chooseFile("header.csv", "id,title\n");
		expect(await screen.findByText("The file has a header but no rows")).toBeVisible();
		expect(next()).toBeDisabled();
	});

	it("shows INVALID_SOURCE as its sentence, inline, with the route's specifics", async () => {
		routes({
			"sources/sample": () => fail("INVALID_SOURCE", "Unexpected token at line 3 column 5", 400),
		});
		renderSource();
		chooseFile("broken.json", "{");
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The data could not be read. Check its format and settings.");
		expect(alert).toHaveTextContent("Unexpected token at line 3 column 5");
		expect(next()).toBeDisabled();
		// The settings stay, so the format can be corrected.
		expect(screen.getByRole("combobox", { name: "Format" })).toBeInTheDocument();
	});

	it("the saved-template picker is disabled until a file is sampled (preflight F10)", async () => {
		routes({ "templates/list": () => ({ items: [SUMMARY], hasMore: false }) });
		renderSource();
		const picker = await screen.findByRole("combobox", { name: "Saved template" });
		expect(picker).toBeDisabled();
		expect(screen.getByText("Choose the file to import first")).toBeVisible();
		expect(picker).toHaveAccessibleDescription("Choose the file to import first");
		expect(screen.getByRole("button", { name: "Load template" })).toBeDisabled();
		chooseFile("posts.csv");
		await waitFor(() => expect(picker).toBeEnabled());
		expect(screen.queryByText("Choose the file to import first")).toBeNull();
	});

	it("loads a saved template and opens Preview", async () => {
		const { calls } = routes({
			"templates/list": () => ({ items: [SUMMARY], hasMore: false }),
			"templates/get": () => SAVED_TEMPLATE,
		});
		const { user } = renderSource();
		chooseFile("posts.csv");
		const picker = await screen.findByRole("combobox", { name: "Saved template" });
		await waitFor(() => expect(picker).toBeEnabled());
		await user.click(picker);
		await user.click(await screen.findByRole("option", { name: /Posts from CSV/ }));
		await user.click(screen.getByRole("button", { name: "Load template" }));
		await waitFor(() => expect(readState().step).toBe("preview"));
		expect(calls.find((c) => c.route === "templates/get")?.body).toEqual({
			id: SAVED_TEMPLATE.id,
		});
		// The file is sampled again with the template's own source settings.
		expect(calls.filter((c) => c.route === "sources/sample").map((c) => c.body)).toEqual([
			{ uploadId: UPLOAD_ID, n: SAMPLE_MAX, source: { format: "csv" } },
			{ uploadId: UPLOAD_ID, n: SAMPLE_MAX, source: { format: "csv" } },
		]);
		const state = readState();
		expect(state.target).toEqual({ collection: "posts", locale: "en", translationLocale: null });
		expect(state.rows).toEqual(["key", "field:title"]);
		expect(state.base).toEqual({ id: SAVED_TEMPLATE.id, revision: 3 });
	});

	/** Picks the saved template in the picker and loads it. */
	async function loadTemplate(user: { click(e: Element): Promise<void> }): Promise<void> {
		const picker = await screen.findByRole("combobox", { name: "Saved template" });
		await waitFor(() => expect(picker).toBeEnabled());
		await user.click(picker);
		await user.click(await screen.findByRole("option", { name: /Feed items/ }));
		await user.click(screen.getByRole("button", { name: "Load template" }));
	}

	const JSON_TEMPLATE = {
		...SAVED_TEMPLATE,
		id: "01JZ000000000000000000TPL2",
		name: "Feed items",
		format: "json",
		template: templateSchema.parse({
			version: 1,
			source: { format: "json", records: "data.items" },
			collection: "posts",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "name", type: "text" } },
		}),
	};
	const { template: __, ...JSON_SUMMARY } = JSON_TEMPLATE;

	it("samples a loaded template's source settings, so Map gets its keys", async () => {
		const { calls } = routes({
			"templates/list": () => ({ items: [JSON_SUMMARY], hasMore: false }),
			"templates/get": () => JSON_TEMPLATE,
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "data.items"
					? { records: [{ sku: "A", name: "Alpha" }], paths: ["name", "sku"] }
					: { records: [{ data: { items: [] } }], paths: ["data.items"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(readState().keys).toEqual(["data.items"]));
		await loadTemplate(user);
		await waitFor(() => expect(readState().step).toBe("preview"));
		const state = readState();
		expect(state.keys).toEqual(["name", "sku"]);
		expect(state.sourceBlock).toEqual({ format: "json", records: "data.items" });
		expect(state.base).toEqual({ id: JSON_TEMPLATE.id, revision: 3 });
		expect(calls.filter((c) => c.route === "sources/sample").at(-1)?.body).toEqual({
			uploadId: UPLOAD_ID,
			n: SAMPLE_MAX,
			source: { format: "json", records: "data.items" },
		});
	});

	it("stays on Source when a template's settings find no records in the file", async () => {
		routes({
			"templates/list": () => ({ items: [JSON_SUMMARY], hasMore: false }),
			"templates/get": () => JSON_TEMPLATE,
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "data.items"
					? { records: [], paths: [] }
					: { records: [{ a: 1 }], paths: ["a"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(readState().keys).toEqual(["a"]));
		await loadTemplate(user);
		expect(await screen.findByRole("alert")).toHaveTextContent(/finds? no records/i);
		const state = readState();
		expect(state.step).toBe("source");
		expect(state.base).toBeNull();
		expect(state.keys).toEqual(["a"]);
		expect(state.sourceBlock).toEqual({ format: "json" });
		expect(next()).toBeEnabled();
	});

	it("stays on Source when a template's settings find a header but no rows", async () => {
		let samples = 0;
		routes({
			"templates/list": () => ({ items: [SUMMARY], hasMore: false }),
			"templates/get": () => SAVED_TEMPLATE,
			"sources/sample": () => (++samples === 1 ? CSV_SAMPLE : sampleCsv(["id", "title"], [])),
		});
		const { user } = renderSource();
		chooseFile("posts.csv");
		const picker = await screen.findByRole("combobox", { name: "Saved template" });
		await waitFor(() => expect(picker).toBeEnabled());
		await user.click(picker);
		await user.click(await screen.findByRole("option", { name: /Posts from CSV/ }));
		await user.click(screen.getByRole("button", { name: "Load template" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/finds? no records/i);
		expect(readState()).toMatchObject({ step: "source", base: null, keys: ["id", "title"] });
	});

	it("stays on Source when a template's settings cannot read the file", async () => {
		routes({
			"templates/list": () => ({ items: [JSON_SUMMARY], hasMore: false }),
			"templates/get": () => JSON_TEMPLATE,
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "data.items"
					? fail("INVALID_SOURCE", "Expected an array at data.items", 400)
					: { records: [{ a: 1 }], paths: ["a"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(readState().keys).toEqual(["a"]));
		await loadTemplate(user);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("The data could not be read.");
		expect(alert).toHaveTextContent("Expected an array at data.items");
		expect(readState()).toMatchObject({ step: "source", base: null, keys: ["a"] });
	});

	it("notes per saved source whether its last fetch failed or it was never fetched", async () => {
		const at = "2026-11-23T12:00:00.000Z";
		const fetched = { at, status: 200, sha256: "x", bytes: 1, uploadId: FETCHED_ID };
		routes({
			"sources/list": () => ({
				items: [
					{ ...SOURCE_ROW, id: "S1", name: "Fresh" },
					{ ...SOURCE_ROW, id: "S2", name: "Fetched", lastFetch: fetched },
					{
						...SOURCE_ROW,
						id: "S3",
						name: "Broken",
						lastFetch: fetched,
						lastError: { at, code: "HTTP_ERROR", message: "HTTP 500 from example.com" },
					},
				],
				hasMore: false,
			}),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Saved source" }));
		const rows = await screen.findAllByRole("listitem");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("Never fetched"),
			expect.not.stringMatching(/Never fetched|Last fetch failed/),
			expect.stringContaining("Last fetch failed"),
		]);
		expect(document.body.textContent).not.toContain("HTTP 500");
	});

	it("uses a saved source: fetches it by ID and samples it", async () => {
		const keyed = {
			...SOURCE_ROW,
			id: "01JZ00000000000000000SRC02",
			name: "Keyed feed",
			url: "https://example.com/keyed.xml?api_key=s3cret",
		};
		const { calls } = routes({
			"sources/list": () => ({ items: [SOURCE_ROW, keyed], hasMore: false }),
			"sources/fetch": () => ({ changed: false, uploadId: FETCHED_ID, bytes: 10, sha256: "x" }),
			"sources/sample": () => ({ records: [{ sku: "A" }], paths: ["sku"] }),
		});
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "Saved source" }));
		// A URL's query may hold a key: only its host and path are shown.
		expect(await screen.findByText("example.com/keyed.xml")).toBeVisible();
		expect(document.body.textContent).not.toContain("s3cret");
		await user.click(
			await screen.findByRole("button", { name: "Use example.com/feeds/products.json" }),
		);
		await waitFor(() => expect(readState().keys).toEqual(["sku"]));
		expect(calls.filter((c) => c.route.startsWith("sources/")).map((c) => c.body)).toEqual([
			{},
			{ id: SOURCE_ROW.id },
			{ uploadId: FETCHED_ID, n: SAMPLE_MAX, source: { format: "json" } },
		]);
		expect(readState().source).toEqual({
			kind: "saved",
			uploadId: FETCHED_ID,
			label: "example.com/feeds/products.json",
		});
	});

	it("never shows the upload ID", async () => {
		routes({});
		renderSource();
		chooseFile("posts.csv");
		await waitFor(() => expect(next()).toBeEnabled());
		const shown = document.body.cloneNode(true) as HTMLElement;
		shown.querySelector('[data-testid="state"]')?.remove();
		expect(shown.innerHTML).not.toContain(UPLOAD_ID);
	});

	it("shows empty states for no saved sources and no saved templates, and a Loader while each list loads", async () => {
		const sources = deferred<unknown>();
		const templates = deferred<unknown>();
		routes({
			"sources/list": () => sources.promise,
			"templates/list": () => templates.promise,
		});
		const { user } = renderSource();
		expect(await screen.findByRole("status", { name: "Loading saved templates" })).toBeVisible();
		templates.resolve({ items: [], hasMore: false });
		expect(await screen.findByText("No saved templates")).toBeVisible();

		await user.click(screen.getByRole("tab", { name: "Saved source" }));
		expect(await screen.findByRole("status", { name: "Loading saved sources" })).toBeVisible();
		sources.resolve({ items: [], hasMore: false });
		expect(await screen.findByText("No saved sources")).toBeVisible();
	});

	it("links to EmDash's WordPress importer", async () => {
		routes({});
		renderSource();
		expect(screen.getByRole("link", { name: /WordPress importer/ })).toHaveAttribute(
			"href",
			"/_emdash/admin/import/wordpress",
		);
		await screen.findByText(/no saved templates/i);
	});

	it("moves to Target on Next", async () => {
		routes({});
		const { user } = renderSource();
		chooseFile("posts.csv");
		await waitFor(() => expect(next()).toBeEnabled());
		await user.click(next());
		expect(readState().step).toBe("target");
	});
	it("disables the source settings while a template loads", async () => {
		const loading = deferred<unknown>();
		routes({
			"templates/list": () => ({ items: [JSON_SUMMARY], hasMore: false }),
			"templates/get": () => loading.promise,
			"sources/sample": () => ({ records: [{ a: 1 }], paths: ["a"] }),
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(readState().keys).toEqual(["a"]));
		const format = screen.getByRole("combobox", { name: "Format" });
		const records = screen.getByRole("textbox", { name: "Records path" });
		const filter = screen.getByRole("textbox", { name: "Row filter" });
		expect(format).toBeEnabled();
		await loadTemplate(user);
		await waitFor(() => expect(format).toBeDisabled());
		expect(records).toBeDisabled();
		expect(filter).toBeDisabled();
		loading.resolve(JSON_TEMPLATE);
		await waitFor(() => expect(readState().step).toBe("preview"));
	});

	it("disables the source settings while a sample runs", async () => {
		const slow = deferred<unknown>();
		routes({
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "a"
					? slow.promise
					: { records: [{ x: 1 }], paths: ["x"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(readState().keys).toEqual(["x"]));
		const records = screen.getByRole("textbox", { name: "Records path" });
		await user.type(records, "a{Enter}");
		await waitFor(() => expect(records).toBeDisabled());
		expect(screen.getByRole("combobox", { name: "Format" })).toBeDisabled();
		expect(screen.getByRole("textbox", { name: "Row filter" })).toBeDisabled();
		slow.resolve({ records: [{ y: 1 }], paths: ["y"] });
		await waitFor(() => expect(records).toBeEnabled());
		expect(readState().keys).toEqual(["y"]);
	});

	it("shows at most 200 keys in the sample, and says how many there are", async () => {
		const paths = Array.from({ length: 250 }, (_, i) => `key${i}`);
		routes({
			"sources/sample": () => ({
				records: [Object.fromEntries(paths.map((p) => [p, 1]))],
				paths,
			}),
		});
		renderSource();
		chooseFile("wide.json", "{}");
		expect(await screen.findByText(/Showing 200 of 250 keys/)).toBeVisible();
		const table = screen.getByRole("table", { name: "Sample" });
		// The header row and 200 key rows.
		expect(within(table).getAllByRole("row")).toHaveLength(201);
	});

	it("disables Next when a new setting cannot be sampled, and keeps the settings", async () => {
		routes({
			"sources/sample": (body) =>
				(body as { source: { records?: string } }).source.records === "nope"
					? fail("INVALID_SOURCE", "source.records: not found", 400)
					: { records: [{ x: 1 }], paths: ["x"] },
		});
		const { user } = renderSource();
		chooseFile("feed.json", "{}");
		await waitFor(() => expect(next()).toBeEnabled());
		await user.type(screen.getByRole("textbox", { name: "Records path" }), "nope{Enter}");
		expect(await screen.findByRole("alert")).toHaveTextContent("source.records: not found");
		expect(readState().keys).toBeNull();
		expect(next()).toBeDisabled();
		expect(screen.queryByRole("table", { name: "Sample" })).toBeNull();
	});

	it("keeps the wizard's source when a new file cannot be sampled, but blocks Next", async () => {
		const ids = [UPLOAD_ID, FETCHED_ID];
		routes({
			upload: () => ({ uploadId: ids.shift(), bytes: 10 }),
			"sources/sample": (body) =>
				(body as { source: { format: string } }).source.format === "xml"
					? fail("INVALID_SOURCE", "source.records is required for xml", 400)
					: CSV_SAMPLE,
		});
		renderSource();
		chooseFile("posts.csv");
		await waitFor(() => expect(next()).toBeEnabled());
		chooseFile("feed.xml", "<feed/>");
		expect(await screen.findByRole("alert")).toHaveTextContent("required for xml");
		expect(readState().source).toMatchObject({ uploadId: UPLOAD_ID, label: "posts.csv" });
		expect(readState().keys).toEqual(["id", "title"]);
		expect(screen.queryByRole("table", { name: "Sample" })).toBeNull();
		expect(next()).toBeDisabled();
		// The new file's settings are shown, to fix it.
		expect(screen.getByRole("textbox", { name: "Records path" })).toBeInTheDocument();
	});

	it("reads an XLSX sheet number as a number, a name as text, and the header row", async () => {
		const { calls } = routes({});
		const { user } = renderSource();
		chooseFile("book.xlsx", "PK");
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "xlsx" }));
		await user.type(screen.getByRole("textbox", { name: "Sheet" }), "2{Enter}");
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "xlsx", sheet: 2 }));
		const sheet = screen.getByRole("textbox", { name: "Sheet" });
		await user.clear(sheet);
		await user.type(sheet, "Products{Enter}");
		await user.type(screen.getByRole("spinbutton", { name: "Header row" }), "3{Enter}");
		await waitFor(() =>
			expect(readState().sourceBlock).toEqual({ format: "xlsx", sheet: "Products", headerRow: 3 }),
		);
		expect(calls.filter((c) => c.route === "sources/sample")).toHaveLength(4);
		// CSV takes neither.
		await user.click(screen.getByRole("combobox", { name: "Format" }));
		await user.click(await screen.findByRole("option", { name: "CSV" }));
		await waitFor(() => expect(readState().sourceBlock).toEqual({ format: "csv" }));
	});

	it("stops deriving the name from the URL once it is edited", async () => {
		routes({ "credentials/list": () => [] });
		const { user } = renderSource();
		await user.click(screen.getByRole("tab", { name: "From URL" }));
		const name = screen.getByRole("textbox", { name: "Name" });
		const fetch = screen.getByRole("button", { name: "Fetch" });
		expect(fetch).toBeDisabled();
		await user.type(screen.getByRole("textbox", { name: "Address" }), "https://a.example/x");
		expect(name).toHaveValue("a.example/x");
		await user.clear(name);
		await user.type(name, "Mine");
		await user.type(screen.getByRole("textbox", { name: "Address" }), "/y");
		expect(name).toHaveValue("Mine");
		expect(fetch).toBeEnabled();
	});
});

describe("the Source step's helpers", () => {
	it("detects formats from extensions, and URL sources from their path", () => {
		expect(formatOf("a.CSV")).toBe("csv");
		expect(formatOf("a.ndjson")).toBe("jsonl");
		expect(formatOf("a.jsonl")).toBe("jsonl");
		expect(formatOf("a.xlsx")).toBe("xlsx");
		expect(formatOf("a.txt")).toBeNull();
		expect(formatOf("dir.json/file")).toBeNull();
		expect(formatOf("noext")).toBeNull();
		expect(formatOf("csv")).toBeNull();
		expect(formatOf("a.constructor")).toBeNull();
		expect(formatOf("a.json/")).toBeNull();
		expect(formatOfUrl("https://x.example/feed.xml?page=2")).toBe("xml");
		expect(formatOfUrl("https://x.example/api/products")).toBeNull();
	});

	it("names a source after the URL's host and path", () => {
		expect(nameFromUrl("https://example.com/feeds/products.json?key=secret")).toBe(
			"example.com/feeds/products.json",
		);
		expect(nameFromUrl("https://example.com/")).toBe("example.com");
		expect(nameFromUrl("ftp://example.com/a")).toBe("");
		expect(nameFromUrl("not a url")).toBe("");
		expect(nameFromUrl(`https://example.com/${"a".repeat(200)}`)).toHaveLength(100);
	});
});
