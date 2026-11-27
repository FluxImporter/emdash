import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fluxImporterDefault, {
	createPlugin,
	FLUX_IMPORTER_ID,
	FLUX_IMPORTER_VERSION,
	fluxImporter,
} from "../../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	name: string;
	version: string;
};

describe("fluxImporter descriptor", () => {
	it("describes a native plugin with matching id and version", () => {
		const d = fluxImporter();
		expect(d.id).toBe(FLUX_IMPORTER_ID);
		expect(d.id).toBe("fluximporter");
		expect(d.version).toBe(FLUX_IMPORTER_VERSION);
		expect(d.format).toBe("native");
		expect(d.entrypoint).toBe(pkg.name);
	});

	it("keeps the npm version, the descriptor and definePlugin() on one version", () => {
		expect(pkg.name).toBe("@fluximporter/emdash");
		expect(FLUX_IMPORTER_VERSION).toBe(pkg.version);
		expect(createPlugin().version).toBe(pkg.version);
	});

	it("exports the descriptor factory as the default too", () => {
		expect(fluxImporterDefault).toBe(fluxImporter);
	});
});
