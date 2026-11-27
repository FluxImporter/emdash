import { LinkButton } from "@cloudflare/kumo";
import { setupI18n } from "@lingui/core";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Home, HomeProvider, type TabComponents, useHome } from "../../src/admin/home/Home.js";
import { runUrl, templateUrl } from "../../src/admin/home/links.js";
import { ConfirmDialog } from "../../src/admin/home/shared/ConfirmDialog.js";
import { M as SHARED } from "../../src/admin/home/shared/messages.js";
import { When, whenLabel } from "../../src/admin/home/shared/When.js";
import { readTab, type TabId } from "../../src/admin/home/url.js";
import { translate } from "../../src/admin/i18n.js";
import { fail, HOME_ROUTES, mockRoutes, renderAdmin } from "./harness.js";

function dummy(id: TabId) {
	return function Dummy() {
		const { goTo, announce } = useHome();
		return (
			<div>
				<p>{`${id}-tab`}</p>
				<button type="button" onClick={() => goTo("schedules")}>
					Go to schedules
				</button>
				<button type="button" onClick={() => announce(`said ${id}`)}>
					Say
				</button>
			</div>
		);
	};
}

const DUMMY: TabComponents = {
	jobs: dummy("jobs"),
	templates: dummy("templates"),
	sources: dummy("sources"),
	schedules: dummy("schedules"),
};

const granted = () => mockRoutes({ ...HOME_ROUTES, "credentials/list": () => [] });

describe("url and links", () => {
	it("reads the tab, Jobs for an unknown or absent one", () => {
		expect(readTab("?tab=sources")).toBe("sources");
		expect(readTab("?tab=nope")).toBe("jobs");
		expect(readTab("")).toBe("jobs");
	});
	it("builds the wizard links with the id encoded", () => {
		expect(runUrl("a b")).toBe("/_emdash/admin/plugins/fluximporter/import?step=run&job=a%20b");
		expect(templateUrl("t/1")).toBe("/_emdash/admin/plugins/fluximporter/import?template=t%2F1");
	});
});

