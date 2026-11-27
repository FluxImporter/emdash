import { describe, expect, it } from "vitest";
import { readSuggestCollection, type SuggestCollection } from "../../src/emdash/schema.js";
import type { ProviderOutcome, ProviderRequest } from "../../src/plugin/ai/provider.js";
import { AI_USAGE_KEY } from "../../src/plugin/ai/rate-limit.js";
import { ServiceError } from "../../src/plugin/service.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import { type SuggestDeps, type SuggestInput, suggestMapping } from "../../src/plugin/suggest.js";
import { readCsvSample } from "../../src/sources/csv.js";
import { MemorySettings } from "./fakes.js";
import { sourceRow } from "./schedule-fakes.js";
import { failure, templateSetup } from "./templates-fixture.js";

const KEY = "sk-test-KEYMARK";
const COLLECTION: SuggestCollection = {
	label: "Products",
	fields: [
		{ slug: "title", label: "Title", type: "string", required: true },
		{ slug: "price", label: "Price", type: "number" },
		{ slug: "released", label: "Released", type: "datetime" },
		{ slug: "body", label: "Body", type: "portableText" },
		{ slug: "author", label: "Author", type: "reference" },
		{ slug: "flux_source_id", label: "Source ID", type: "string" },
	],
};
/** 20 products, then a 21st whose values are markers: only 20 are read, 5 sent. */
function csv(n = 20): string {
	let out = "sku,Name,Price,Released,Handle,Description\r\n";
	for (let i = 0; i < n; i++) {
		const day = String((i % 20) + 1).padStart(2, "0");
		out += `SKU-${i},Product ${i},${i}.5,${day}/03/2026,product-${i},<p>Text ${i}</p>\r\n`;
	}
	return out;
}
const SIXTH = `${csv(5)}SKU-5,SIXTH-RECORD-MARK,5.5,06/03/2026,product-5,<p>x</p>\r\n`;
const item = (field: string, from: string | null, extra: Record<string, unknown> = {}) => ({
	field,
	from,
	confidence: "high",
	rationale: "",
	dateFormat: null,
	decimalComma: null,
	portableTextFormat: null,
	...extra,
});
const VALID: ProviderOutcome = {
	ok: true,
	value: {
		key: "sku",
		slug: null,
		fields: [
			item("title", "Name", { rationale: "The product name" }),
			item("body", "Description", {
				confidence: "medium",
				rationale: "Markup",
				portableTextFormat: "html",
			}),
		],
	},
	model: "claude-opus-5-5",
	status: 200,
	usage: { input: 900, output: 120 },
};

function harness(
	opts: {
		settings?: Record<string, unknown>;
		outcome?: ProviderOutcome | (() => Promise<ProviderOutcome>);
	} = {},
) {
	const values: Record<string, unknown> = {
		aiProvider: "anthropic",
		aiApiKey: KEY,
		...opts.settings,
	};
	const read: string[] = [];
	const requests: ProviderRequest[] = [];
	const uploads = new Map<string, string>([["UPLOAD-1", csv()]]);
	const sources = new Map<string, SourceRow>();
	const fetched: [string, boolean][] = [];
	const sampled: string[] = [];
	const logged: string[] = [];
	const kvStore = new MemorySettings();
	const kvCalls: string[] = [];
	const { deps: templates, templates: saved } = templateSetup({
		collections: { products: COLLECTION.fields },
	});
	const deps: SuggestDeps = {
		settings: {
			get: async <T>(key: string) => {
				read.push(key);
				const value = values[key];
				if (value instanceof Error) throw value;
				return (value ?? null) as T | null;
			},
		},
		kv: {
			getVersioned: <T>(key: string) => {
				kvCalls.push("get");
				return kvStore.getVersioned<T>(key);
			},
			compareAndSet: (key: string, rev: string | null, value: unknown) => {
				kvCalls.push("cas");
				return kvStore.compareAndSet(key, rev, value);
			},
		},
		templates,
		readCollection: async (slug) => (slug === "products" ? COLLECTION : null),
		sampleUpload: async (id) => {
			sampled.push(id);
			const text = uploads.get(id);
			if (text === undefined) {
				throw new ServiceError("UPLOAD_NOT_FOUND", "Upload [staged file] not found", 404);
			}
			return readCsvSample(new Blob([text]).stream(), 20);
		},
		getSource: async (id) => sources.get(id) ?? null,
		fetchSource: async (id, force) => {
			fetched.push([id, force]);
			uploads.set("FETCHED-1", csv());
			return { changed: true, uploadId: "FETCHED-1", bytes: 1, sha256: "x" };
		},
		allowPrivateNetwork: false,
		net: {
			allowPrivateNetwork: false,
			resolver: async () => [],
			fetch: async () => new Response(),
		},
		callProvider: async (_ai, request) => {
			requests.push(request);
			const outcome = opts.outcome ?? VALID;
			return typeof outcome === "function" ? outcome() : outcome;
		},
		log: { info: (m) => logged.push(m) },
		now: () => Date.parse("2026-11-19T10:00:00Z"),
	};
	return {
		deps,
		values,
		read,
		requests,
		uploads,
		sources,
		fetched,
		sampled,
		logged,
		kvStore,
		kvCalls,
		saved,
	};
}
const TEXT: SuggestInput = { collection: "products", locale: "en", text: csv() };
/** The payload the provider received, parsed back out of the user message. */
const payloadOf = (r: ProviderRequest) =>
	JSON.parse(r.user.slice("<import_data>\n".length, -"\n</import_data>".length)) as {
		fields: { slug: string }[];
		source: { keys: string[] };
		records: Record<string, string>[];
	};

