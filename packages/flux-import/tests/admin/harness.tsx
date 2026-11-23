import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import { type UserEvent, userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { vi } from "vitest";

/**
 * The admin's component-test harness (plan Ruling 11). Routes are mocked at the global `fetch`
 * (and `XMLHttpRequest`, for uploads) beneath the real `apiFetch`, so every request is also checked
 * for the CSRF header. Tasks 2-15 never modify this file (preflight F21).
 */

export interface RouteCall {
	method: string;
	/** Path and query, e.g. `/_emdash/api/plugins/flux-import/jobs/next`. */
	path: string;
	/** The table key the request matched. */
	route: string;
	body: unknown;
}

/** A plain value answers `{ success: true, data: value }`; a `Response` passes through. */
export type RouteHandler = (body: unknown, call: RouteCall) => unknown;

const PLUGIN_PREFIX = "/_emdash/api/plugins/flux-import/";
const UPLOAD_PATH = "/_emdash/api/flux-import/uploads";

/** The table key for a request, or null when nothing should receive it. */
function routeKey(method: string, pathname: string): string | null {
	if (pathname.startsWith(PLUGIN_PREFIX)) {
		const route = pathname.slice(PLUGIN_PREFIX.length);
		if (method === "GET") return route === "jobs/log.csv" ? "GET log.csv" : null;
		return method === "POST" ? route : null;
	}
	if (method === "GET" && pathname === "/_emdash/api/manifest") return "GET manifest";
	const collection = /^\/_emdash\/api\/schema\/collections\/([^/]+)$/.exec(pathname);
	if (method === "GET" && collection) return `GET collection:${collection[1]}`;
	if (method === "POST" && pathname === UPLOAD_PATH) return "upload";
	return null;
}

const toUrl = (raw: string) => new URL(raw, "http://localhost");

function parseBody(body: unknown): unknown {
	if (typeof body !== "string") return body ?? undefined;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body;
	}
}

function json(value: unknown, status: number): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const answer = (value: unknown, status: number) =>
	value instanceof Response ? value : json({ success: true, data: value }, status);

/** Requests the harness refused. `setup.ts` fails the test unless the list is empty. */
const violations: string[] = [];

/**
 * Returns and clears the refused requests, for a test that provokes one on purpose. A refusal is
 * also thrown, but a component may catch it; this list is how it still fails the test.
 */
export function takeViolations(): string[] {
	return violations.splice(0);
}

function refuse(message: string): never {
	violations.push(message);
	throw new Error(message);
}

/** What `fetch` rejects with on an abort: the signal's reason, an `AbortError` by default. */
const abortReason = (signal: AbortSignal): unknown =>
	signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/** `pending`, unless `signal` aborts first. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * The fake XHR's events. Not `EventTarget`: happy-dom's `dispatchEvent` also calls some `on<type>`
 * handlers itself, so a handler could run twice.
 */
class Listeners {
	private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

	addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		if (!listener) return;
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		if (listener) this.listeners.get(type)?.delete(listener);
	}

	emit(type: string, event: Event) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			if (typeof listener === "function") listener.call(this, event);
			else listener.handleEvent(event);
		}
	}
}

/**
 * Stubs `fetch` and `XMLHttpRequest` with `table`. Keys: a plugin route name (`"jobs/next"`),
 * `"upload"`, `"GET manifest"`, `"GET collection:<slug>"` and `"GET log.csv"`. Any other request,
 * and any request without `X-EmDash-Request: 1`, is refused: thrown, and recorded for `setup.ts`.
 * Both honour aborts. `setup.ts` unstubs both after each test.
 */
