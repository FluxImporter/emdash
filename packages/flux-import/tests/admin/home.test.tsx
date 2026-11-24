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
import { fail, mockRoutes, renderAdmin } from "./harness.js";

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

const granted = () => mockRoutes({ "credentials/list": () => [] });

describe("url and links", () => {
	it("reads the tab, Jobs for an unknown or absent one", () => {
		expect(readTab("?tab=sources")).toBe("sources");
		expect(readTab("?tab=nope")).toBe("jobs");
		expect(readTab("")).toBe("jobs");
	});
	it("builds the wizard links with the id encoded", () => {
		expect(runUrl("a b")).toBe("/_emdash/admin/plugins/flux-import/import?step=run&job=a%20b");
		expect(templateUrl("t/1")).toBe("/_emdash/admin/plugins/flux-import/import?template=t%2F1");
	});
});

describe("Home", () => {
	it("shows the administrators-only state once for the page on a 403", async () => {
		mockRoutes({ "credentials/list": () => fail("FORBIDDEN", "Insufficient permissions", 403) });
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findAllByText("Only administrators can import.")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("tablist")).toBeNull();
	});

	it("offers Try again after another failure, which probes again", async () => {
		let failing = true;
		mockRoutes({
			"credentials/list": () => (failing ? fail("UNAUTHORIZED", "Session expired", 401) : []),
		});
		const { user } = renderAdmin(<Home tabs={DUMMY} />);
		const retry = await screen.findByRole("button", { name: "Try again" });
		expect(screen.queryByRole("tablist")).toBeNull();
		failing = false;
		await user.click(retry);
		expect(await screen.findByRole("tablist")).toBeVisible();
	});

	it("renders Imports, the New import link to the wizard and four tabs with a tabpanel", async () => {
		granted();
		renderAdmin(<Home tabs={DUMMY} />);
		expect(await screen.findByRole("heading", { level: 1, name: "Imports" })).toBeVisible();
		expect(screen.getByRole("link", { name: "New import" })).toHaveAttribute(
			"href",
			"/_emdash/admin/plugins/flux-import/import",
		);
		expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
			"Jobs",
			"Templates",
			"Sources",
			"Schedules",
		]);
		expect(screen.getByRole("tabpanel")).toHaveTextContent("jobs-tab");
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Jobs");
		expect(screen.getByRole("heading", { level: 2, name: "Jobs" })).toBeVisible();
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
	const now = new Date(2026, 10, 24, 15, 0).getTime();
	it("labels times today, yesterday and older", () => {
		expect(whenLabel(new Date(2026, 10, 24, 10, 14).toISOString(), now, "en", t)).toBe(
			"today 10:14",
		);
		expect(whenLabel(new Date(2026, 10, 23, 23, 59).toISOString(), now, "en", t)).toBe(
			"yesterday 23:59",
		);
		const older = whenLabel(new Date(2026, 10, 20, 10, 14).toISOString(), now, "en", t);
		expect(older).toContain("Nov 20, 2026");
		expect(older).not.toContain("today");
		expect(older).not.toContain("yesterday");
		expect(SHARED.today.message).toContain("{time}");
	});
	it("leaves a value that is not a time as it is", () => {
		expect(whenLabel("soon", now, "en", t)).toBe("soon");
	});
	it("renders a time element with the exact time as accessible text", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		const iso = new Date(2026, 10, 24, 10, 14).toISOString();
		renderAdmin(<When iso={iso} />);
		const el = document.querySelector("time");
		expect(el).toHaveAttribute("datetime", iso);
		expect(el?.textContent).toContain("today 10:14");
		expect(el?.getAttribute("title")).toContain("Nov 24, 2026");
		expect(el?.querySelector(".sr-only")?.textContent).toBe(el?.getAttribute("title"));
	});
});
