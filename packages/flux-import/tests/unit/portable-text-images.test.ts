import { portableTextToProsemirror, prosemirrorToPortableText } from "emdash";
import { describe, expect, it } from "vitest";
import { canonicalPortableText } from "../../src/engine/diff.js";
import { type MediaContext, MediaDeferred, resolveMedia } from "../../src/engine/media.js";
import {
	convertPortableText,
	type PortableTextDraft,
	type PortableTextOptions,
} from "../../src/engine/portable-text.js";
import {
	lookupPortableTextImages,
	obtainPortableTextImages,
	portableTextPlan,
} from "../../src/engine/portable-text-images.js";
import { MediaUploadError } from "../../src/engine/ports.js";
import { COST_CALL, COST_MEDIA, LookupCache } from "../../src/engine/resolve.js";
import { makeDeps } from "./fakes.js";

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const url = (name: string) => `https://cdn.test/${name}`;
const HTML: PortableTextOptions = {
	format: "html",
	baseUrl: null,
	images: "import",
	imageErrors: "drop",
	unknownMarkup: "warn",
};

function draft(html: string): PortableTextDraft {
	const converted = convertPortableText(html, HTML);
	if (converted.draft === null) throw new Error("empty");
	return converted.draft;
}

function setup(ctx: Partial<MediaContext> = {}) {
	const { deps, clock } = makeDeps();
	for (const [i, name] of ["a.png", "b.png", "c.png"].entries()) {
		deps.mediaFetcher.files.set(url(name), { body: png(i), contentType: "image/png" });
	}
	const context: MediaContext = { jobId: "j1", dryRun: false, maxBytes: 1000, targets: {}, ...ctx };
	return { deps, clock, ctx: context };
}

const options = (fail: string[] = []) =>
	new Map(
		["body", "summary"].map((f) => [
			f,
			{ ...HTML, imageErrors: fail.includes(f) ? ("fail" as const) : ("drop" as const) },
		]),
	);