describe("templates/suggest without a provider (spec steps 1-5, 7-9)", () => {
	it("answers name matching with ai: false, reading only aiProvider and calling nothing (Ruling 64)", async () => {
		const h = harness();
		const out = await suggestMapping(h.deps, { ...TEXT, ai: false });
		expect(h.read).toEqual(["aiProvider"]);
		expect(h.requests).toEqual([]);
		expect(h.kvCalls).toEqual([]);
		expect(out).toMatchObject({
			method: "fallback",
			ai: { available: true, provider: "anthropic" },
			sent: null,
			key: { from: "sku", confidence: 0.9, origin: "fallback" },
			slug: { from: "Handle", confidence: 0.8, origin: "fallback" },
			unmapped: { fields: [], keys: [] },
		});
		expect(out.fields.map((f) => [f.field, f.from, f.mapping])).toEqual([
			["title", "Name", "text"],
			["price", "Price", "number"],
			["released", "Released", "date"],
			["body", "Description", "portableText"],
		]);
		expect(out.template).toMatchObject({
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			slug: { from: "Handle" },
			fields: { released: { type: "date", from: "Released", format: "dd/MM/yyyy", tz: "UTC" } },
		});
		expect(out.check).toEqual({ problems: [], warnings: expect.any(Array) });
		expect(out.warnings).toContainEqual({ code: "reference_not_suggested", fields: ["author"] });
		expect(out.warnings.some((w) => w.code.startsWith("ai_"))).toBe(false);
	});

	it("gives no ai_* code for provider none, and ai_not_configured or ai_key_unavailable when set", async () => {
		const none = await suggestMapping(harness({ settings: { aiProvider: "none" } }).deps, TEXT);
		expect(none.ai).toEqual({ available: false });
		expect(none.warnings.some((w) => w.code.startsWith("ai_"))).toBe(false);
		const noKey = await suggestMapping(harness({ settings: { aiApiKey: " " } }).deps, TEXT);
		expect(noKey.warnings).toContainEqual({ code: "ai_not_configured" });
		expect(noKey.ai).toEqual({ available: false, provider: "anthropic" });
		const locked = Object.assign(new Error("x"), { code: "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING" });
		const unreadable = await suggestMapping(harness({ settings: { aiApiKey: locked } }).deps, TEXT);
		expect(unreadable).toMatchObject({ method: "fallback", sent: null });
		expect(unreadable.warnings).toContainEqual({ code: "ai_key_unavailable" });
	});

	it("makes no call and adds no ai_* code when name matching settles every field (Ruling 51)", async () => {
		const h = harness();
		const settledOnly = {
			label: "P",
			fields: COLLECTION.fields.filter((f) => ["price", "released"].includes(f.slug)),
		};
		h.deps.readCollection = async () => settledOnly;
		const out = await suggestMapping(h.deps, TEXT);
		expect(h.requests).toEqual([]);
		expect(h.read).toEqual(["aiProvider", "aiApiKey", "aiModel"]);
		expect(out.warnings.some((w) => w.code.startsWith("ai_"))).toBe(false);
		expect(out.fields.every((f) => f.confidence === 1)).toBe(true);
	});
});

