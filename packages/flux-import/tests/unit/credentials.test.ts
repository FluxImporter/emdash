import { describe, expect, it } from "vitest";
import {
	CREDENTIALS_SETTING,
	deleteCredential,
	getCredential,
	listCredentials,
	setCredential,
} from "../../src/plugin/credentials.js";
import { ServiceError } from "../../src/plugin/service.js";
import { MemorySettings } from "./fakes.js";

const BEARER = { header: "Authorization", value: "Bearer s3cret-token" };
const API_KEY = { header: "X-Api-Key", value: "k-123" };

const stored = (settings: MemorySettings) =>
	JSON.parse(settings.values.get(CREDENTIALS_SETTING)?.value as string) as unknown;

describe("credentials", () => {
	it("stores credentials as one JSON setting and returns names and headers only", async () => {
		const settings = new MemorySettings();
		expect(await setCredential(settings, "supplier", BEARER)).toEqual({
			name: "supplier",
			header: "Authorization",
		});
		expect(await setCredential(settings, "partner-api", API_KEY)).toEqual({
			name: "partner-api",
			header: "X-Api-Key",
		});
		expect(await listCredentials(settings)).toEqual([
			{ name: "partner-api", header: "X-Api-Key" },
			{ name: "supplier", header: "Authorization" },
		]);
		expect(JSON.stringify(await listCredentials(settings))).not.toContain("s3cret");
		expect(stored(settings)).toEqual({ supplier: BEARER, "partner-api": API_KEY });
	});

	it("replaces a credential with the same name", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "supplier", BEARER);
		await setCredential(settings, "supplier", API_KEY);
		expect(await getCredential(settings, "supplier")).toEqual(API_KEY);
		expect(await listCredentials(settings)).toEqual([{ name: "supplier", header: "X-Api-Key" }]);
	});

	it("deletes a credential, and answers NOT_FOUND for an unknown one", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "supplier", BEARER);
		expect(await deleteCredential(settings, "supplier")).toEqual({ deleted: true });
		expect(await getCredential(settings, "supplier")).toBeNull();
		await expect(deleteCredential(settings, "supplier")).rejects.toEqual(
			new ServiceError("NOT_FOUND", 'Credential "supplier" not found', 404),
		);
	});

	it("reads no credentials before the first one is set", async () => {
		const settings = new MemorySettings();
		expect(await listCredentials(settings)).toEqual([]);
		expect(await getCredential(settings, "x")).toBeNull();
	});

	it("reads a value that is not the credentials JSON as none, and replaces it on the next set", async () => {
		const settings = new MemorySettings();
		for (const value of ["not json", "[1,2]", '"text"', '{"a": {"header": 1}}']) {
			settings.put(CREDENTIALS_SETTING, value);
			expect(await listCredentials(settings)).toEqual([]);
		}
		await setCredential(settings, "supplier", BEARER);
		expect(stored(settings)).toEqual({ supplier: BEARER });
	});

	it("retries when another writer changes the setting between read and write", async () => {
		const settings = new MemorySettings();
		await setCredential(settings, "first", BEARER);
		let concurrent = true;
		settings.beforeWrite = () => {
			if (!concurrent) return;
			concurrent = false;
			const current = JSON.parse(settings.values.get(CREDENTIALS_SETTING)!.value as string);
			settings.put(CREDENTIALS_SETTING, JSON.stringify({ ...current, other: API_KEY }));
		};
		await setCredential(settings, "second", API_KEY);
		expect(Object.keys(stored(settings) as object).sort()).toEqual(["first", "other", "second"]);
	});

	it("gives up with CONFLICT after five lost races", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => settings.put(CREDENTIALS_SETTING, "{}");
		await expect(setCredential(settings, "x", BEARER)).rejects.toEqual(
			new ServiceError("CONFLICT", "The credentials changed during the update; try again", 409),
		);
	});

	it("reports a missing encryption key as CREDENTIALS_UNAVAILABLE without the value", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => {
			throw Object.assign(new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY"), {
				code: "PLUGIN_SETTING_ENCRYPTION_KEY_MISSING",
			});
		};
		const error = await setCredential(settings, "supplier", BEARER).catch((e: unknown) => e);
		expect(error).toEqual(
			new ServiceError(
				"CREDENTIALS_UNAVAILABLE",
				"Credentials are unavailable: Plugin secret settings require EMDASH_ENCRYPTION_KEY",
				500,
			),
		);
		expect(JSON.stringify(error)).not.toContain("s3cret");
		expect((error as Error).message).not.toContain("s3cret");
	});

	it("passes other errors through", async () => {
		const settings = new MemorySettings();
		settings.beforeWrite = () => {
			throw new Error("disk full");
		};
		await expect(setCredential(settings, "supplier", BEARER)).rejects.toThrow("disk full");
	});
});
