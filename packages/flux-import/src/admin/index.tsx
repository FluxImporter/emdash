import type { PluginAdminExports } from "emdash";
import { SOURCE_ID_WIDGET, SourceIdField } from "./fields/SourceIdField.js";
import { MapStep } from "./wizard/map/MapStep.js";
import { OptionsStep } from "./wizard/options/OptionsStep.js";
import { PreviewStep } from "./wizard/preview/PreviewStep.js";
import { RunStep } from "./wizard/run/RunStep.js";
import { SourceStep } from "./wizard/source/SourceStep.js";
import { TargetStep } from "./wizard/target/TargetStep.js";
import { type StepComponents, Wizard } from "./wizard/Wizard.js";

/**
 * The admin entry (`flux-import/admin`): EmDash's admin renders each page with no props, inside
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

/** The import wizard, at `/_emdash/admin/plugins/flux-import/import`. */
function ImportPage() {
	return <Wizard steps={STEPS} />;
}

export const pages: PluginAdminExports["pages"] = { "/import": ImportPage };

/** `flux_source_id`'s editor widget, `"flux-import:source-id"` (plan Ruling 1). */
export const fields: PluginAdminExports["fields"] = { [SOURCE_ID_WIDGET]: SourceIdField };
