import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import { memo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_ID_WIDGET, SourceIdField } from "../../src/admin/fields/SourceIdField.js";
import { type Msg, useT } from "../../src/admin/i18n.js";
import { fields, pages } from "../../src/admin/index.js";
import { M } from "../../src/admin/messages.js";
import {
	fail,
	HOME_ROUTES,
	mockRoutes,
	renderAdmin,
	takeViolations,
	withRects,
} from "./harness.js";

const ROUTE = "/_emdash/api/plugins/flux-import/jobs/get";
const UPLOAD = "/_emdash/api/flux-import/uploads?filename=posts.csv";

/** Sends an upload the way the wizard does, resolving with the status and the progress seen. */
function upload(file: File, csrf: boolean) {
	return new Promise<{ status: number; body: string; progress: number[]; events: string[] }>(
		(resolve, reject) => {
			const xhr = new XMLHttpRequest();
			const progress: number[] = [];
			const events: string[] = [];
			xhr.upload.onprogress = (e) => progress.push(e.loaded);
			xhr.addEventListener("load", () => events.push("load"));
			xhr.onload = () => events.push("onload");
			xhr.onloadend = () =>
				events.includes("onload")
					? resolve({ status: xhr.status, body: xhr.responseText, progress, events })
					: undefined;
			xhr.onerror = () => reject(new Error("network"));
			xhr.open("POST", UPLOAD);
			if (csrf) xhr.setRequestHeader("X-EmDash-Request", "1");
			xhr.send(file);
		},
	);
}