describe("Home", () => {
	it("shows the administrators-only state once for the page on a 403", async () => {
		mockRoutes({ "credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findAllByText("Only administrators can import.")).toHaveLength(1);
		expect(screen.getByText("Ask an administrator of this site for access.")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(screen.queryByRole("link", { name: "New import" })).toBeNull();
		expect(screen.getByRole("heading", { level: 1, name: "Imports" })).toBeVisible();
	});

	it("offers Try again after another failure, which probes again", async () => {
		let failing = true;
		mockRoutes({
			...HOME_ROUTES,
			"credentials/list": () => (failing ? fail("UNAUTHORIZED", "Session expired", 401) : []),
		});
		const { user } = renderAdmin(<Home tabs={DUMMY} />);
		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(screen.getByRole("alert")).toHaveTextContent("Imports could not be loaded.");
		expect(screen.getByRole("alert")).toHaveTextContent("Your imports are not affected.");
		expect(screen.queryByRole("tablist")).toBeNull();
		failing = false;
		await user.click(retry);
		expect(await screen.findByRole("tablist")).toBeVisible();
	});

	it("renders Imports, the New import link to the wizard and four tabs with a tabpanel", async () => {
		granted();
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findByRole("link", { name: "New import" })).toHaveAttribute(
			"href",
			"/_emdash/admin/plugins/fluximporter/import",
		);
		expect(screen.getByRole("heading", { level: 1, name: "Imports" })).toBeVisible();
		// The page's only primary button (Critique 7).
		const { container } = render(
			<LinkButton variant="primary" href="/x">
				x
			</LinkButton>,
		);
		expect(screen.getByRole("link", { name: "New import" }).className).toBe(
			(container.firstElementChild as HTMLElement).className,
		);
		// Each tab carries its count once its list is read.
		await waitFor(() =>
			expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
				"Jobs0",
				"Templates0",
				"Sources0",
				"Schedules0",
			]),
		);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("jobs-tab");
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Jobs");
		// No heading repeats the tab's name under the tabs (Critique 10).
		expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
	});

	it("counts each tab's list, and Jobs with a + while more pages exist", async () => {
		const row = (id: string) => ({ id });
		mockRoutes({
			...HOME_ROUTES,
			"credentials/list": () => [],
			"jobs/summaries": () => ({ items: [row("a"), row("b")], hasMore: true, cursor: "c" }),
			"templates/list": () => ({ items: [row("t")], hasMore: false }),
			"sources/list": () => ({ items: [row("s1"), row("s2"), row("s3")], hasMore: false }),
		});
		renderAdmin(<Home tabs={DUMMY} />);
		await waitFor(() =>
			expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
				"Jobs2+",
				"Templates1",
				"Sources3",
				"Schedules0",
			]),
		);
	});

	it("waits behind a banner while a site import runs, and recovers by itself", async () => {
		let fence = "import";
		mockRoutes({
			...HOME_ROUTES,
			"credentials/list": () => [],
			"schedules/fence": () => ({ fence }),
		});
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findByText("A site import is running.")).toBeVisible();
		expect(screen.getByRole("button", { name: "New import" })).toBeDisabled();
		expect(screen.queryByRole("link", { name: "New import" })).toBeNull();
		expect(screen.getByText("jobs-tab").closest("[inert]")).not.toBeNull();
		fence = "clear";
		vi.advanceTimersByTime(5_000);
		expect(await screen.findByRole("link", { name: "New import" })).toBeVisible();
		expect(screen.queryByText("A site import is running.")).toBeNull();
		vi.useRealTimers();
	});

	it("opens the tab named in ?tab=, and Jobs for an unknown one", async () => {
		granted();
		window.history.replaceState(null, "", "/?tab=sources");
		const first = renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findByText("sources-tab")).toBeVisible();
		first.unmount();
		window.history.replaceState(null, "", "/?tab=bogus");
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findByText("jobs-tab")).toBeVisible();
	});

	it("writes ?tab= with replaceState keeping history.state, and mounts only the shown tab", async () => {
		granted();
		window.history.replaceState({ router: 1 }, "", "/?keep=1");
		const push = vi.spyOn(window.history, "pushState");
		const { user } = renderAdmin(<Home tabs={DUMMY} />);
		await screen.findByText("jobs-tab");
		await user.click(screen.getByRole("tab", { name: "Templates" }));
		expect(await screen.findByText("templates-tab")).toBeVisible();
		expect(screen.queryByText("jobs-tab")).toBeNull();
		expect(window.location.search).toBe("?keep=1&tab=templates");
		expect(window.history.state).toEqual({ router: 1 });
		expect(push).not.toHaveBeenCalled();
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Templates");
	});

	it("goTo switches the tab from inside a tab", async () => {
		granted();
		const { user } = renderAdmin(<Home tabs={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Go to schedules" }));
		expect(await screen.findByText("schedules-tab")).toBeVisible();
		expect(window.location.search).toBe("?tab=schedules");
		expect(screen.getByRole("tab", { name: "Schedules" })).toHaveAttribute("aria-selected", "true");
	});

	it("changes the live region each time, even for the same text", async () => {
		granted();
		const { user, container } = renderAdmin(<Home tabs={DUMMY} />);
		const say = await screen.findByRole("button", { name: "Say" });
		await user.click(say);
		const first = container.querySelector('[aria-live="polite"] > span');
		expect(first).toHaveTextContent("said jobs");
		await user.click(say);
		const second = container.querySelector('[aria-live="polite"] > span');
		expect(second).toHaveTextContent("said jobs");
		expect(second).not.toBe(first);
	});

	it("announces through one polite live region", async () => {
		granted();
		const { user, container } = renderAdmin(<Home tabs={DUMMY} />);
		await user.click(await screen.findByRole("button", { name: "Say" }));
		const regions = container.querySelectorAll('[aria-live="polite"]');
		expect(regions).toHaveLength(1);
		expect(regions[0]).toHaveTextContent("said jobs");
	});
});

describe("HomeProvider", () => {
	function Probe() {
		const { tab, goTo, announce } = useHome();
		return (
			<>
				<p>{`tab ${tab}`}</p>
				<button type="button" onClick={() => goTo("sources")}>
					go
				</button>
				<button type="button" onClick={() => announce("hello")}>
					announce
				</button>
			</>
		);
	}
	it("opens on initialTab, else the URL, and goTo writes ?tab=", async () => {
		const { user, unmount } = renderAdmin(
			<HomeProvider initialTab="templates">
				<Probe />
			</HomeProvider>,
		);
		expect(screen.getByText("tab templates")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "go" }));
		expect(screen.getByText("tab sources")).toBeVisible();
		expect(window.location.search).toBe("?tab=sources");
		unmount();
		renderAdmin(
			<HomeProvider>
				<Probe />
			</HomeProvider>,
		);
		expect(screen.getByText("tab sources")).toBeVisible();
	});
	it("renders the announcement in one polite region", async () => {
		const { user, container } = renderAdmin(
			<HomeProvider>
				<Probe />
			</HomeProvider>,
		);
		await user.click(screen.getByRole("button", { name: "announce" }));
		expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
		expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("hello");
	});
	it("throws outside a provider", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => render(<Probe />)).toThrow("useHome needs HomeProvider");
	});
});

