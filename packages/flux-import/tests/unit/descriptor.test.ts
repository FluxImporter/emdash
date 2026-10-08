import { describe, expect, it } from "vitest";
import { FLUX_IMPORT_ID, FLUX_IMPORT_VERSION, fluxImport } from "../../src/index.js";

describe("fluxImport descriptor", () => {
	it("describes a native plugin with matching id and version", () => {
		const d = fluxImport();
		expect(d.id).toBe(FLUX_IMPORT_ID);
		expect(d.id).toBe("flux-import");
		expect(d.version).toBe(FLUX_IMPORT_VERSION);
		expect(d.format).toBe("native");
		expect(d.entrypoint).toBe("flux-import");
	});
});