/** A promise and the function that settles it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("the admin entry", () => {
	it("exports the Imports home first, then New import (M7b)", () => {
		// The descriptor's `admin.pages` lists the same paths in the same order (Fact V1).
		expect(Object.keys(pages ?? {})).toEqual(["/imports", "/import"]);
	});

	it("exports the Imports page: the home, opening on its Jobs tab", async () => {
		mockRoutes({ ...HOME_ROUTES, "credentials/list": () => [] });
		const ImportsPage = pages?.["/imports"];
		expect(ImportsPage).toBeTypeOf("function");
		renderAdmin(<ImportsPage />);
		expect(screen.getByRole("heading", { level: 1, name: "Imports" })).toBeInTheDocument();
		expect(await screen.findByRole("tab", { name: "Jobs" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Jobs");
		// The real Jobs tab, not a stand-in: its empty state.
		expect(await screen.findByText("No imports yet")).toBeVisible();
	});

	it.each([
		["templates", "Templates", "Import a template"],
		["sources", "Sources", "Add a source"],
		["schedules", "Schedules", "New schedule"],
	])(
		"opens the %s tab without repeating its name as a heading (Critique 10)",
		async (tab, title, action) => {
			window.history.replaceState(null, "", `/?tab=${tab}`);
			mockRoutes({ ...HOME_ROUTES, "credentials/list": () => [] });
			const ImportsPage = pages?.["/imports"];
			if (!ImportsPage) throw new Error("no Imports page");
			renderAdmin(<ImportsPage />);
			expect(await screen.findByRole("button", { name: action })).toBeVisible();
			expect(screen.getByRole("tabpanel")).toHaveAccessibleName(title);
			expect(screen.queryByRole("heading", { name: title })).toBeNull();
			window.history.replaceState(null, "", "/");
		},
	);

	it("exports the New import page: the wizard, opening on its Source step", async () => {
		mockRoutes({
			"credentials/list": () => [],
			"templates/list": () => ({ items: [], hasMore: false }),
			"sources/list": () => ({ items: [], hasMore: false }),
		});
		const ImportPage = pages?.["/import"];
		expect(ImportPage).toBeTypeOf("function");
		renderAdmin(<ImportPage />);
		expect(screen.getByRole("heading", { level: 1, name: "New import" })).toBeInTheDocument();
		expect(await screen.findByRole("heading", { level: 2, name: "Source" })).toBeVisible();
		expect(screen.getByRole("list", { name: "Steps" })).toBeVisible();
		expect(screen.getByRole("link", { name: "1 Source" })).toHaveAttribute("aria-current", "step");
	});

	it("exports the source-id field widget (Task 13), and nothing else", () => {
		expect(fields).toEqual({ [SOURCE_ID_WIDGET]: SourceIdField });
		expect(SOURCE_ID_WIDGET).toBe("source-id");
	});

	it("gives useT a new t when the locale changes", () => {
		const i18n = setupI18n({ locale: "en", messages: { en: {} } });
		// A memoized child sees a locale change only through a new `t`.
		const Title = memo(({ t }: { t: (msg: Msg) => string }) => <p>{t(M.pageTitle)}</p>);
		function Page() {
			const t = useT();
			return <Title t={t} />;
		}
		render(
			<I18nProvider i18n={i18n}>
				<Page />
			</I18nProvider>,
		);
		expect(screen.getByText("New import")).toBeInTheDocument();
		act(() => {
			i18n.loadAndActivate({ locale: "fr", messages: { [M.pageTitle.id]: "Importer" } });
		});
		expect(screen.getByText("Importer")).toBeInTheDocument();
	});
});

describe("mockRoutes", () => {
	it("answers through the real apiFetch and records the call", async () => {
		const { calls } = mockRoutes({ "jobs/get": (body) => ({ echoed: body }) });
		const res = await apiFetch(ROUTE, { method: "POST", body: JSON.stringify({ id: "j1" }) });
		expect(await parseApiResponse(res)).toEqual({ echoed: { id: "j1" } });
		expect(calls).toEqual([{ method: "POST", path: ROUTE, route: "jobs/get", body: { id: "j1" } }]);
	});

	it("reads a Request input's method, headers and body", async () => {
		const { calls } = mockRoutes({ "jobs/get": (body) => ({ echoed: body }) });
		const request = new Request(new URL(ROUTE, window.location.href), {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
			body: JSON.stringify({ id: "j2" }),
		});
		expect(await parseApiResponse(await fetch(request))).toEqual({ echoed: { id: "j2" } });
		expect(calls).toEqual([{ method: "POST", path: ROUTE, route: "jobs/get", body: { id: "j2" } }]);
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

	it("rejects a request without the CSRF header, and records it", async () => {
		const { calls } = mockRoutes({ "jobs/get": () => ({}) });
		await expect(fetch(ROUTE, { method: "POST", body: "{}" })).rejects.toThrow(
			/without X-EmDash-Request/,
		);
		expect(calls).toEqual([]);
		expect(takeViolations()).toEqual([`Request without X-EmDash-Request: 1: POST ${ROUTE}`]);
	});

	it("rejects a request the table does not name, and records it", async () => {
		mockRoutes({ "jobs/get": () => ({}) });
		const path = "/_emdash/api/plugins/flux-import/jobs/next";
		await expect(apiFetch(path)).rejects.toThrow(/Unexpected request: GET/);
		expect(takeViolations()).toEqual([`Unexpected request: GET ${path}`]);
	});

	// setup.ts's afterEach finds the refusal the caller swallowed, so this test must fail.
	it.fails("fails the test when a caller swallows a refusal", async () => {
		mockRoutes({ "jobs/get": () => ({}) });
		await fetch(ROUTE, { method: "POST", body: "{}" }).catch(() => undefined);
	});

	it("rejects an aborted fetch with an AbortError, without calling the route", async () => {
		const handler = vi.fn(() => ({}));
		const { calls } = mockRoutes({ "jobs/get": handler });
		const controller = new AbortController();
		controller.abort();
		const sent = apiFetch(ROUTE, { method: "POST", body: "{}", signal: controller.signal });
		await expect(sent).rejects.toMatchObject({ name: "AbortError" });
		expect(handler).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("rejects with an AbortError when the fetch is aborted during the call", async () => {
		const answer = deferred<unknown>();
		mockRoutes({ "jobs/get": () => answer.promise });
		const controller = new AbortController();
		const sent = apiFetch(ROUTE, { method: "POST", body: "{}", signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		await expect(sent).rejects.toMatchObject({ name: "AbortError" });
		answer.resolve({});
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
		expect(result.events).toEqual(["load", "onload"]);
		expect(calls).toEqual([{ method: "POST", path: UPLOAD, route: "upload", body: file }]);
	});

	it("rejects an upload without the CSRF header, and records it", async () => {
		const { calls } = mockRoutes({ upload: () => ({}) });
		const file = new File(["x"], "posts.csv");
		await expect(upload(file, false)).rejects.toThrow(/without X-EmDash-Request/);
		expect(calls).toEqual([]);
		expect(takeViolations()).toEqual([`Request without X-EmDash-Request: 1: POST ${UPLOAD}`]);
	});

	it("fires abort, and never load, when an upload is aborted", async () => {
		const answer = deferred<unknown>();
		mockRoutes({ upload: () => answer.promise });
		const events: string[] = [];
		const xhr = new XMLHttpRequest();
		for (const type of ["load", "error", "abort", "loadend"]) {
			xhr.addEventListener(type, () => events.push(type));
		}
		xhr.onload = () => events.push("onload");
		xhr.onabort = () => events.push("onabort");
		xhr.open("POST", UPLOAD);
		xhr.setRequestHeader("X-EmDash-Request", "1");
		xhr.send(new File(["x"], "posts.csv"));
		await Promise.resolve();
		xhr.abort();
		answer.resolve({ uploadId: "u" });
		await new Promise((r) => setTimeout(r, 0));
		expect(events).toEqual(["abort", "onabort", "loadend"]);
		expect(xhr.status).toBe(0);
	});
});

describe("renderAdmin with fakeTimers", () => {
	it("lets user click, and waitFor advance the fake clock, under vi.useFakeTimers()", async () => {
		vi.useFakeTimers();
		function Later() {
			const [shown, setShown] = useState(false);
			return (
				<button type="button" onClick={() => setTimeout(() => setShown(true), 5000)}>
					{shown ? "Shown" : "Go"}
				</button>
			);
		}
		const { user } = renderAdmin(<Later />, { fakeTimers: true });
		await user.click(screen.getByRole("button", { name: "Go" }));
		// Only fake time can fire the 5 s timer: waitFor advances it as it polls.
		await waitFor(() => expect(screen.getByRole("button", { name: "Shown" })).toBeVisible(), {
			timeout: 6000,
		});
	}, 2000);
});

describe("setup.ts", () => {
	// These two run in order: the first leaves a spy in place for afterEach to restore.
	it("leaves withRects' spy unrestored", () => {
		withRects({ box: new DOMRect(0, 0, 10, 10) });
		expect(vi.isMockFunction(Element.prototype.getBoundingClientRect)).toBe(true);
	});

	it("finds it restored by afterEach", () => {
		expect(vi.isMockFunction(Element.prototype.getBoundingClientRect)).toBe(false);
	});
});