describe("templates/suggest with a provider (spec step 6)", () => {
	it("sends only the unsettled fields and the free keys, and uses the reply", async () => {
		const h = harness();
		const out = await suggestMapping(h.deps, TEXT);
		expect(h.requests).toHaveLength(1);
		const payload = payloadOf(h.requests[0] as ProviderRequest);
		expect(payload.fields.map((f) => f.slug)).toEqual(["title", "body"]);
		expect(payload.source.keys).toEqual(["sku", "Name", "Handle", "Description"]);
		expect(payload.records).toHaveLength(5);
		expect(h.requests[0]?.timeoutMs).toBe(21_200);
		expect(out).toMatchObject({
			method: "ai",
			ai: { available: true, provider: "anthropic", model: "claude-opus-5-5" },
			sent: { records: 5, keys: 4, fields: 2 },
		});
		expect(out.fields[0]).toMatchObject({
			field: "title",
			from: "Name",
			origin: "ai",
			rationale: "The product name",
		});
		expect(out.template?.fields.body).toEqual({
			type: "portableText",
			from: "Description",
			format: "html",
		});
		expect(h.kvStore.values.get(AI_USAGE_KEY)?.value).toEqual({ hour: "2026-11-19T10", count: 1 });
	});

	it("sends only the payload: the recorded request holds none of the route's markers (Review Focus 2)", async () => {
		const h = harness();
		h.sources.set(
			"S1",
			sourceRow("S1", {
				url: "https://feeds.example/s3cr3t-path.csv?token=t0ken",
				credential: "cred-mark",
				lastFetch: { at: "x", status: 200, sha256: "s", bytes: 1, uploadId: "UPLOAD-1" },
			}),
		);
		h.uploads.set("UPLOAD-1", SIXTH);
		await h.saved.put("TMPL-MARK", {
			id: "TMPL-MARK",
			name: "Base",
			collection: "products",
			locale: "en",
			revision: 1,
			createdAt: "x",
			updatedAt: "x",
			createdBy: "USER-MARK",
			updatedBy: "USER-MARK",
			template: {
				version: 1,
				collection: "products",
				locale: "en",
				key: { from: "sku" },
				fields: { price: { from: "Price", type: "number" } },
			},
		} as never);
		await suggestMapping(h.deps, {
			collection: "products",
			sourceId: "S1",
			templateId: "TMPL-MARK",
		});
		const sent = JSON.stringify(h.requests);
		for (const marker of [
			"s3cr3t",
			"t0ken",
			"feeds.example",
			"cred-mark",
			"TMPL-MARK",
			"USER-MARK",
			"UPLOAD-1",
			"SIXTH-RECORD-MARK",
			KEY,
			"locale",
		]) {
			expect(sent, marker).not.toContain(marker);
		}
		expect(payloadOf(h.requests[0] as ProviderRequest).source.keys).not.toContain("Price");
	});

	it.each([
		"ai_timeout",
		"ai_auth_failed",
		"ai_billing",
		"ai_provider_rate_limited",
		"ai_provider_rejected",
		"ai_provider_error",
		"ai_refused",
		"ai_truncated",
		"ai_invalid_output",
	] as const)("answers %s as a 200 with name matching and a sent count", async (code) => {
		const h = harness({ outcome: { ok: false, code, status: 500 } });
		const out = await suggestMapping(h.deps, TEXT);
		expect(out).toMatchObject({ method: "fallback", sent: { records: 5, keys: 4, fields: 2 } });
		expect(out.warnings.filter((w) => w.code.startsWith("ai_"))).toEqual([{ code }]);
		expect(out.template).not.toBeNull();
		expect(out.ai).toEqual({ available: true, provider: "anthropic" });
	});

	it("reports ai_url_blocked with sent null, and survives a provider port that rejects", async () => {
		const blocked = await suggestMapping(
			harness({ outcome: { ok: false, code: "ai_url_blocked" } }).deps,
			TEXT,
		);
		expect(blocked).toMatchObject({ method: "fallback", sent: null });
		const thrown = harness({ outcome: () => Promise.reject(new Error(`boom ${KEY}`)) });
		const out = await suggestMapping(thrown.deps, TEXT);
		expect(out.warnings).toContainEqual({ code: "ai_provider_error" });
		expect(out).toMatchObject({ method: "fallback", sent: { records: 5, keys: 4, fields: 2 } });
		expect(thrown.logged.join("\n")).not.toContain("KEYMARK");
		expect(JSON.stringify(out)).not.toContain("KEYMARK");
	});

	it("reads a reply that fails validation as ai_invalid_output", async () => {
		const out = await suggestMapping(
			harness({ outcome: { ...VALID, value: { key: null } } }).deps,
			TEXT,
		);
		expect(out.warnings).toContainEqual({ code: "ai_invalid_output" });
		expect(out.method).toBe("fallback");
	});

	it("skips the call when the hour's 30 calls are used, touching nothing else", async () => {
		const h = harness();
		h.kvStore.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 30 });
		const out = await suggestMapping(h.deps, TEXT);
		expect(h.requests).toEqual([]);
		expect(out).toMatchObject({ method: "fallback", sent: null });
		expect(out.warnings).toContainEqual({ code: "ai_rate_limited" });
		// A used-up limit is not a KV failure (review fix 2).
		expect(h.logged[0]).toContain(" code=ai_rate_limited ms=");
		expect(h.logged[0]).not.toContain("rate=");
	});

	it("answers a KV failure of the rate limit with name matching and ai_rate_limited, never a 5xx (Ruling 35)", async () => {
		for (const failing of ["getVersioned", "compareAndSet"] as const) {
			const h = harness();
			h.deps.kv = {
				...h.deps.kv,
				[failing]: async () => {
					throw new Error("D1_ERROR: database is locked");
				},
			};
			const out = await suggestMapping(h.deps, TEXT);
			expect(h.requests, failing).toEqual([]);
			expect(out, failing).toMatchObject({ method: "fallback", sent: null });
			expect(out.warnings.filter((w) => w.code.startsWith("ai_"))).toEqual([
				{ code: "ai_rate_limited" },
			]);
			expect(h.logged[0]).toContain(" code=ai_rate_limited rate=kv_error ");
			expect(h.logged[0]).not.toContain("D1_ERROR");
		}
	});

	it("makes no call and touches no KV when the payload cannot fit (Ruling 50)", async () => {
		const h = harness();
		const keys = Array.from(
			{ length: 200 },
			(_, i) => `${"<".repeat(197)}${String(i).padStart(3, "0")}`,
		);
		const out = await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			text: `${keys.join(",")}\r\n`,
		});
		expect(h.requests).toEqual([]);
		expect(h.kvCalls).toEqual([]);
		expect(out).toMatchObject({ method: "fallback", sent: null });
		expect(out.warnings).toContainEqual({ code: "ai_payload_too_large" });
	});

	it("logs one line of codes and counts, never the key, a label, a value or the reply", async () => {
		const h = harness({ outcome: { ok: false, code: "ai_auth_failed", status: 401 } });
		await suggestMapping(h.deps, TEXT);
		expect(h.logged).toHaveLength(1);
		expect(h.logged[0]).toMatch(
			/^fluximporter: suggest method=fallback provider=anthropic model=claude-opus-5-5 host=api\.anthropic\.com status=401 code=ai_auth_failed ms=\d+ sent=5\/4\/2\/\d+ usage=none$/,
		);
		for (const marker of ["KEYMARK", "Title", "Product 1", "The product name"]) {
			expect(h.logged[0], marker).not.toContain(marker);
		}
	});

	it("logs the usage of an answered call, and keeps the key out of the reply and the log", async () => {
		const h = harness();
		const out = await suggestMapping(h.deps, TEXT);
		expect(h.logged[0]).toMatch(
			/ method=ai provider=anthropic model=claude-opus-5-5 host=api\.anthropic\.com status=200 code=none ms=\d+ sent=5\/4\/2\/\d+ usage=900\/120$/,
		);
		expect(JSON.stringify(out)).not.toContain("KEYMARK");
		expect(h.logged.join("\n")).not.toContain("KEYMARK");
	});

	it.each([
		["", "an empty model"],
		["evil model\nline", "a model MODEL_RE refuses"],
	])("reports the configured model for %j (%s), never the provider's text", async (model) => {
		const h = harness({ settings: { aiModel: "claude-custom-1" }, outcome: { ...VALID, model } });
		const out = await suggestMapping(h.deps, TEXT);
		expect(out.ai).toEqual({ available: true, provider: "anthropic", model: "claude-custom-1" });
		expect(h.logged[0]).toContain(" model=claude-custom-1 ");
		const fallback = await suggestMapping(
			harness({ outcome: { ...VALID, model: "claude-fallback-2" } }).deps,
			TEXT,
		);
		expect(fallback.ai.model).toBe("claude-fallback-2");
	});

	it("passes validation only the fields and keys that were sent", async () => {
		const h = harness({
			outcome: {
				...VALID,
				value: {
					key: null,
					slug: null,
					// Price is a settled field's key, never sent; a field the payload left out is unknown.
					fields: [item("title", "Price"), item("price", "Name")],
				},
			},
		});
		const out = await suggestMapping(h.deps, TEXT);
		expect(out.warnings).toContainEqual({ code: "ai_unknown_field", count: 1 });
		expect(out.warnings).toContainEqual({ code: "ai_unknown_key", count: 1 });
		expect(out.fields.find((f) => f.field === "title")).toMatchObject({ from: "Name" });
		expect(out.fields.find((f) => f.field === "price")).toMatchObject({ from: "Price" });
	});

	it("validates against the keys sent, not every free key: a key left out of the payload is unknown", async () => {
		const h = harness({
			outcome: {
				...VALID,
				value: { key: null, slug: null, fields: [item("title", "y".repeat(201))] },
			},
		});
		const long = `sku,Name,${"y".repeat(201)}\r\nA,x,z\r\n`;
		const out = await suggestMapping(h.deps, { collection: "products", locale: "en", text: long });
		expect(payloadOf(h.requests[0] as ProviderRequest).source.keys).toEqual(["sku", "Name"]);
		expect(out.warnings).toContainEqual({ code: "keys_not_sent", count: 1 });
		expect(out.warnings).toContainEqual({ code: "ai_unknown_key", count: 1 });
	});

	it("validates against the fields sent: a field past the 100th is unknown to the reply", async () => {
		const h = harness({
			outcome: {
				...VALID,
				value: { key: null, slug: null, fields: [item("f100", "Name"), item("f099", "Handle")] },
			},
		});
		const many = Array.from({ length: 101 }, (_, i) => ({
			slug: `f${String(i).padStart(3, "0")}`,
			label: `Q${i}`,
			type: "string",
		}));
		h.deps.readCollection = async () => ({ label: "P", fields: many });
		const out = await suggestMapping(h.deps, { ...TEXT, text: "sku,Name\r\nA,x\r\n" });
		expect(payloadOf(h.requests[0] as ProviderRequest).fields).toHaveLength(100);
		expect(out.warnings).toContainEqual({ code: "fields_not_sent", count: 1, fields: ["f100"] });
		expect(out.warnings).toContainEqual({ code: "ai_unknown_field", count: 1 });
		expect(out.fields.find((f) => f.field === "f100")).toMatchObject({ from: null });
	});

	it("counts a reply item on a settled field's key once, as ai_duplicate_key (pre-flight F1)", async () => {
		const h = harness({
			outcome: { ...VALID, value: { key: null, slug: null, fields: [item("title", "sku")] } },
		});
		// The field sku settles on the key column sku, which is always sent (plan Ruling 21).
		h.deps.readCollection = async () => ({
			label: "P",
			fields: [
				{ slug: "sku", label: "SKU", type: "string" },
				{ slug: "title", label: "Title", type: "string" },
			],
		});
		const out = await suggestMapping(h.deps, TEXT);
		expect(payloadOf(h.requests[0] as ProviderRequest).source.keys).toContain("sku");
		expect(out.warnings.filter((w) => w.code === "ai_duplicate_key")).toEqual([
			{ code: "ai_duplicate_key", count: 1 },
		]);
		expect(out.fields.find((f) => f.field === "sku")).toMatchObject({
			from: "sku",
			origin: "fallback",
		});
		expect(out.fields.find((f) => f.field === "title")).toMatchObject({ from: "Name" });
	});

	it("adds the merge's ignored items to the reply's own ai_duplicate_key count", async () => {
		const h = harness({
			outcome: {
				...VALID,
				value: {
					key: null,
					slug: null,
					// title takes Name, body repeats it (the reply's duplicate), and Handle is the slug's.
					fields: [item("title", "Name"), item("body", "Name"), item("released", "Handle")],
				},
			},
		});
		h.deps.readCollection = async () => ({
			label: "P",
			fields: COLLECTION.fields.filter((f) => ["title", "body", "released"].includes(f.slug)),
		});
		// Released is not a column here, so released is unsettled and sent.
		const text = "sku,Name,Handle,Description\r\nA,x,a,<p>1</p>\r\n";
		const out = await suggestMapping(h.deps, { ...TEXT, text });
		expect(payloadOf(h.requests[0] as ProviderRequest).fields.map((f) => f.slug)).toEqual([
			"title",
			"released",
			"body",
		]);
		expect(out.warnings.filter((w) => w.code === "ai_duplicate_key")).toEqual([
			{ code: "ai_duplicate_key", count: 2 },
		]);
	});

	it("never gives a suggested field the key column a base field maps (pre-flight F2)", async () => {
		const h = harness({
			outcome: { ...VALID, value: { key: null, slug: null, fields: [item("title", "sku")] } },
		});
		h.deps.readCollection = async () => ({
			label: "P",
			fields: [
				{ slug: "code", label: "Code", type: "string" },
				{ slug: "title", label: "Sku", type: "string" },
			],
		});
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { code: { from: "sku", type: "text" } },
		};
		const out = await suggestMapping(h.deps, {
			collection: "products",
			text: csv(),
			template: base,
		});
		expect(out.fields.find((f) => f.field === "title")?.from).not.toBe("sku");
		expect(Object.values(out.template?.fields ?? {}).filter((m) => m.from === "sku")).toHaveLength(
			1,
		);
		expect(out.warnings).toContainEqual({ code: "ai_duplicate_key", count: 1 });
		const plain = await suggestMapping(h.deps, {
			collection: "products",
			text: csv(),
			template: base,
			ai: false,
		});
		expect(plain.fields.find((f) => f.field === "title")?.from).not.toBe("sku");
	});
});

