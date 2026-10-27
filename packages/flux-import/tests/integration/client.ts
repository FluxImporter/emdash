import type { Job, RecordRow } from "../../src/engine/types.js";

type Envelope<T> =
	| { success: true; data: T }
	| { success: false; error: { code: string; message: string } };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(`${status} ${code}: ${message}`);
	}
}

/** Admin PAT from the dev-only setup bypass (verification report, question 9). */
export async function devBypass(baseUrl: string): Promise<string> {
	const res = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass?token=1&content=0`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	const body = (await res.json()) as Envelope<{ token: string }>;
	if (!body.success) throw new ApiError(res.status, body.error.code, body.error.message);
	return body.data.token;
}

export interface Product {
	id: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	draftRevisionId: string | null;
	liveRevisionId: string | null;
	/** Reference selections (the first page), a staged draft selection first. */
	references?: Record<string, { children: { id: string; translationGroup: string | null }[] }>;
	bylines?: { byline: { slug: string }; roleLabel: string | null; source: string }[];
}

/** HTTP client for the dev site with an Admin PAT (Bearer tokens skip the CSRF header). */
export class Client {
	constructor(
		readonly baseUrl: string,
		readonly token: string,
	) {}

	async raw(
		method: string,
		path: string,
		body?: unknown,
		init: RequestInit = {},
	): Promise<Response> {
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(init.headers as Record<string, string> | undefined),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.raw(method, path, body);
		const json = (await res.json()) as Envelope<T>;
		if (!json.success) throw new ApiError(res.status, json.error.code, json.error.message);
		return json.data;
	}

	plugin<T = Job>(route: string, input: unknown = {}): Promise<T> {
		return this.api<T>("POST", `/_emdash/api/plugins/flux-import/${route}`, input);
	}

	async upload(csv: string | Uint8Array<ArrayBuffer>, filename = "data.csv") {
		const res = await this.uploadRaw(csv, filename);
		const json = (await res.json()) as Envelope<{
			uploadId: string;
			bytes: number;
			sha256: string;
		}>;
		if (!json.success) throw new ApiError(res.status, json.error.code, json.error.message);
		return json.data;
	}

	/** Stages pasted text through the `sources/paste` route. */
	paste(format: "csv" | "json" | "jsonl" | "xml", text: string) {
		return this.plugin<{ uploadId: string; bytes: number; sha256: string }>("sources/paste", {
			format,
			text,
		});
	}

	async uploadRaw(
		body: string | Uint8Array<ArrayBuffer>,
		filename = "data.csv",
	): Promise<Response> {
		return fetch(
			`${this.baseUrl}/_emdash/api/flux-import/uploads?filename=${encodeURIComponent(filename)}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "text/csv" },
				body,
			},
		);
	}

	/** Creates a revisioned collection with edit locking and the fields the template maps. */
	async createProducts(slug: string): Promise<void> {
		await this.createCollection(slug);
		for (const field of [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "price", label: "Price", type: "number" },
			{ slug: "released", label: "Released", type: "datetime" },
		]) {
			await this.api("POST", `/_emdash/api/schema/collections/${slug}/fields`, field);
		}
	}

	/** Creates a revisioned collection with edit locking and no fields. */
	async createCollection(slug: string): Promise<void> {
		await this.api("POST", "/_emdash/api/schema/collections", {
			slug,
			label: slug,
			supports: ["drafts", "revisions"],
			editLocking: true,
		});
	}

	async fields(
		collection: string,
	): Promise<{ slug: string; type: string; required: boolean; validation?: unknown }[]> {
		const data = await this.api<{
			item: { fields: { slug: string; type: string; required: boolean; validation?: unknown }[] };
		}>("GET", `/_emdash/api/schema/collections/${collection}?includeFields=true`);
		return data.item.fields;
	}

	async fieldSlugs(collection: string): Promise<string[]> {
		return (await this.fields(collection)).map((f) => f.slug);
	}

	/** Changes a field through the admin API (`PUT …/fields/:field`; `validation` is required). */
	async updateField(
		collection: string,
		field: string,
		body: { required?: boolean; validation: Record<string, unknown> | null },
	): Promise<void> {
		await this.api("PUT", `/_emdash/api/schema/collections/${collection}/fields/${field}`, body);
	}

	async listAll(collection: string): Promise<Product[]> {
		const items: Product[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.api<{ items: Product[]; nextCursor?: string }>(
				"GET",
				`/_emdash/api/content/${collection}?locale=en&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor);
		return items;
	}

	async getEntry(collection: string, id: string) {
		return this.api<{ item: Product; _rev: string }>(
			"GET",
			`/_emdash/api/content/${collection}/${id}?locale=en`,
		);
	}

	/** The slugs of the entry's terms in one taxonomy. */
	async entryTerms(collection: string, id: string, taxonomy: string): Promise<string[]> {
		const data = await this.api<{ terms: { slug: string }[] }>(
			"GET",
			`/_emdash/api/content/${collection}/${id}/terms/${taxonomy}`,
		);
		return data.terms.map((t) => t.slug);
	}

	async runToEnd(id: string, maxBatches = 1000): Promise<Job> {
		for (let i = 0; i < maxBatches; i++) {
			const job = await this.plugin("jobs/next", { id });
			if (job.status !== "running" && job.status !== "created") return job;
		}
		throw new Error(`Job ${id} did not finish in ${maxBatches} batches`);
	}

	async records(id: string, status?: string): Promise<RecordRow[]> {
		const rows: RecordRow[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.plugin<{ items: RecordRow[]; cursor?: string; hasMore: boolean }>(
				"jobs/records",
				{ id, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
			);
			rows.push(...page.items);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
		return rows;
	}
}
