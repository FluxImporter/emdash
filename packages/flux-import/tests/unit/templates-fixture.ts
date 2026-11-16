/** Shared helpers for the M6a saved-template unit tests. */
import { ServiceError } from "../../src/plugin/service.js";

/** The ServiceError `p` rejects with; anything else is rethrown, and a fulfilled `p` fails. */
export async function failure(p: Promise<unknown>): Promise<ServiceError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ServiceError) return e;
		throw e;
	}
	throw new Error("did not fail");
}