describe("templates/suggest's base keys (plan Ruling 20, review fixes)", () => {
	const EMPTY_REPLY: ProviderOutcome = { ...VALID, value: { key: null, slug: null, fields: [] } };

	it("reads a base template's keys from its mappings, not from a select map's entries", async () => {
		const h = harness({ outcome: EMPTY_REPLY });
		h.deps.readCollection = async () => ({
			label: "P",
			fields: [
				{
					slug: "status",
					label: "Status",
					type: "select",
					validation: { options: ["Draft", "Published"] },
				},
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "body", label: "Body", type: "portableText" },
			],
		});
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			// A source value "from" maps to the option "Draft": "Draft" is a value, not a key.
			fields: { status: { type: "select", from: "state", map: { from: "Draft" } } },
		};
		const text = "sku,state,Draft,Heading,Text\r\nA,from,x,Hello,<p>1</p>\r\n";
		await suggestMapping(h.deps, { collection: "products", text, template: base });
		const keys = payloadOf(h.requests[0] as ProviderRequest).source.keys;
		expect(keys).toContain("Draft");
		expect(keys).not.toContain("state");
		const plain = await suggestMapping(h.deps, {
			collection: "products",
			text,
			template: base,
			ai: false,
		});
		expect(plain.unmapped.keys).toContain("Draft");
		expect(plain.unmapped.keys).not.toContain("state");
	});

	it("never sends a key the base template reads outside its fields, such as a taxonomy's", async () => {
		const h = harness({ outcome: EMPTY_REPLY });
		const base = {
			version: 1,
			collection: "products",
			locale: "en",
			key: { from: "sku" },
			fields: { price: { from: "Price", type: "number" } },
			taxonomies: { tags: { from: "Tags" } },
		};
		const text = "sku,Name,Price,Tags\r\nA,x,1,t\r\n";
		await suggestMapping(h.deps, { collection: "products", text, template: base });
		const keys = payloadOf(h.requests[0] as ProviderRequest).source.keys;
		expect(keys).toEqual(["sku", "Name"]);
		expect(keys).not.toContain("Tags");
		// unmapped.keys lists what no field, the key or the slug uses (plan Ruling 18): Tags is one.
		const plain = await suggestMapping(h.deps, {
			collection: "products",
			text,
			template: base,
			ai: false,
		});
		expect(plain.unmapped.keys).toEqual(["Tags"]);
	});

	it("drafts in the base template's locale, whatever locale the input names", async () => {
		const h = harness();
		const base = {
			version: 1,
			collection: "products",
			locale: "fr",
			key: { from: "sku" },
			fields: { price: { from: "Price", type: "number" } },
		};
		const out = await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			text: csv(),
			template: base,
			ai: false,
		});
		expect(out.template?.locale).toBe("fr");
	});
});

