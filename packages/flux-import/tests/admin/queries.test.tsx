import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { uploadFile } from "../../src/admin/api.js";
import {
	JOB_POLL_MS,
	jobPollInterval,
	queryKeys,
	SCHEDULE_IDLE_MS,
	SCHEDULE_POLL_MS,
	schedulePollInterval,
	useAllSources,
	useAllTemplates,
	useCredentials,
	useDryRuns,
	useFence,
	useFields,
	useJobPages,
	useSchedules,
	useSite,
	useTemplate,
} from "../../src/admin/queries.js";
import { MANIFEST, POSTS, UPLOAD_ID } from "./fixtures.js";
import { fail, mockRoutes } from "./harness.js";
import { item, schedule } from "./home-fixtures.js";

/** A QueryClient as the host builds it: `retry: 1` by default (preflight F19), with no delay. */
function hostClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
}

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** Template summaries `from`..`to`-1, as `templates/list` lists them. */
const summaries = (from: number, to: number) =>
	Array.from({ length: to - from }, (_, i) => ({
		id: `T${from + i}`,
		name: `Template ${from + i}`,
	}));

describe("the admin queries", () => {
	it('useAllTemplates("posts") follows the cursor across two pages', async () => {
		const { calls } = mockRoutes({
			"templates/list": (body) =>
				(body as { cursor?: string }).cursor === "c1"
					? { items: summaries(6, 10), hasMore: false }
					: { items: summaries(0, 6), cursor: "c1", hasMore: true },
		});
		const client = hostClient();
		const { result } = renderHook(() => useAllTemplates("posts"), {
			wrapper: wrapperFor(client),
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toHaveLength(10);
		expect(result.current.data?.map((t) => t.id)).toEqual(summaries(0, 10).map((t) => t.id));
		expect(calls.map((c) => c.body)).toEqual([
			{ collection: "posts" },
			{ collection: "posts", cursor: "c1" },
		]);
		expect(client.getQueryData(queryKeys.templates("posts"))).toHaveLength(10);
	});

	it("useAllTemplates() lists every collection's templates", async () => {
		const { calls } = mockRoutes({
			"templates/list": () => ({ items: summaries(0, 2), hasMore: false }),
		});
		const { result } = renderHook(() => useAllTemplates(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(calls.map((c) => c.body)).toEqual([{}]);
	});

	it("useAllSources follows cursors to the end", async () => {
		const pages: Record<string, unknown> = {
			"": { items: [{ id: "S1" }], cursor: "a", hasMore: true },
			a: { items: [{ id: "S2" }], cursor: "b", hasMore: true },
			b: { items: [{ id: "S3" }], hasMore: false },
		};
		const { calls } = mockRoutes({
			"sources/list": (body) => pages[(body as { cursor?: string }).cursor ?? ""],
		});
		const { result } = renderHook(() => useAllSources(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
		expect(calls.map((c) => c.body)).toEqual([{}, { cursor: "a" }, { cursor: "b" }]);
	});

	it.each([
		["useAllSources", "sources/list", (): unknown => useAllSources()],
		["useAllTemplates", "templates/list", (): unknown => useAllTemplates("posts")],
	] as const)("%s stops its cursor walk when the component unmounts", async (_, route, hook) => {
		let release!: () => void;
		const first = new Promise<void>((r) => {
			release = r;
		});
		const { calls } = mockRoutes({
			[route]: async () => {
				await first;
				return { items: [{ id: "A" }], cursor: "next", hasMore: true };
			},
		});
		const { unmount } = renderHook(hook, { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(calls).toHaveLength(1));
		unmount();
		release();
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(1);
	});

	it("useFields(null) makes no request", async () => {
		const { calls } = mockRoutes({});
		const { result } = renderHook(() => useFields(null), { wrapper: wrapperFor(hostClient()) });
		await new Promise((r) => setTimeout(r, 20));
		expect(result.current.fetchStatus).toBe("idle");
		expect(result.current.data).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("useFields(collection) reads the collection's fields", async () => {
		const { calls } = mockRoutes({ "GET collection:posts": () => POSTS });
		const client = hostClient();
		const { result } = renderHook(() => useFields("posts"), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.map((f) => f.slug)).toEqual([
			"title",
			"featured_image",
			"content",
			"excerpt",
		]);
		expect(calls.map((c) => c.path)).toEqual([
			"/_emdash/api/schema/collections/posts?includeFields=true",
		]);
		expect(client.getQueryData(queryKeys.fields("posts"))).toBe(result.current.data);
	});

	it("useSite reads the manifest", async () => {
		mockRoutes({ "GET manifest": () => MANIFEST });
		const { result } = renderHook(() => useSite(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.locales).toEqual(["en", "fr", "de"]);
	});

	it("keeps every key under flux-import", () => {
		const keys = [
			queryKeys.site,
			queryKeys.fields("posts"),
			queryKeys.credentials,
			queryKeys.sources,
			queryKeys.templates(),
			queryKeys.templates("posts"),
		];
		for (const key of keys) expect(key[0]).toBe("flux-import");
		expect(queryKeys.templates()).not.toEqual(queryKeys.templates("posts"));
	});
});

describe("retries under the host's retry: 1 (preflight F19)", () => {
	it("useCredentials sends credentials/list once on a 403", async () => {
		const { calls } = mockRoutes({
			"credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403),
		});
		const { result } = renderHook(() => useCredentials(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toMatchObject({ code: "FORBIDDEN", status: 403 });
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(1);
	});

	it("retries a 503 once, then reports it", async () => {
		const { calls } = mockRoutes({
			"credentials/list": () => fail("HTTP_503", "Busy", 503),
		});
		const { result } = renderHook(() => useCredentials(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isError).toBe(true));
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(2);
	});

	it("succeeds on the retry after a 503", async () => {
		let n = 0;
		mockRoutes({
			"credentials/list": () =>
				++n === 1 ? fail("HTTP_503", "Busy", 503) : [{ name: "c", header: "Authorization" }],
		});
		const { result } = renderHook(() => useCredentials(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual([{ name: "c", header: "Authorization" }]);
	});
});

describe("uploadFile under the admin harness", () => {
	it("uploads through the harness's XMLHttpRequest, with progress and the CSRF header", async () => {
		const file = new File(["id,title\n1,A\n"], "posts.csv", { type: "text/csv" });
		const { calls } = mockRoutes({ upload: () => ({ uploadId: UPLOAD_ID, bytes: file.size }) });
		const progress: number[] = [];
		const result = await uploadFile(file, { onProgress: (sent) => progress.push(sent) });
		expect(result).toEqual({ uploadId: UPLOAD_ID, bytes: file.size });
		expect(progress).toEqual([file.size / 2, file.size]);
		expect(calls.map((c) => c.path)).toEqual([
			"/_emdash/api/flux-import/uploads?filename=posts.csv",
		]);
	});

	it("rejects with the envelope's ApiError, and with an AbortError on abort", async () => {
		mockRoutes({ upload: () => fail("UNSUPPORTED_SOURCE", "Not a source file", 415) });
		await expect(uploadFile(new File(["x"], "notes.txt"))).rejects.toMatchObject({
			code: "UNSUPPORTED_SOURCE",
			status: 415,
		});

		mockRoutes({ upload: () => new Promise(() => {}) });
		const controller = new AbortController();
		const sent = uploadFile(new File(["x"], "posts.csv"), { signal: controller.signal });
		controller.abort();
		await expect(sent).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("the home's queries (M7b)", () => {
	it("keeps the new keys under flux-import", () => {
		expect(queryKeys.jobs).toEqual(["flux-import", "jobs"]);
		expect(queryKeys.dryRuns).toEqual(["flux-import", "dry-runs"]);
		expect(queryKeys.schedules).toEqual(["flux-import", "schedules"]);
		expect(queryKeys.fence).toEqual(["flux-import", "fence"]);
	});

	it("useJobPages fetches the next page with the first page's cursor, real imports only", async () => {
		const { calls } = mockRoutes({
			"jobs/summaries": (body) =>
				(body as { cursor?: string }).cursor === "c1"
					? { items: [item({ id: "J9" })], cursor: "stale", hasMore: false }
					: { items: [item({ id: "J1" }), item({ id: "J2" })], cursor: "c1", hasMore: true },
		});
		const { result } = renderHook(() => useJobPages(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.hasNextPage).toBe(true);
		expect(calls.map((c) => c.body)).toEqual([{ dryRun: false }]);
		await result.current.fetchNextPage();
		await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
		expect(calls.map((c) => c.body)).toEqual([{ dryRun: false }, { dryRun: false, cursor: "c1" }]);
		expect(result.current.data?.pages.flatMap((p) => p.items.map((i) => i.id))).toEqual([
			"J1",
			"J2",
			"J9",
		]);
		expect(result.current.hasNextPage).toBe(false);
	});

	it("useDryRuns reads the first page of dry runs only", async () => {
		const { calls } = mockRoutes({
			"jobs/summaries": () => ({
				items: [item({ id: "D1", dryRun: true })],
				cursor: "c1",
				hasMore: true,
			}),
		});
		const { result } = renderHook(() => useDryRuns(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(calls.map((c) => c.body)).toEqual([{ dryRun: true }]);
		expect(result.current.data?.items.map((i) => i.id)).toEqual(["D1"]);
	});

	it("useSchedules follows two pages", async () => {
		const { calls } = mockRoutes({
			"schedules/list": (body) =>
				(body as { cursor?: string }).cursor === "c1"
					? { items: [schedule({ id: "SC3" })], hasMore: false }
					: {
							items: [schedule({ id: "SC1" }), schedule({ id: "SC2" })],
							cursor: "c1",
							hasMore: true,
						},
		});
		const client = hostClient();
		const { result } = renderHook(() => useSchedules(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.map((s) => s.id)).toEqual(["SC1", "SC2", "SC3"]);
		expect(calls.map((c) => c.body)).toEqual([{}, { cursor: "c1" }]);
		expect(client.getQueryData(queryKeys.schedules)).toHaveLength(3);
	});

	it("useFence reads schedules/fence", async () => {
		const { calls } = mockRoutes({ "schedules/fence": () => ({ fence: "export" }) });
		const { result } = renderHook(() => useFence(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toBe("export");
		expect(calls.map((c) => c.body)).toEqual([{}]);
	});

	it("useTemplate(null) sends nothing; useTemplate(id) reads templates/get", async () => {
		const { calls } = mockRoutes({ "templates/get": () => ({ id: "T1", name: "Feed" }) });
		const idle = renderHook(() => useTemplate(null), { wrapper: wrapperFor(hostClient()) });
		await new Promise((r) => setTimeout(r, 20));
		expect(idle.result.current.fetchStatus).toBe("idle");
		expect(calls).toEqual([]);
		const read = renderHook(() => useTemplate("T1"), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
		expect(calls.map((c) => c.body)).toEqual([{ id: "T1" }]);
	});

	it("useSchedules stops its page walk when the component unmounts", async () => {
		let release!: () => void;
		const first = new Promise<void>((r) => {
			release = r;
		});
		const { calls } = mockRoutes({
			"schedules/list": async () => {
				await first;
				return { items: [schedule()], cursor: "next", hasMore: true };
			},
		});
		const { unmount } = renderHook(() => useSchedules(), { wrapper: wrapperFor(hostClient()) });
		await waitFor(() => expect(calls).toHaveLength(1));
		unmount();
		release();
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(1);
	});

	it("polls jobs every 5 s only while a loaded row is created or running (Ruling 15)", () => {
		const page = (...statuses: ("created" | "running" | "paused" | "completed")[]) => ({
			items: statuses.map((status) => item({ status })),
			hasMore: false,
		});
		expect(JOB_POLL_MS).toBe(5000);
		expect(jobPollInterval(undefined)).toBe(false);
		expect(jobPollInterval({ pages: [page("completed", "paused")] })).toBe(false);
		expect(jobPollInterval({ pages: [page("completed"), page("running")] })).toBe(JOB_POLL_MS);
		expect(jobPollInterval({ pages: [page("created")] })).toBe(JOB_POLL_MS);
	});

	it("polls schedules every 5 s while one is due or current, else every 60 s (Ruling 15)", () => {
		expect(SCHEDULE_POLL_MS).toBe(5000);
		expect(SCHEDULE_IDLE_MS).toBe(60_000);
		expect(schedulePollInterval(undefined)).toBe(SCHEDULE_IDLE_MS);
		expect(schedulePollInterval([schedule()])).toBe(SCHEDULE_IDLE_MS);
		expect(
			schedulePollInterval([schedule(), schedule({ due: { at: "2026-11-24T10:00:00Z" } })]),
		).toBe(SCHEDULE_POLL_MS);
		expect(
			schedulePollInterval([
				schedule({ current: { jobId: "J1", claimedAt: "2026-11-24T10:00:00Z" } }),
			]),
		).toBe(SCHEDULE_POLL_MS);
	});

	it("useSchedules refetches on that interval, and useFence follows it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let lists = 0;
			let fences = 0;
			mockRoutes({
				"schedules/list": () => {
					lists++;
					return { items: [schedule({ due: { at: "2026-11-24T10:00:00Z" } })], hasMore: false };
				},
				"schedules/fence": () => {
					fences++;
					return { fence: "clear" };
				},
			});
			const client = hostClient();
			const both = () => {
				useSchedules();
				useFence();
			};
			renderHook(both, { wrapper: wrapperFor(client) });
			await waitFor(() => expect([lists, fences]).toEqual([1, 1]));
			await vi.advanceTimersByTimeAsync(SCHEDULE_POLL_MS + 100);
			await waitFor(() => expect(lists).toBeGreaterThanOrEqual(2));
			await waitFor(() => expect(fences).toBeGreaterThanOrEqual(2));
		} finally {
			vi.useRealTimers();
		}
	});
});
