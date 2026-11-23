import { screen } from "@testing-library/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { describe, expect, it } from "vitest";
import { pages } from "../../src/admin/index.js";
import { fail, mockRoutes, renderAdmin } from "./harness.js";

const ROUTE = "/_emdash/api/plugins/flux-import/jobs/get";
const UPLOAD = "/_emdash/api/flux-import/uploads?filename=posts.csv";

/** Sends an upload the way the wizard does, resolving with the status and the progress seen. */
function upload(file: File, csrf: boolean) {
	return new Promise<{ status: number; body: string; progress: number[] }>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const progress: number[] = [];
		xhr.upload.onprogress = (e) => progress.push(e.loaded);
		xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText, progress });
		xhr.onerror = () => reject(new Error("network"));
		xhr.open("POST", UPLOAD);
		if (csrf) xhr.setRequestHeader("X-EmDash-Request", "1");
		xhr.send(file);
	});
}

describe("the admin entry", () => {
	it("exports the Import page, which shows its heading", () => {
		const ImportPage = pages?.["/import"];
		expect(ImportPage).toBeTypeOf("function");
		renderAdmin(<ImportPage />);
		expect(screen.getByRole("heading", { level: 1, name: "Import" })).toBeInTheDocument();
	});
});

describe("mockRoutes", () => {
	it("answers through the real apiFetch and records the call", async () => {
		const { calls } = mockRoutes({ "jobs/get": (body) => ({ echoed: body }) });
		const res = await apiFetch(ROUTE, { method: "POST", body: JSON.stringify({ id: "j1" }) });
		expect(await parseApiResponse(res)).toEqual({ echoed: { id: "j1" } });
		expect(calls).toEqual([{ method: "POST", path: ROUTE, route: "jobs/get", body: { id: "j1" } }]);
	});

	it("passes a fail() answer through", async () => {
		mockRoutes({ "jobs/get": () => fail("NOT_FOUND", "No such job", 404) });
		const res = await apiFetch(ROUTE, { method: "POST", body: "{}" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "No such job" },
		});
	});

	it("rejects a request without the CSRF header", async () => {
		const { calls } = mockRoutes({ "jobs/get": () => ({}) });
		await expect(fetch(ROUTE, { method: "POST", body: "{}" })).rejects.toThrow(
			/without X-EmDash-Request/,
		);
		expect(calls).toEqual([]);
	});

	it("rejects a request the table does not name", async () => {
		mockRoutes({ "jobs/get": () => ({}) });
		await expect(apiFetch("/_emdash/api/plugins/flux-import/jobs/next")).rejects.toThrow(
			/Unexpected request: GET/,
		);
	});

	it("uploads through XMLHttpRequest with progress and a 201", async () => {
		const file = new File(["id,title\n1,Hello\n"], "posts.csv", { type: "text/csv" });
		const { calls } = mockRoutes({ upload: () => ({ uploadId: "u", bytes: file.size }) });
		const result = await upload(file, true);
		expect(result.status).toBe(201);
		expect(JSON.parse(result.body)).toEqual({
			success: true,
			data: { uploadId: "u", bytes: file.size },
		});
		expect(result.progress).toEqual([file.size / 2, file.size]);
		expect(calls).toEqual([{ method: "POST", path: UPLOAD, route: "upload", body: file }]);
	});

	it("rejects an upload without the CSRF header", async () => {
		const { calls } = mockRoutes({ upload: () => ({}) });
		const file = new File(["x"], "posts.csv");
		await expect(upload(file, false)).rejects.toThrow(/without X-EmDash-Request/);
		expect(calls).toEqual([]);
	});
});