describe("templates/suggest's samples and refusals (spec step 4, Rulings 32, 33)", () => {
	it("never stages text, and refuses XLSX text, empty text and text over 1 MiB", async () => {
		const h = harness();
		await suggestMapping(h.deps, { ...TEXT, ai: false });
		expect([h.sampled, h.fetched]).toEqual([[], []]);
		const xlsx = await failure(suggestMapping(h.deps, { ...TEXT, source: { format: "xlsx" } }));
		expect([xlsx.code, xlsx.status, xlsx.message]).toEqual([
			"INVALID_FORMAT",
			400,
			"An XLSX workbook is a binary file and cannot be pasted; upload it instead",
		]);
		expect((await failure(suggestMapping(h.deps, { ...TEXT, text: " \n" }))).code).toBe(
			"EMPTY_BODY",
		);
		const big = await failure(
			suggestMapping(h.deps, { ...TEXT, text: "a".repeat(1024 * 1024 + 1) }),
		);
		expect([big.code, big.status]).toEqual(["TOO_LARGE", 413]);
		expect((await failure(suggestMapping(h.deps, { ...TEXT, text: '"a\n1' }))).code).toBe(
			"INVALID_SOURCE",
		);
		const empty = await failure(
			suggestMapping(h.deps, { ...TEXT, text: "[]", source: { format: "json" } }),
		);
		expect([empty.code, empty.status, empty.message]).toEqual([
			"NO_SOURCE_KEYS",
			400,
			"The sample has no column or path to map",
		]);
	});

	it("samples JSON text by its paths", async () => {
		const h = harness();
		const text = JSON.stringify([
			{ sku: "A", info: { Name: "One" } },
			{ sku: "B", info: { Name: "Two" } },
		]);
		const out = await suggestMapping(h.deps, {
			...TEXT,
			text,
			source: { format: "json" },
			ai: false,
		});
		expect(out.key.from).toBe("sku");
		expect(out.fields.find((f) => f.field === "title")).toMatchObject({ from: "info.Name" });
	});

	it("samples an upload as staged", async () => {
		const h = harness();
		await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			uploadId: "UPLOAD-1",
			ai: false,
		});
		expect(h.sampled).toEqual(["UPLOAD-1"]);
		const gone = await failure(
			suggestMapping(h.deps, { collection: "products", locale: "en", uploadId: "GONE", ai: false }),
		);
		expect(gone.code).toBe("UPLOAD_NOT_FOUND");
	});

	it("samples a source's stored copy, fetching only without one (plan Ruling 6)", async () => {
		const h = harness();
		const lastFetch = { at: "x", status: 200, sha256: "s", bytes: 1, uploadId: "UPLOAD-1" };
		h.sources.set("S1", sourceRow("S1", { lastFetch }));
		await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			sourceId: "S1",
			ai: false,
		});
		expect([h.sampled, h.fetched]).toEqual([["UPLOAD-1"], []]);
		h.uploads.delete("UPLOAD-1");
		await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			sourceId: "S1",
			ai: false,
		});
		expect(h.fetched).toEqual([["S1", true]]);
		h.sources.set("S2", sourceRow("S2"));
		await suggestMapping(h.deps, {
			collection: "products",
			locale: "en",
			sourceId: "S2",
			ai: false,
		});
		expect(h.fetched.at(-1)).toEqual(["S2", false]);
		const missing = await failure(
			suggestMapping(h.deps, { collection: "products", locale: "en", sourceId: "S9", ai: false }),
		);
		expect([missing.code, missing.status, missing.message]).toEqual([
			"SOURCE_NOT_FOUND",
			404,
			"Source S9 not found",
		]);
	});

	it("answers a source deleted during the fetch as SOURCE_NOT_FOUND, and passes other fetch codes", async () => {
		const h = harness();
		h.sources.set("S2", sourceRow("S2"));
		h.deps.fetchSource = async (id) => {
			throw new ServiceError("NOT_FOUND", `Source ${id} not found`, 404);
		};
		const gone = await failure(
			suggestMapping(h.deps, { collection: "products", locale: "en", sourceId: "S2", ai: false }),
		);
		expect([gone.code, gone.status, gone.message]).toEqual([
			"SOURCE_NOT_FOUND",
			404,
			"Source S2 not found",
		]);
		h.deps.fetchSource = async () => {
			throw new ServiceError("CREDENTIAL_MISSING", 'Credential "c" does not exist', 409);
		};
		const cred = await failure(
			suggestMapping(h.deps, { collection: "products", locale: "en", sourceId: "S2", ai: false }),
		);
		expect(cred.code).toBe("CREDENTIAL_MISSING");
	});

	it("refuses an unknown collection, a mismatched or invalid base template and a stale revision", async () => {
		const h = harness();
		const nope = await failure(suggestMapping(h.deps, { ...TEXT, collection: "nope" }));
		expect([nope.code, nope.status, nope.message]).toEqual([
			"COLLECTION_NOT_FOUND",
			404,
			'Collection "nope" does not exist',
		]);
		const other = {
			version: 1,
			collection: "posts",
			locale: "en",
			key: { from: "sku" },
			fields: { title: { from: "Name", type: "text" } },
		};
		const mismatch = await failure(
			suggestMapping(h.deps, { collection: "products", text: csv(), template: other }),
		);
		expect([mismatch.code, mismatch.status, mismatch.message]).toEqual([
			"COLLECTION_MISMATCH",
			400,
			'The base template imports into "posts", not "products"',
		]);
		const invalid = await failure(
			suggestMapping(h.deps, { collection: "products", text: csv(), template: { version: 2 } }),
		);
		expect([invalid.code, invalid.status, invalid.message]).toEqual([
			"INVALID_TEMPLATE",
			400,
			"The base template has problems; fix them first",
		]);
		expect(invalid.details?.problems).toEqual(expect.arrayContaining([expect.any(String)]));
		const missing = await failure(
			suggestMapping(h.deps, { collection: "products", text: csv(), templateId: "T404" }),
		);
		expect(missing.code).toBe("TEMPLATE_NOT_FOUND");
		await h.saved.put("T1", {
			id: "T1",
			revision: 2,
			template: { ...other, collection: "products" },
		} as never);
		const stale = await failure(
			suggestMapping(h.deps, {
				collection: "products",
				text: csv(),
				templateId: "T1",
				templateRevision: 1,
			}),
		);
		expect(stale.code).toBe("TEMPLATE_CHANGED");
	});

	it("keeps a base template's mappings and source, and warns about an unmapped required field", async () => {
		const h = harness();
		const base = {
			version: 1,
			source: { format: "csv" },
			collection: "products",
			locale: "fr",
			key: { from: "sku" },
			fields: { price: { from: "Name", type: "number" } },
		};
		const out = await suggestMapping(h.deps, {
			collection: "products",
			text: "sku,Other\r\n1,x\r\n",
			template: base,
			ai: false,
		});
		expect(out.fields.find((f) => f.field === "price")).toMatchObject({
			from: "Name",
			origin: "template",
			confidence: 1,
		});
		expect(out.template).toMatchObject({ locale: "fr", key: { from: "sku" } });
		expect(out.warnings).toContainEqual({ code: "required_unmapped", fields: ["title"] });
		expect(out.unmapped).toEqual({ fields: ["title", "released", "body"], keys: ["Other"] });
	});
});

