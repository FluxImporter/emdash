import { Banner, Button, Dialog, Loader } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FieldChange } from "../../../../plugin/schema-apply.js";
import { type ApplyField, api } from "../../../api.js";
import { ApiError, redact } from "../../../api-error.js";
import { describeError } from "../../../errors.js";
import { type Msg, useT } from "../../../i18n.js";
import { MAX_APPLY_FIELDS } from "../../../limits.js";
import { queryKeys } from "../../../queries.js";
import type { ProposedField } from "../../state.js";
import { M } from "./messages.js";

type Described = ReturnType<typeof describeError>;

type Plan =
	| { status: "loading" }
	| { status: "ready"; changes: FieldChange[] }
	| { status: "failed" };

const LOADING: Plan = { status: "loading" };

/** The changes that leave the field in the collection: everything but a conflict (preflight F16). */
const KEPT: ReadonlySet<FieldChange["action"]> = new Set(["create", "add_options", "unchanged"]);

const CHANGE_MESSAGES: Readonly<Record<FieldChange["action"], Msg>> = {
	create: M.create,
	add_options: M.addOptions,
	unchanged: M.unchanged,
	conflict: M.conflict,
};

/** The `schema/apply` fields for the proposed fields. */
function toApply(fields: readonly ProposedField[]): ApplyField[] {
	return fields.map((f) => ({
		slug: f.slug,
		// A proposed type is one of `APPLY_FIELD_TYPES`; the route refuses anything else.
		type: f.type as ApplyField["type"],
		label: f.label,
		translatable: f.translatable,
		searchable: f.searchable,
	}));
}

const parse = (request: string) =>
	JSON.parse(request) as { collection: string; fields: ApplyField[] };

/**
 * Confirms the proposed fields before Map is left (spec "New fields"). On open it plans them with
 * `schema/apply { dryRun: true }` and lists each change; Confirm, allowed only without conflicts,
 * applies the same fields and reports the proposed slugs now in the collection. Cancel writes
 * nothing. An error, from the route or in the result, is shown and the dialog stays open.
 */
export function SchemaDiffDialog(p: {
	collection: string;
	fields: readonly ProposedField[];
	open: boolean;
	onApplied(slugs: string[]): void;
	onCancel(): void;
}) {
	const t = useT();
	const queryClient = useQueryClient();
	const [plan, setPlan] = useState<Plan>(LOADING);
	const [error, setError] = useState<Described | null>(null);
	const [applying, setApplying] = useState(false);
	const tooMany = p.fields.length > MAX_APPLY_FIELDS;
	// The request as text, so the plan reruns only when what would be sent changes.
	const request = JSON.stringify({ collection: p.collection, fields: toApply(p.fields) });

	useEffect(() => {
		if (!p.open || tooMany) return;
		let live = true;
		api.applySchema({ ...parse(request), dryRun: true }).then(
			(result) => {
				if (live) setPlan({ status: "ready", changes: result.changes });
			},
			(e: unknown) => {
				if (!live) return;
				setPlan({ status: "failed" });
				setError(describeError(e));
			},
		);
		return () => {
			// Closed, or the fields changed: no plan or error of these fields is shown again.
			live = false;
			setPlan(LOADING);
			setError(null);
		};
	}, [p.open, request, tooMany]);

	const changes = plan.status === "ready" ? plan.changes : [];
	const conflicts = changes.some((c) => c.action === "conflict");
	const canConfirm = plan.status === "ready" && !conflicts && !applying;

	async function confirm() {
		setApplying(true);
		setError(null);
		try {
			const input = parse(request);
			const result = await api.applySchema({ ...input, dryRun: false });
			// The schema changed, even if an error stopped the rest: read the fields again.
			if (result.applied.length > 0) {
				void queryClient.invalidateQueries({ queryKey: queryKeys.fields(input.collection) });
			}
			setPlan({ status: "ready", changes: result.changes });
			if (result.error !== null) {
				// EmDash's error, reported inside a successful (200) reply.
				const { code, message } = result.error;
				setError(describeError(new ApiError(code, message, 200)));
				return;
			}
			p.onApplied(result.changes.filter((c) => KEPT.has(c.action)).map((c) => c.field));
		} catch (e) {
			setError(describeError(e));
		} finally {
			setApplying(false);
		}
	}

	const labels = new Map(p.fields.map((f) => [f.slug, f.label === "" ? f.slug : f.label]));
	const cancel = () => {
		if (!applying) p.onCancel();
	};

	return (
		<Dialog.Root
			open={p.open}
			onOpenChange={(open: boolean) => {
				if (!open) cancel();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title>{t(M.dialogTitle)}</Dialog.Title>
				<Dialog.Description>
					{t(M.dialogDescription, { collection: p.collection })}
				</Dialog.Description>
				{tooMany ? (
					<Banner
						variant="alert"
						description={t(M.tooMany, {
							max: MAX_APPLY_FIELDS,
							extra: p.fields.length - MAX_APPLY_FIELDS,
						})}
					/>
				) : plan.status === "loading" ? (
					<div className="flex items-center gap-3 text-sm text-kumo-subtle">
						<Loader />
						<span>{t(M.planning)}</span>
					</div>
				) : changes.length > 0 ? (
					<ul className="max-h-96 space-y-2 overflow-y-auto">
						{changes.map((c) => (
							<li key={c.field} className="text-sm">
								<span className={c.action === "conflict" ? "text-kumo-danger" : ""}>
									{t(CHANGE_MESSAGES[c.action], {
										label: labels.get(c.field) ?? c.field,
										slug: c.field,
										type: c.type,
									})}
								</span>
								{c.message === undefined ? null : (
									<span className="block text-kumo-subtle">{redact(c.message)}</span>
								)}
							</li>
						))}
					</ul>
				) : null}
				{conflicts ? <p className="text-sm text-kumo-danger">{t(M.conflictsBlock)}</p> : null}
				{error === null ? null : <ErrorBanner error={error} />}
				<div className="flex justify-end gap-3">
					<Button variant="secondary" disabled={applying} onClick={cancel}>
						{t(M.cancel)}
					</Button>
					<Button
						variant="primary"
						disabled={!canConfirm}
						loading={applying}
						onClick={() => {
							void confirm();
						}}
					>
						{t(M.confirm)}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** An error sentence, with the route's specifics under it (Task 4 review). */
function ErrorBanner({ error }: { error: Described }) {
	const t = useT();
	const problems = error.problems ?? [];
	return (
		<Banner
			role="alert"
			variant="error"
			title={t(error.msg, error.values)}
			description={
				error.detail === undefined && problems.length === 0 ? undefined : (
					<>
						{error.detail === undefined ? null : <span className="block">{error.detail}</span>}
						{problems.length === 0 ? null : (
							<ul className="list-disc pl-4">
								{problems.map((problem) => (
									<li key={problem}>{problem}</li>
								))}
							</ul>
						)}
					</>
				)
			}
		/>
	);
}
