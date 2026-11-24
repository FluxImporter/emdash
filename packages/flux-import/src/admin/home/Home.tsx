import { Banner, Button, LinkButton, Loader, Tabs } from "@cloudflare/kumo";
import {
	type ComponentType,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { describeError, ERROR_MESSAGES } from "../errors.js";
import { useT } from "../i18n.js";
import { M as PAGE } from "../messages.js";
import { useCredentials } from "../queries.js";
import { WIZARD_URL } from "./links.js";
import { M } from "./messages.js";
import { readTab, TABS, type TabId, writeTab } from "./url.js";

/** The component each tab renders below its heading; it renders no `<h2>`. */
export type TabComponents = Readonly<Record<TabId, ComponentType>>;

interface HomeValue {
	tab: TabId;
	goTo(tab: TabId): void;
	announce(text: string): void;
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
	const value = useMemo(() => ({ tab, goTo, announce }), [tab, goTo, announce]);
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
 * The Imports home: the access probe (as the wizard's), then the title, "New import" and the tabs.
 * A 403 shows only the administrators-only sentence; any other failure its sentence and "Try again".
 */
export function Home(props: { tabs: TabComponents }) {
	const t = useT();
	const access = useCredentials();
	const granted = access.data !== undefined;
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="text-2xl font-bold">{t(M.title)}</h1>
				{granted ? (
					// A button, as the admin's own list screens put "Add New" (Task 16).
					<LinkButton variant="secondary" href={WIZARD_URL}>
						{t(M.newImport)}
					</LinkButton>
				) : null}
			</div>
			{granted ? (
				// Once granted, the page stays: a later failed probe must not drop the open tab.
				<HomeProvider>
					<Content tabs={props.tabs} />
				</HomeProvider>
			) : access.isError ? (
				<AccessError
					error={access.error}
					retrying={access.isFetching}
					onRetry={() => void access.refetch()}
				/>
			) : (
				<Loader aria-label={t(M.checkingAccess)} />
			)}
		</div>
	);
}

function AccessError(props: { error: unknown; retrying: boolean; onRetry(): void }) {
	const t = useT();
	const { msg, values, detail } = describeError(props.error);
	if (msg.id === ERROR_MESSAGES.FORBIDDEN?.id) {
		return <Banner variant="alert" title={t(msg)} />;
	}
	return (
		<Banner
			variant="error"
			role="alert"
			title={t(msg, values)}
			{...(detail === undefined ? {} : { description: detail })}
			action={
				<Button
					variant="secondary"
					loading={props.retrying}
					// Kumo's spinner is labelled "Loading" in English: the label names the button.
					aria-label={t(PAGE.tryAgain)}
					aria-busy={props.retrying || undefined}
					onClick={props.onRetry}
				>
					{t(PAGE.tryAgain)}
				</Button>
			}
		/>
	);
}

function Content(props: { tabs: TabComponents }) {
	const t = useT();
	const { tab, goTo } = useHome();
	const Tab = props.tabs[tab];
	return (
		<>
			<Tabs
				tabs={TABS.map((id) => ({ value: id, label: t(M.tabs[id]) }))}
				value={tab}
				onValueChange={(v: string) => goTo(TABS.find((id) => id === v) ?? "jobs")}
			/>
			<div role="tabpanel" aria-label={t(M.tabs[tab])} className="space-y-4">
				<h2 className="text-xl font-semibold">{t(M.tabs[tab])}</h2>
				<Tab />
			</div>
		</>
	);
}
