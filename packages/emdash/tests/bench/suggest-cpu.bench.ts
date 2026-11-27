/**
 * CPU micro-benchmark of name matching (`templates/suggest` without a provider), by hand from
 * packages/emdash, not part of the test suites:
 *   BENCH=realistic npx vitest run --config vitest.bench.config.ts --disableConsoleIntercept
 * `BENCH_PROFILE=<file>.cpuprofile` also writes a CPU profile.
 */
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { it } from "vitest";
import type { SuggestCollection } from "../../src/emdash/schema.js";
import {
	createMapper,
	eligibleFields,
	type Sample,
	suggestByName,
} from "../../src/engine/suggest.js";
import { type SuggestDeps, suggestMapping, toSample } from "../../src/plugin/suggest.js";
import { readCsvSample } from "../../src/sources/csv.js";
import { templateSetup } from "../unit/templates-fixture.js";

const cpu = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};

/** A realistic 30-column product feed, 20 rows. */
const HEADERS = [
	"id",
	"sku",
	"title",
	"handle",
	"description",
	"short_description",
	"price",
	"sale_price",
	"cost",
	"stock_quantity",
	"weight",
	"published",
	"created_at",
	"updated_at",
	"release_date",
	"image_url",
	"gallery",
	"category",
	"tags",
	"brand",
	"vendor",
	"status",
	"color",
	"size",
	"barcode",
	"rating",
	"reviews_count",
	"featured",
	"seo_title",
	"seo_description",
];
function realisticCsv(): string {
	let out = `${HEADERS.join(",")}\r\n`;
	for (let i = 0; i < 20; i++) {
		const d = String((i % 28) + 1).padStart(2, "0");
		out += [
			i + 1,
			`SKU-${i}`,
			`Product ${i}`,
			`product-${i}`,
			`"<p>Long text ${i}</p>"`,
			`Short ${i}`,
			`${i}.99`,
			`${i}.49`,
			`${i}.10`,
			i * 3,
			`${i}.5`,
			i % 2 === 0 ? "true" : "false",
			`2026-03-${d}T10:00:00Z`,
			`2026-04-${d} 12:30:00`,
			`${d}/05/2026`,
			`https://example.com/img/${i}.jpg`,
			`"https://example.com/a${i}.jpg,https://example.com/b${i}.jpg"`,
			i % 3 === 0 ? "Chairs" : "Desks",
			`"new,sale"`,
			"Acme",
			"Acme Ltd",
			i % 2 === 0 ? "active" : "draft",
			"red",
			"L",
			`40000000${String(i).padStart(5, "0")}`,
			`${(i % 5) + 1}`,
			i * 7,
			i % 4 === 0 ? "yes" : "no",
			`SEO ${i}`,
			`SEO description ${i}`,
		].join(",");
		out += "\r\n";
	}
	return out;
}
const REALISTIC: SuggestCollection = {
	label: "Products",
	fields: [
		{ slug: "title", label: "Title", type: "string", required: true },
		{ slug: "slug_field", label: "Permalink", type: "slug" },
		{ slug: "body", label: "Body", type: "portableText" },
		{ slug: "excerpt", label: "Excerpt", type: "text" },
		{ slug: "price", label: "Price", type: "number" },
		{ slug: "sale_price", label: "Sale price", type: "number" },
		{ slug: "quantity", label: "Quantity", type: "integer" },
		{ slug: "weight", label: "Weight", type: "number" },
		{ slug: "published_at", label: "Published at", type: "datetime" },
		{ slug: "updated_at", label: "Updated at", type: "datetime" },
		{ slug: "release_date", label: "Release date", type: "datetime" },
		{ slug: "image", label: "Image", type: "image" },
		{ slug: "brand", label: "Brand", type: "string" },
		{
			slug: "status",
			label: "Status",
			type: "select",
			validation: { options: ["active", "draft", "archived"] },
		},
		{ slug: "featured", label: "Featured", type: "boolean" },
		{ slug: "color", label: "Colour", type: "string" },
		{ slug: "barcode", label: "Barcode", type: "string" },
		{ slug: "rating", label: "Rating", type: "number" },
		{ slug: "seo_title", label: "SEO title", type: "string" },
		{ slug: "seo_description", label: "SEO description", type: "text" },
	] as SuggestCollection["fields"],
};

