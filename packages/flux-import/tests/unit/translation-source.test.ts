import { describe, expect, it } from "vitest";
import { ContentWriteError } from "../../src/engine/ports.js";
import {
	COST_CALL,
	COST_READ,
	findTranslationSource,
	LookupCache,
	sourceNotFoundMessage,
} from "../../src/engine/resolve.js";
import { linkKey } from "../../src/engine/types.js";
import { makeDeps } from "./fakes.js";

async function setup() {
	const { deps } = makeDeps();
	const desk = await deps.content.create({
		collection: "products",
		locale: "en",
		data: { title: "Desk", flux_source_id: "E1" },
	});
	const fr = await deps.content.create({
		collection: "products",
		locale: "fr",
		data: { title: "Bureau", flux_source_id: "E1" },
	});
	return { deps, desk, fr };
}

const find = (
	deps: ReturnType<typeof makeDeps>["deps"],
	cache: LookupCache,
	key: string,
	locale = "en",
	sourceIdReady = true,
) => findTranslationSource(deps, cache, "products", locale, key, sourceIdReady);

describe("findTranslationSource", () => {
	it("finds the source by the source locale's link row, verified, and caches the hit", async () => {
		const { deps, desk } = await setup();
		await deps.links.put(linkKey("products", "en", "E1"), {
			collection: "products",
			locale: "en",
			sourceKey: "E1",
			entryId: desk.id,
		});
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + COST_READ);
		expect(deps.content.calls).not.toContain("find:E1");
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + COST_READ);
	});

	it("falls back to flux_source_id in the source locale, past a stale link row", async () => {
		const { deps, desk } = await setup();
		await deps.links.put(linkKey("products", "en", "E1"), {
			collection: "products",
			locale: "en",
			sourceKey: "E1",
			entryId: "gone",
		});
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1")).toEqual({ id: desk.id, group: desk.id });
		expect(cache.spent).toBe(COST_CALL + 2 * COST_READ);
		expect(deps.content.calls).toContain("find:E1");
	});

	it("names one locale: an entry of another locale with the same source ID is not it", async () => {
		const { deps, desk, fr } = await setup();
		const cache = new LookupCache();
		expect(await find(deps, cache, "E1", "de")).toBeNull();
		expect(await find(deps, cache, "E1", "fr")).toEqual({ id: fr.id, group: fr.id });
		expect(await find(deps, cache, "E1", "en")).toEqual({ id: desk.id, group: desk.id });
	});

	it("does not cache a miss, and reads link rows only before the source ID field exists", async () => {
		const { deps } = await setup();
		const cache = new LookupCache();
		expect(await find(deps, cache, "E9")).toBeNull();
		expect(await find(deps, cache, "E9")).toBeNull();
		expect(deps.content.calls.filter((c) => c === "find:E9")).toHaveLength(2);
		expect(await find(deps, cache, "E1", "en", false)).toBeNull();
		expect(deps.content.calls).not.toContain("find:E1");
	});

	it("throws an ambiguous source ID for the record to report", async () => {
		const { deps } = await setup();
		deps.content.findBySourceId = async () => {
			throw new ContentWriteError("ambiguous_source_id", "More than one entry");
		};
		await expect(find(deps, new LookupCache(), "E1")).rejects.toMatchObject({
			code: "ambiguous_source_id",
		});
	});

	it("words a missing source like a missing key reference", () => {
		expect(sourceNotFoundMessage("products", "en", "E9")).toBe(
			'No entry in "products" (en) was imported with the key "E9"',
		);
	});
});