describe("templates/suggest's unmapped lists (plan Ruling 18)", () => {
	it("never lists the key column as unmapped, even when no draft could be built", async () => {
		const h = harness();
		h.deps.readCollection = async () => ({
			label: "P",
			fields: [{ slug: "price", label: "Price", type: "number" }],
		});
		const out = await suggestMapping(h.deps, { ...TEXT, text: "sku,Other\r\nA,x\r\n", ai: false });
		expect(out.template).toBeNull();
		expect(out.warnings).toContainEqual({ code: "no_field_matched" });
		expect(out.key.from).toBe("sku");
		expect(out.unmapped).toEqual({ fields: ["price"], keys: ["Other"] });
	});
});

describe("templates/suggest's key cap (final review)", () => {
	/** `sku`, then `n` headers over 200 characters (never sent), then `Name`. */
	const wide = (n: number) => {
		const long = Array.from(
			{ length: n },
			(_, i) => `${"y".repeat(197)}${String(i).padStart(4, "0")}`,
		);
		const headers = ["sku", ...long, "Name"];
		return `${headers.join(",")}\r\n${headers.map((_, i) => `v${i}`).join(",")}\r\n`;
	};

	it("matches and sends the 1,000th key, with no keys_not_matched", async () => {
		const h = harness();
		const out = await suggestMapping(h.deps, { ...TEXT, text: wide(998) });
		expect(payloadOf(h.requests[0] as ProviderRequest).source.keys).toEqual(["sku", "Name"]);
		expect(out.warnings).toContainEqual({ code: "keys_not_sent", count: 998 });
		expect(out.warnings.map((w) => w.code)).not.toContain("keys_not_matched");
	});

	it("never matches or sends a key past the 1,000th, and counts it in keys_not_matched", async () => {
		const h = harness({
			outcome: { ...VALID, value: { key: null, slug: null, fields: [item("title", "Name")] } },
		});
		const out = await suggestMapping(h.deps, { ...TEXT, text: wide(999) });
		expect(payloadOf(h.requests[0] as ProviderRequest).source.keys).toEqual(["sku"]);
		expect(out.warnings).toContainEqual({ code: "keys_not_matched", count: 1 });
		// The keys not sent are counted among the matched keys only.
		expect(out.warnings).toContainEqual({ code: "keys_not_sent", count: 999 });
		// The reply's item for Name names a key that was never sent.
		expect(out.warnings).toContainEqual({ code: "ai_unknown_key", count: 1 });
		expect(out.fields.find((f) => f.field === "title")?.from).toBeNull();
		// unmapped.keys lists sample keys whatever their position, the first 100.
		expect(out.unmapped.keys).toHaveLength(100);
		const named = await suggestMapping(harness().deps, { ...TEXT, text: wide(999), ai: false });
		expect(named.fields.find((f) => f.field === "title")?.from).toBeNull();
		expect(named.warnings).toContainEqual({ code: "keys_not_matched", count: 1 });
	});
});

