import { Button, LinkButton, Tabs } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import {
	type ComponentType,
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isForbidden } from "../api-error.js";
import { useT } from "../i18n.js";
import {
	useAllSources,
	useAllTemplates,
	useCredentials,
	useFence,
	useJobPages,
	useSchedules,
} from "../queries.js";
import { PlusIcon } from "../ui/icons.js";
import { Mark } from "../ui/Mark.js";
import { Forbidden, LoadFailed, LoadingRows, SiteImportBanner } from "../ui/states.js";
import { WIZARD_URL } from "./links.js";
import { M } from "./messages.js";
import { readTab, TABS, type TabId, writeTab } from "./url.js";

/** The component each tab renders in its panel, starting with its summary line. */
export type TabComponents = Readonly<Record<TabId, ComponentType>>;

interface HomeValue {
	tab: TabId;
	goTo(tab: TabId): void;
	announce(text: string): void;
	/**
	 * Moves focus to the open tab's panel: where a dialog sends it when the control that opened
	 * it is gone. Does nothing outside `Home`.
	 */
	focusHeading(): void;
	/** The open tab's panel, which `Home` renders. */
	headingRef: RefObject<HTMLDivElement | null>;
}

const HomeContext = createContext<HomeValue | null>(null);

/** The home's tab, and the page's one live region (`announce`). */
export function useHome(): HomeValue {
	const value = useContext(HomeContext);
	if (value === null) throw new Error("useHome needs HomeProvider");
	return value;
}

/**
 * Holds the tab (opened from `?tab=` unless `initialTab` says otherwise; `goTo` writes it back)
 * and renders the page's one polite live region with the latest announcement.
 */
export function HomeProvider(props: { children: ReactNode; initialTab?: TabId }) {
	const [tab, setTab] = useState<TabId>(() => props.initialTab ?? readTab(window.location.search));
	// A counter beside the text: the same sentence twice is a new element, which is read again.
	const [announcement, setAnnouncement] = useState({ n: 0, text: "" });
	const goTo = useCallback((next: TabId) => {
		writeTab(next);
		setTab(next);
	}, []);
	const announce = useCallback(
		(text: string) => setAnnouncement((a) => ({ n: a.n + 1, text })),
		[],
	);
	const headingRef = useRef<HTMLDivElement | null>(null);
	const focusHeading = useCallback(() => headingRef.current?.focus(), []);
	const value = useMemo(
		() => ({ tab, goTo, announce, focusHeading, headingRef }),
		[tab, goTo, announce, focusHeading],
	);
	return (
		<HomeContext.Provider value={value}>
			{props.children}
			<div aria-live="polite" className="sr-only">
				{announcement.n === 0 ? null : <span key={announcement.n}>{announcement.text}</span>}
			</div>
		</HomeContext.Provider>
	);
}

/**
 * The Imports home (Home.dc.html): the access probe (as the wizard's), then the title with the
 * mark, "New import" (the page's only primary button) and the tabs with their counts. A 403
 * replaces the button and the tabs; any other failure shows its sentence and "Try again"; while a
 * site import runs, the page waits behind a banner and polls until it ends (States.dc.html).
 */
export function Home(props: { tabs: TabComponents }) {
	const t = useT();
	const access = useCredentials();
	if (access.data !== undefined) {
		// Once granted, the page stays: a later failed probe must not drop the open tab.
		return <Granted tabs={props.tabs} />;
	}
	return (
		<div className="flex flex-col gap-5">
			<Title />
			{access.isError && isForbidden(access.error) ? (
				<Forbidden />
			) : access.isError ? (
				<LoadFailed
					title={t(M.loadFailed)}
					error={access.error}
					retrying={access.isFetching}
					onRetry={() => void access.refetch()}
				/>
			) : (
				<LoadingRows label={t(M.checkingAccess)} />
			)}
		</div>
	);
}

function Title() {
	const t = useT();
	return (
		<div className="flex items-center gap-2.5">
			<Mark />
			<h1 className="text-2xl font-bold text-kumo-default">{t(M.title)}</h1>
		</div>
	);
}

/** The page once access is granted: "New import", the tabs, and the site-import wait. */
function Granted(props: { tabs: TabComponents }) {
	const t = useT();
	const fence = useFence();
	const siteImport = fence.data === "import";
	const { refetch } = fence;
	// The fence's own poll follows the schedules; while a site import runs, the page polls it.
	useEffect(() => {
		if (!siteImport) return;
		const timer = setInterval(() => void refetch(), SITE_IMPORT_POLL_MS);
		return () => clearInterval(timer);
	}, [siteImport, refetch]);
	const icon = <PlusIcon aria-hidden="true" />;
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Title />
				{siteImport ? (
					<Button variant="primary" icon={icon} disabled>
						{t(M.newImport)}
					</Button>
				) : (
					<LinkButton variant="primary" icon={icon} href={WIZARD_URL}>
						{t(M.newImport)}
					</LinkButton>
				)}
			</div>
			<HomeProvider>
				{siteImport ? <SiteImportBanner /> : null}
				<div
					className={
						siteImport
							? "pointer-events-none flex flex-col gap-5 opacity-50"
							: "flex flex-col gap-5"
					}
					aria-busy={siteImport || undefined}
					inert={siteImport || undefined}
				>
					<Content tabs={props.tabs} />
				</div>
			</HomeProvider>
		</div>
	);
}

/** How often the page asks whether a site import has ended. */
const SITE_IMPORT_POLL_MS = 5_000;

/** Each tab's count, once its list is read: Jobs shows "8+" while more pages exist. */
function useTabCounts(): Partial<Record<TabId, string>> {
	const { i18n } = useLingui();
	const format = (n: number) => new Intl.NumberFormat(i18n.locale || "en").format(n);
	const jobs = useJobPages();
	const templates = useAllTemplates();
	const sources = useAllSources();
	const schedules = useSchedules();
	const counts: Partial<Record<TabId, string>> = {};
	if (jobs.data !== undefined) {
		const n = jobs.data.pages.reduce((sum, page) => sum + page.items.length, 0);
		counts.jobs = jobs.hasNextPage ? `${format(n)}+` : format(n);
	}
	if (templates.data !== undefined) counts.templates = format(templates.data.length);
	if (sources.data !== undefined) counts.sources = format(sources.data.length);
	if (schedules.data !== undefined) counts.schedules = format(schedules.data.length);
	return counts;
}

function Content(props: { tabs: TabComponents }) {
	const t = useT();
	const { tab, goTo, headingRef } = useHome();
	const counts = useTabCounts();
	const Tab = props.tabs[tab];
	return (
		<>
			<Tabs
				tabs={TABS.map((id) => ({
					value: id,
					label: (
						<span className="flex items-center gap-1.5">
							{t(M.tabs[id])}
							{counts[id] === undefined ? null : (
								// Seen, not read: each tab's summary line says its count in words.
								<span aria-hidden="true" className="text-xs tabular-nums text-kumo-default">
									{counts[id]}
								</span>
							)}
						</span>
					),
				}))}
				value={tab}
				onValueChange={(v: string) => goTo(TABS.find((id) => id === v) ?? "jobs")}
			/>
			{/* No heading under the tabs (Critique 10); the panel is where dialogs send focus. */}
			<div
				ref={headingRef}
				role="tabpanel"
				tabIndex={-1}
				aria-label={t(M.tabs[tab])}
				className="flex flex-col gap-4 outline-none"
			>
				<Tab />
			</div>
		</>
	);
}