/**
 * The spec's worst case (M6d Rulings 99, 100): N keys that each name-match every datetime field
 * (`Release date 7` against `Release date a`: half their words shared), 20 date-like values each.
 */
function worstCsv(keys: number): string {
	const headers = Array.from({ length: keys }, (_, i) => `Release date ${i}`);
	let out = `${headers.join(",")}\r\n`;
	for (let r = 0; r < 20; r++) {
		const d = String((r % 28) + 1).padStart(2, "0");
		out += `${headers.map(() => `${d}/03/2026`).join(",")}\r\n`;
	}
	return out;
}
function worstCollection(n: number): SuggestCollection {
	return {
		label: "Posts",
		fields: Array.from({ length: n }, (_, i) => ({
			slug: `release_date_${String.fromCharCode(97 + (i % 26))}${i >= 26 ? "x" : ""}`,
			label: `Release date ${String.fromCharCode(97 + (i % 26))}${i >= 26 ? "x" : ""}`,
			type: "datetime",
		})) as SuggestCollection["fields"],
	};
}

function deps(collection: SuggestCollection): SuggestDeps {
	const { deps: templates } = templateSetup({ collections: { products: collection.fields } });
	return {
		settings: { get: async () => "none" as never },
		kv: {
			getVersioned: async () => null as never,
			compareAndSet: async () => true as never,
		},
		templates,
		readCollection: async () => collection,
		sampleUpload: async () => {
			throw new Error("unused");
		},
		getSource: async () => null,
		fetchSource: async () => {
			throw new Error("unused");
		},
		allowPrivateNetwork: false,
		net: {
			allowPrivateNetwork: false,
			resolver: async () => [],
			fetch: async () => new Response(),
		},
		callProvider: async () => {
			throw new Error("unused");
		},
		log: { info: () => {} },
		now: () => 0,
	};
}

async function sampleOf(text: string): Promise<Sample> {
	return toSample(await readCsvSample(new Blob([text]).stream(), 20), "csv");
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * CPU time of one scenario: the whole route's first call in this process (a fresh isolate's first
 * request pays it), then medians of warm calls of name matching alone and of the whole route.
 */
async function measure(label: string, text: string, collection: SuggestCollection, runs: number) {
	const d = deps(collection);
	const input = { collection: "products", locale: "en", text, ai: false };
	let t = cpu();
	await suggestMapping(d, input);
	const cold = cpu() - t;
	const sample = await sampleOf(text);
	const { eligible } = eligibleFields(collection.fields as never);
	const matchTimes: number[] = [];
	const routeTimes: number[] = [];
	for (let i = 0; i < runs; i++) {
		t = cpu();
		suggestByName(eligible, sample, { mapper: createMapper(sample) });
		matchTimes.push(cpu() - t);
		t = cpu();
		await suggestMapping(d, input);
		routeTimes.push(cpu() - t);
	}
	const ms = (n: number) => `${n.toFixed(2)} ms`;
	console.log(
		`${label}: route cold ${ms(cold)}; warm medians: name matching ${ms(median(matchTimes))}, route ${ms(median(routeTimes))}`,
	);
}

/** BENCH picks one scenario (realistic, keys200, keys1000); each runs in a fresh process. */
it("measures", async () => {
	const which = process.env.BENCH ?? "realistic";
	const profile = process.env.BENCH_PROFILE;
	const session = profile ? new Session() : null;
	if (session) {
		session.connect();
		await session.post("Profiler.enable");
		await session.post("Profiler.setSamplingInterval", { interval: 50 });
		await session.post("Profiler.start");
	}
	if (which === "realistic") {
		await measure(
			"30 keys x 20 fields",
			realisticCsv(),
			REALISTIC,
			Number(process.env.BENCH_RUNS ?? 41),
		);
	}
	if (which === "keys200") {
		await measure("200 date keys x 30 datetime fields", worstCsv(200), worstCollection(30), 11);
	}
	if (which === "keys1000") {
		await measure("1000 date keys x 30 datetime fields", worstCsv(1000), worstCollection(30), 5);
	}
	if (session && profile) {
		const { profile: taken } = await session.post("Profiler.stop");
		await writeFile(profile, JSON.stringify(taken));
		session.disconnect();
	}
}, 600_000);