describe("templates/suggest's sample_trimmed (spec Ruling 88, final review)", () => {
	/** 60 free keys of 200-character values: over 48 KiB until values are cut to 80. */
	const heavy = (() => {
		const headers = ["sku", "Name", ...Array.from({ length: 60 }, (_, i) => `Extra ${i}`)];
		const rows = Array.from({ length: 5 }, (_, r) =>
			headers.map((_, i) => (i < 2 ? `R${r}-${i}` : "v".repeat(200))).join(","),
		);
		return `${headers.join(",")}\r\n${rows.join("\r\n")}\r\n`;
	})();
	const HEAVY: SuggestInput = { ...TEXT, text: heavy };

	it.each([
		["an answered call", (_h: ReturnType<typeof harness>) => {}],
		[
			"a provider port that rejects",
			(h: ReturnType<typeof harness>) => {
				h.deps.callProvider = () => Promise.reject(new Error("boom"));
			},
		],
	])("reports sample_trimmed for %s", async (_name, arrange) => {
		const h = harness();
		arrange(h);
		const out = await suggestMapping(h.deps, HEAVY);
		expect(out.sent).not.toBeNull();
		expect(out.warnings).toContainEqual({ code: "sample_trimmed" });
	});

	it.each([
		[
			"a used-up hour",
			"ai_rate_limited",
			(h: ReturnType<typeof harness>) => {
				h.kvStore.put(AI_USAGE_KEY, { hour: "2026-11-19T10", count: 30 });
			},
		],
		[
			"a KV error",
			"ai_rate_limited",
			(h: ReturnType<typeof harness>) => {
				h.deps.kv = {
					...h.deps.kv,
					getVersioned: async () => {
						throw new Error("D1_ERROR: database is locked");
					},
				};
			},
		],
		[
			"a blocked URL",
			"ai_url_blocked",
			(h: ReturnType<typeof harness>) => {
				h.deps.callProvider = async () => ({ ok: false, code: "ai_url_blocked" });
			},
		],
	])("reports no sample_trimmed after %s (%s): nothing was sent", async (_name, code, arrange) => {
		const h = harness();
		arrange(h);
		const out = await suggestMapping(h.deps, HEAVY);
		expect(out.sent).toBeNull();
		expect(out.warnings).toContainEqual({ code });
		expect(out.warnings.map((w) => w.code)).not.toContain("sample_trimmed");
	});
});

