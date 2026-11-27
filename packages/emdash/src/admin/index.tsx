import type { PluginAdminExports } from "emdash";
import { SOURCE_ID_WIDGET, SourceIdField } from "./fields/SourceIdField.js";
import { Home, type TabComponents } from "./home/Home.js";
import { JobsTab } from "./home/jobs/JobsTab.js";
import { SchedulesTab } from "./home/schedules/SchedulesTab.js";
import { SourcesTab } from "./home/sources/SourcesTab.js";
import { TemplatesTab } from "./home/templates/TemplatesTab.js";
import { MapStep } from "./wizard/map/MapStep.js";
import { OptionsStep } from "./wizard/options/OptionsStep.js";
import { PreviewStep } from "./wizard/preview/PreviewStep.js";
import { RunStep } from "./wizard/run/RunStep.js";
import { SourceStep } from "./wizard/source/SourceStep.js";
import { TargetStep } from "./wizard/target/TargetStep.js";
import { type StepComponents, Wizard } from "./wizard/Wizard.js";

/**
 * The admin entry (`@fluximporter/emdash/admin`): EmDash's admin renders each page with no props, inside
 * its own `I18nProvider` and `QueryClientProvider` (Facts V7, V8).
 */

const STEPS: StepComponents = {
	source: SourceStep,
	target: TargetStep,
	map: MapStep,
	options: OptionsStep,
	preview: PreviewStep,
	run: RunStep,
};

const TABS: TabComponents = {
	jobs: JobsTab,
	templates: TemplatesTab,
	sources: SourcesTab,
	schedules: SchedulesTab,
};

/** The Imports home, at `/_emdash/admin/plugins/fluximporter/imports` (each tab inside `HomeProvider`). */
function ImportsPage() {
	return <Home tabs={TABS} />;
}

/** The import wizard ("New import"), at `/_emdash/admin/plugins/fluximporter/import`. */
function ImportPage() {
	return <Wizard steps={STEPS} />;
}

/** The home first, as in the descriptor's `admin.pages` (Fact V1). */
export const pages: PluginAdminExports["pages"] = {
	"/imports": ImportsPage,
	"/import": ImportPage,
};

/** `flux_source_id`'s editor widget, `"fluximporter:source-id"` (plan Ruling 1). */
export const fields: PluginAdminExports["fields"] = { [SOURCE_ID_WIDGET]: SourceIdField };
