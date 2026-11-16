/** The saved-template errors the template routes, `jobs/create` and `schema/apply` share (M6a). */
import { ServiceError } from "./service.js";

/**
 * No template with that ID: `NOT_FOUND` on the template routes, `TEMPLATE_NOT_FOUND` on
 * `jobs/create` and `schema/apply`.
 */
export function templateNotFound(
	code: "NOT_FOUND" | "TEMPLATE_NOT_FOUND",
	id: string,
): ServiceError {
	return new ServiceError(code, `Template ${id} not found`, 404);
}

/** The caller named revision `given` of a template that is at `current`. */
export function staleTemplate(id: string, current: number, given: number): ServiceError {
	return new ServiceError(
		"TEMPLATE_CHANGED",
		`Template ${id} is at revision ${current}, not ${given}; read it again`,
		409,
		{ revision: current },
	);
}

/** Throws `staleTemplate` when the caller named a revision other than the template's. */
export function assertRevision(id: string, current: number, given: number | undefined): void {
	if (given !== undefined && given !== current) throw staleTemplate(id, current, given);
}