describe("templates/suggest's settings read failure (final review)", () => {
	it("answers ai: false with available false when aiProvider cannot be read", async () => {
		const h = harness({ settings: { aiProvider: new Error("D1_ERROR: database is locked") } });
		const out = await suggestMapping(h.deps, { ...TEXT, ai: false });
		expect(out.ai).toEqual({ available: false });
		expect(out).toMatchObject({ method: "fallback", sent: null, key: { from: "sku" } });
		expect(out.template).not.toBeNull();
		expect(h.logged[0]).not.toContain("D1_ERROR");
		// With ai: true the failure is still a route error (spec Open issues).
		await expect(suggestMapping(h.deps, TEXT)).rejects.toThrow("D1_ERROR");
	});
});

describe("readSuggestCollection (spec step 3)", () => {
	it("reads the collection's label and each field's, from one registry read", async () => {
		let reads = 0;
		const registry = {
			getCollectionWithFields: async (slug: string) => {
				reads++;
				return slug === "products"
					? {
							label: "Products",
							fields: [{ slug: "title", label: "Title", type: "string", required: true }],
						}
					: null;
			},
		};
		expect(await readSuggestCollection(registry as never, "products")).toEqual({
			label: "Products",
			fields: [
				{
					slug: "title",
					label: "Title",
					type: "string",
					required: true,
					hasDefault: false,
					validation: {},
				},
			],
		});
		expect(await readSuggestCollection(registry as never, "nope")).toBeNull();
		expect(reads).toBe(2);
	});
});