export function mockRoutes(table: Record<string, RouteHandler>): { calls: RouteCall[] } {
	const calls: RouteCall[] = [];

	/** The handler for a request, after the checks every request must pass. */
	const accept = (method: string, raw: string, csrf: string | null, body: unknown) => {
		const url = toUrl(raw);
		const key = routeKey(method, url.pathname);
		const handler = key === null ? undefined : table[key];
		if (key === null || !handler) refuse(`Unexpected request: ${method} ${raw}`);
		if (csrf !== "1") refuse(`Request without X-EmDash-Request: 1: ${method} ${raw}`);
		const call: RouteCall = { method, path: url.pathname + url.search, route: key, body };
		calls.push(call);
		return { handler, call };
	};

	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : undefined;
		const raw = request ? request.url : String(input);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers ?? request?.headers);
		const signal = init?.signal ?? request?.signal;
		if (signal?.aborted) throw abortReason(signal);
		const body = init?.body != null ? init.body : request?.body ? await request.text() : undefined;
		const { handler, call } = accept(method, raw, headers.get("X-EmDash-Request"), parseBody(body));
		const pending = Promise.resolve().then(() => handler(call.body, call));
		const value = await (signal ? untilAborted(pending, signal) : pending);
		return answer(value, call.route === "upload" ? 201 : 200);
	});

	/** The upload's `XMLHttpRequest` (preflight F12). */
	class FakeXhr extends Listeners {
		readonly upload = new Listeners() as Listeners & {
			onprogress?: ((e: ProgressEvent) => void) | null;
		};
		readyState = 0;
		status = 0;
		responseText = "";
		responseType: XMLHttpRequestResponseType = "";
		onload: ((e: Event) => void) | null = null;
		onerror: ((e: Event) => void) | null = null;
		onabort: ((e: Event) => void) | null = null;
		onloadend: ((e: Event) => void) | null = null;
		onreadystatechange: ((e: Event) => void) | null = null;
		private method = "GET";
		private url = "";
		private readonly headers = new Map<string, string>();
		private contentType: string | null = null;
		/** `sent` from `send` until the request ends (`done`), by a response, an error or `abort`. */
		private state: "idle" | "sent" | "done" = "idle";

		get response(): unknown {
			return this.responseType === "json" ? parseBody(this.responseText) : this.responseText;
		}

		open(method: string, url: string | URL) {
			this.method = method.toUpperCase();
			this.url = String(url);
			this.readyState = 1;
		}

		setRequestHeader(name: string, value: string) {
			this.headers.set(name.toLowerCase(), value);
		}

		getResponseHeader(name: string): string | null {
			return name.toLowerCase() === "content-type" ? this.contentType : null;
		}

		/** Ends a sent request: `abort` and `loadend` fire, and `load` never does. */
		abort() {
			if (this.state !== "sent") return;
			this.state = "done";
			this.status = 0;
			this.readyState = 4;
			this.fire(this, "readystatechange", new Event("readystatechange"));
			this.fire(this, "abort", new ProgressEvent("abort"));
			this.fire(this, "loadend", new ProgressEvent("loadend"));
			this.readyState = 0;
		}

		send(body?: Document | XMLHttpRequestBodyInit | null) {
			const { handler, call } = accept(
				this.method,
				this.url,
				this.headers.get("x-emdash-request") ?? null,
				body ?? undefined,
			);
			this.state = "sent";
			void this.respond(handler, call, body instanceof Blob ? body.size : 0);
		}

		/** Calls the `type` listeners, then the `on<type>` handler, once each. */
		private fire(target: Listeners, type: string, event: Event) {
			target.emit(type, event);
			const own = (target as unknown as Record<string, unknown>)[`on${type}`];
			if (typeof own === "function") own.call(target, event);
		}

		private async respond(handler: RouteHandler, call: RouteCall, size: number) {
			await Promise.resolve();
			for (const loaded of [size / 2, size]) {
				if (this.state !== "sent") return;
				const progress = new ProgressEvent("progress", {
					lengthComputable: true,
					loaded,
					total: size,
				});
				this.fire(this.upload, "progress", progress);
			}
			let res: Response | null = null;
			let text = "";
			try {
				res = answer(await handler(call.body, call), 201);
				text = await res.text();
			} catch {
				res = null;
			}
			if (this.state !== "sent") return;
			this.state = "done";
			this.readyState = 4;
			if (res) {
				this.status = res.status;
				this.contentType = res.headers.get("Content-Type");
				this.responseText = text;
				this.fire(this, "readystatechange", new Event("readystatechange"));
				this.fire(this, "load", new ProgressEvent("load"));
			} else {
				this.status = 0;
				this.fire(this, "readystatechange", new Event("readystatechange"));
				this.fire(this, "error", new ProgressEvent("error"));
			}
			this.fire(this, "loadend", new ProgressEvent("loadend"));
		}
	}
	vi.stubGlobal("XMLHttpRequest", FakeXhr);

	return { calls };
}

/** A route's error answer, in EmDash's envelope. */
export function fail(code: string, message: string, status: number, details?: unknown): Response {
	const error = details === undefined ? { code, message } : { code, message, details };
	return json({ success: false, error }, status);
}

/**
 * Renders `ui` as the admin hosts a plugin page: inside `I18nProvider` (English, no catalog) and
 * `QueryClientProvider` (no retries). With `fakeTimers`, `user` advances Vitest's fake timers.
 */
export function renderAdmin(
	ui: ReactElement,
	opts: { fakeTimers?: boolean } = {},
): RenderResult & { user: UserEvent; queryClient: QueryClient } {
	const i18n = setupI18n({ locale: "en", messages: { en: {} } });
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const user = userEvent.setup(
		opts.fakeTimers
			? {
					advanceTimers: (ms: number) => {
						vi.advanceTimersByTime(ms);
					},
				}
			: {},
	);
	const result = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
		</I18nProvider>,
	);
	return { ...result, user, queryClient };
}

/**
 * Gives elements a layout, by `data-testid`, for @dnd-kit's collision detection (happy-dom has
 * none). Returns the function that restores `getBoundingClientRect`.
 */
export function withRects(rects: Record<string, DOMRect>): () => void {
	const original = Element.prototype.getBoundingClientRect;
	const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
		this: Element,
	) {
		const id = this.getAttribute("data-testid");
		const rect = id === null ? undefined : rects[id];
		return rect ?? original.call(this);
	});
	return () => spy.mockRestore();
}