describe("ConfirmDialog", () => {
	function Harness(props: { busy?: boolean }) {
		const [open, setOpen] = useState(false);
		return (
			<>
				<button type="button" onClick={() => setOpen(true)}>
					Open
				</button>
				<ConfirmDialog
					open={open}
					title="Delete it"
					sentence="This cannot be undone."
					confirmLabel="Delete"
					danger
					busy={props.busy === true}
					onConfirm={() => {}}
					onClose={() => setOpen(false)}
				/>
			</>
		);
	}
	it("closes with Escape unless busy, and returns focus to its opener", async () => {
		const { user } = renderAdmin(<Harness />);
		const opener = screen.getByRole("button", { name: "Open" });
		await user.click(opener);
		expect(await screen.findByRole("dialog", { name: "Delete it" })).toBeVisible();
		expect(screen.getByRole("dialog")).toHaveAccessibleDescription("This cannot be undone.");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(opener).toHaveFocus();
	});
	it("does not close with Escape or Cancel while busy, and marks the confirm button", async () => {
		const { user } = renderAdmin(<Harness busy />);
		await user.click(screen.getByRole("button", { name: "Open" }));
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-busy", "true");
	});
	it("confirms and cancels", async () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { user } = renderAdmin(
			<ConfirmDialog
				open
				title="T"
				sentence="S"
				confirmLabel="Go"
				busy={false}
				error={<p>It failed</p>}
				onConfirm={onConfirm}
				onClose={onClose}
			>
				<p>details</p>
			</ConfirmDialog>,
		);
		expect(await screen.findByText("details")).toBeVisible();
		expect(screen.getByText("It failed")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Go" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("times", () => {
	const t = (m: { id: string; message: string }, v?: Record<string, string | number>) =>
		translate(setupI18n({ locale: "en", messages: { en: {} } }), m, v);
	const now = Date.UTC(2026, 10, 24, 15, 0);
	it("labels times today, yesterday and older, always in UTC", () => {
		expect(whenLabel(new Date(Date.UTC(2026, 10, 24, 10, 14)).toISOString(), now, "en", t)).toBe(
			"Today 10:14 UTC",
		);
		expect(whenLabel(new Date(Date.UTC(2026, 10, 23, 23, 59)).toISOString(), now, "en", t)).toBe(
			"Yesterday 23:59 UTC",
		);
		expect(whenLabel(new Date(Date.UTC(2026, 10, 20, 15, 30)).toISOString(), now, "en", t)).toBe(
			"Nov 20 15:30 UTC",
		);
		// Another year names it.
		expect(whenLabel(new Date(Date.UTC(2025, 11, 31, 8, 0)).toISOString(), now, "en", t)).toBe(
			"Dec 31, 2025 08:00 UTC",
		);
		expect(SHARED.today.message).toContain("{time}");
	});
	it("leaves a value that is not a time as it is", () => {
		expect(whenLabel("soon", now, "en", t)).toBe("soon");
	});
	it("renders a time element with the exact time as accessible text", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		const iso = new Date(Date.UTC(2026, 10, 24, 10, 14)).toISOString();
		renderAdmin(<When iso={iso} />);
		const el = document.querySelector("time");
		expect(el).toHaveAttribute("datetime", iso);
		expect(el?.textContent).toContain("Today 10:14 UTC");
		expect(el?.getAttribute("title")).toContain("Nov 24, 2026");
		expect(el?.getAttribute("title")).toContain("UTC");
		expect(el?.querySelector(".sr-only")?.textContent).toBe(el?.getAttribute("title"));
	});
	it("gives the exact time on the label's 24-hour clock", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		renderAdmin(<When iso={new Date(Date.UTC(2026, 10, 24, 14, 5, 9)).toISOString()} />);
		const el = document.querySelector("time");
		expect(el?.textContent).toContain("Today 14:05 UTC");
		expect(el?.getAttribute("title")).toContain("14:05:09");
		expect(el?.getAttribute("title")).not.toMatch(/[AP]M/);
	});
});