describe("Portable Text images", () => {
	it("uses map hits without downloading and assembles EmDash's image block", async () => {
		const { deps, ctx } = setup();
		await resolveMedia(deps, new LookupCache(), ctx, "photo", {
			kind: "image",
			url: url("a.png"),
			alt: null,
			refresh: false,
		});
		const drafts = {
			body: draft(
				`<p>Hi</p><figure><a href="https://x.test/" target="_blank"><img src="${url("a.png")}" alt="A"></a><figcaption>Cap</figcaption></figure>`,
			),
		};
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		expect(looked.errors).toEqual([]);
		expect(cache.spent).toBe(2 * COST_CALL);
		expect(portableTextPlan(drafts, looked.images)).toEqual({
			body: {
				blocks: [
					{
						_type: "block",
						_key: "b0",
						style: "normal",
						children: [{ _type: "span", _key: "b0s0", text: "Hi", marks: [] }],
					},
					{
						_type: "image",
						_key: "b1",
						asset: { _ref: "m1", url: "/_emdash/api/media/file/K1.png" },
						alt: "A",
						caption: "Cap",
						width: 4,
						height: 3,
						link: { href: "https://x.test/", blank: true },
					},
				],
				pending: 0,
				text: "2 blocks, 1 image",
			},
		});
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("plans a miss as pending without downloading in a dry run", async () => {
		const { deps, ctx } = setup({ dryRun: true });
		const drafts = { body: draft(`<p>t</p><img src="${url("a.png")}">`), summary: null };
		const looked = await lookupPortableTextImages(deps, new LookupCache(), ctx, drafts, options());
		expect([...looked.images.lookups.keys()]).toEqual([url("a.png")]);
		expect(portableTextPlan(drafts, looked.images)).toEqual({
			body: {
				blocks: [drafts.body.blocks[0]],
				pending: 1,
				text: "2 blocks, 1 image (1 new)",
			},
			summary: null,
		});
		expect(deps.mediaFetcher.urls()).toEqual([]);
	});

	it("downloads each URL once in document order, across fields, and lists it under its first field", async () => {
		const { deps, ctx } = setup();
		const drafts = {
			body: draft(
				`<img src="${url("b.png")}"><img src="${url("a.png")}" alt="first"><img src="${url("b.png")}">`,
			),
			summary: draft(`<img src="${url("a.png")}" alt="second"><img src="${url("c.png")}">`),
		};
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		const newMedia = ["photo: https://cdn.test/photo.png"];
		const obtained = await obtainPortableTextImages(
			deps,
			cache,
			ctx,
			looked.images,
			options(),
			newMedia,
		);
		expect(obtained).toEqual({ ok: true, warnings: [] });
		expect(deps.mediaFetcher.urls()).toEqual([url("b.png"), url("a.png"), url("c.png")]);
		expect(newMedia).toEqual([
			"photo: https://cdn.test/photo.png",
			`body: ${url("b.png")}`,
			`body: ${url("a.png")}`,
			`summary: ${url("c.png")}`,
		]);
		// A new item takes the alt of the URL's first image as its library alt.
		expect(deps.media.items.get("m2")?.alt).toBe("first");
		const plan = portableTextPlan(drafts, looked.images);
		expect(plan.summary?.blocks).toEqual([
			{
				_type: "image",
				_key: "b0",
				asset: { _ref: "m2", url: "/_emdash/api/media/file/K2.png" },
				alt: "second",
				width: 4,
				height: 3,
			},
			{
				_type: "image",
				_key: "b1",
				asset: { _ref: "m3", url: "/_emdash/api/media/file/K3.png" },
				width: 4,
				height: 3,
			},
		]);
		expect(cache.spent).toBe(3 * COST_CALL + 3 * COST_MEDIA);
	});

	it("drops an image that cannot be imported with a warning, or fails the record", async () => {
		const { deps, ctx } = setup();
		deps.mediaFetcher.blocked.add("blocked.test");
		const html = `<p>t</p><img src="https://blocked.test/x.png"><img src="${url("missing.png")}"><img src="${url("a.png")}">`;
		const drafts = { body: draft(html) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		expect(looked.errors).toEqual([]);
		expect(looked.warnings).toEqual([
			{
				field: "body",
				code: "image_dropped",
				message: "media_blocked: https://blocked.test/x.png: The host blocked.test is not allowed",
			},
		]);
		const obtained = await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		expect(obtained).toEqual({
			ok: true,
			warnings: [
				{
					field: "body",
					code: "image_dropped",
					message: `media_http_error: ${url("missing.png")}: The server answered HTTP 404`,
				},
			],
		});
		expect(portableTextPlan(drafts, looked.images).body?.text).toBe("2 blocks, 1 image");

		const strict = await lookupPortableTextImages(
			deps,
			new LookupCache(),
			ctx,
			drafts,
			options(["body"]),
		);
		expect(strict.errors).toEqual([
			{
				field: "body",
				code: "media_blocked",
				message: "https://blocked.test/x.png: The host blocked.test is not allowed",
			},
		]);
		const failing = { body: draft(`<img src="${url("missing.png")}"><img src="${url("c.png")}">`) };
		const next = new LookupCache();
		const found = await lookupPortableTextImages(deps, next, ctx, failing, options(["body"]));
		expect(
			await obtainPortableTextImages(deps, next, ctx, found.images, options(["body"]), []),
		).toEqual({
			ok: false,
			errors: [
				{
					field: "body",
					code: "media_http_error",
					message: `${url("missing.png")}: The server answered HTTP 404`,
				},
			],
			warnings: [],
		});
		// It stopped at the first failure.
		expect(deps.mediaFetcher.urls().filter((u) => u === url("c.png"))).toEqual([]);
	});

	it("leaves a field with only dropped images empty", async () => {
		const { deps, ctx } = setup();
		const drafts = { body: draft(`<img src="${url("missing.png")}">`) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		expect(portableTextPlan(drafts, looked.images)).toEqual({ body: null });
	});

	it("defers by deadline and by budget, never the batch's first download, carrying newMedia", async () => {
		const { deps, ctx, clock } = setup();
		const drafts = { body: draft(`<img src="${url("a.png")}"><img src="${url("b.png")}">`) };
		const byBudget = new LookupCache([], 100);
		const looked = await lookupPortableTextImages(deps, byBudget, ctx, drafts, options());
		const newMedia = ["photo: x"];
		const deferred = await obtainPortableTextImages(
			deps,
			byBudget,
			ctx,
			looked.images,
			options(),
			newMedia,
		).catch((e: unknown) => e);
		expect(deferred).toBeInstanceOf(MediaDeferred);
		expect((deferred as MediaDeferred).newMedia).toEqual(["photo: x", `body: ${url("a.png")}`]);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);

		const byDeadline = new LookupCache();
		byDeadline.mediaDeadline = clock.t + 1000;
		byDeadline.mediaDownloads = 1;
		const again = await lookupPortableTextImages(deps, byDeadline, ctx, drafts, options());
		await expect(
			obtainPortableTextImages(deps, byDeadline, ctx, again.images, options(), []),
		).rejects.toBeInstanceOf(MediaDeferred);
		expect(deps.mediaFetcher.urls()).toEqual([url("a.png")]);
	});

	it("fails the record when any field using a shared URL says fail", async () => {
		const { deps, ctx } = setup();
		const html = `<img src="${url("missing.png")}">`;
		const drafts = { body: draft(html), summary: draft(html) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options(["summary"]));
		const obtained = await obtainPortableTextImages(
			deps,
			cache,
			ctx,
			looked.images,
			options(["summary"]),
			[],
		);
		expect(obtained).toEqual({
			ok: false,
			errors: [
				{
					field: "summary",
					code: "media_http_error",
					message: `${url("missing.png")}: The server answered HTTP 404`,
				},
			],
			warnings: [],
		});
	});

	it("completes a record of many failing images across deferred batches, fetching each once", async () => {
		const { deps, ctx } = setup({ maxBytes: 1000 });
		let html = "";
		for (let i = 0; i < 10; i++) html += `<img src="${url(`missing${i}.png`)}">`;
		const drafts = { body: draft(html) };
		let carried: MediaDeferred["failed"] = [];
		let batches = 0;
		let result: Awaited<ReturnType<typeof obtainPortableTextImages>> | undefined;
		while (result === undefined && batches < 6) {
			batches++;
			const cache = new LookupCache([], 600);
			cache.spend(25);
			for (const { key, error } of carried) cache.mediaFailed.set(key, error);
			const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
			try {
				result = await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
			} catch (e) {
				if (!(e instanceof MediaDeferred)) throw e;
				const merged = new Map([...carried, ...e.failed].map((f) => [f.key, f] as const));
				carried = [...merged.values()];
			}
		}
		expect(result).toMatchObject({ ok: true });
		expect(batches).toBeLessThanOrEqual(3);
		expect(deps.mediaFetcher.urls()).toHaveLength(10);
		expect(new Set(deps.mediaFetcher.urls()).size).toBe(10);
	});

	it("fails the job when EmDash cannot store media, whatever imageErrors says", async () => {
		const { deps, ctx } = setup();
		deps.media.failUpload = () => new MediaUploadError("NO_STORAGE", "Storage not configured");
		const drafts = { body: draft(`<img src="${url("a.png")}">`) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await expect(
			obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []),
		).rejects.toMatchObject({ name: "ContentWriteError", code: "media_config" });
	});

	it("survives an editor round trip unchanged (Fact V2)", async () => {
		const { deps, ctx } = setup();
		const html = `<h2>T <em>i</em></h2><p>a <strong>b</strong> <a href="https://x.test/" target="_blank">l</a> <a href="https://x.test/2">m</a><br>c</p><ul><li>1<ul><li>2</li></ul></li></ul><ol><li>n</li></ol><blockquote>q</blockquote><pre class="language-js">x\n</pre><hr><figure><a href="https://x.test/big"><img src="${url("a.png")}" alt="A"></a><figcaption>C</figcaption></figure>`;
		const drafts = { body: draft(html) };
		const cache = new LookupCache();
		const looked = await lookupPortableTextImages(deps, cache, ctx, drafts, options());
		await obtainPortableTextImages(deps, cache, ctx, looked.images, options(), []);
		const value = portableTextPlan(drafts, looked.images).body?.blocks ?? [];
		const edited = JSON.parse(
			JSON.stringify(prosemirrorToPortableText(portableTextToProsemirror(value as never))),
		);
		expect(edited).not.toEqual(value);
		expect(canonicalPortableText(edited)).toEqual(canonicalPortableText(value));
	});
});
