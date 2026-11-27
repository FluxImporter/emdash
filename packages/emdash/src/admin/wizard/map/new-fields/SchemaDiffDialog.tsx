import { Banner, Button, Dialog, Loader } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { FieldChange } from "../../../../plugin/schema-apply.js";
import { type ApplyField, api } from "../../../api.js";
import { ApiError, redact } from "../../../api-error.js";
import { describeError } from "../../../errors.js";
import { type Msg, useT } from "../../../i18n.js";
import { MAX_APPLY_FIELDS } from "../../../limits.js";
import { M as SHARED } from "../../../messages.js";
import { queryKeys } from "../../../queries.js";
import type { ProposedField } from "../../state.js";
import { labelOf } from "./infer.js";
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

/**
 * The `schema/apply` fields for the proposed fields. A label is trimmed, and an empty one is left
 * out: the route then labels the field from its slug (`labelOf`).
 */
function toApply(fields: readonly ProposedField[]): ApplyField[] {
	return fields.map((f) => {
		const label = f.label.trim();
		return {
			slug: f.slug,
			// A proposed type is one of `APPLY_FIELD_TYPES`; the route refuses anything else.
			type: f.type as ApplyField["type"],
			...(label === "" ? {} : { label }),
			translatable: f.translatable,
			searchable: f.searchable,
		};
	});
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
	/** Why the plan failed; cleared with the plan. */
	const [planError, setPlanError] = useState<Described | null>(null);
	/** Why Confirm failed; kept while the list is planned again, cleared on close or a change. */
	const [applyError, setApplyError] = useState<Described | null>(null);
	/** Bumped to plan again: Try again, and after an apply that ended in an error. */
	const [attempt, setAttempt] = useState(0);
	const [applying, setApplying] = useState(false);
	const tooMany = p.fields.length > MAX_APPLY_FIELDS;
	// The request as text, so the plan reruns only when what would be sent changes.
	const request = JSON.stringify({ collection: p.collection, fields: toApply(p.fields) });

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `attempt` plans the same request again.
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
				setPlanError(describeError(e));
			},
		);
		return () => {
			// Closed, changed or planned again: the last plan, and its error, are not shown again.
			live = false;
			setPlan(LOADING);
			setPlanError(null);
		};
	}, [p.open, request, tooMany, attempt]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Confirm's error belongs to one opening of these fields.
	useEffect(
		() => () => {
			setApplyError(null);
		},
		[p.open, request],
	);

	const changes = plan.status === "ready" ? plan.changes : [];
	const conflicts = changes.some((c) => c.action === "conflict");
	const canConfirm = plan.status === "ready" && !conflicts && !applying;

	async function confirm() {
		setApplying(true);
		setApplyError(null);
		try {
			const input = parse(request);
			const result = await api.applySchema({ ...input, dryRun: false });
			// Whatever was applied, the wizard's copy of the fields may be stale (an `unchanged`
			// field was created elsewhere): read them again before the step uses them.
			await queryClient.invalidateQueries({ queryKey: queryKeys.fields(input.collection) });
			if (result.error !== null) {
				// EmDash's error, reported inside a successful (200) reply. Some fields may exist
				// now, so the list is planned again.
				const { code, message } = result.error;
				setApplyError(describeError(new ApiError(code, message, 200)));
				setAttempt((n) => n + 1);
				return;
			}
			setPlan({ status: "ready", changes: result.changes });
			p.onApplied(result.changes.filter((c) => KEPT.has(c.action)).map((c) => c.field));
		} catch (e) {
			setApplyError(describeError(e));
		} finally {
			setApplying(false);
		}
	}

	const requested = new Map(parse(request).fields.map((f) => [f.slug, f]));
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
				<Dialog.Title className="text-lg font-semibold">{t(M.dialogTitle)}</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
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
										label: requested.get(c.field)?.label ?? labelOf(c.field),
										slug: c.field,
										type: c.type,
									})}
								</span>
								{c.action === "create" ? (
									<span className="block text-kumo-subtle">
										{t(M.flags, {
											translatable: t(
												requested.get(c.field)?.translatable === false ? M.no : M.yes,
											),
											searchable: t(requested.get(c.field)?.searchable === true ? M.yes : M.no),
										})}
									</span>
								) : null}
								{c.message === undefined ? null : (
									<span className="block text-kumo-subtle">{redact(c.message)}</span>
								)}
							</li>
						))}
					</ul>
				) : null}
				{conflicts ? <p className="text-sm text-kumo-danger">{t(M.conflictsBlock)}</p> : null}
				{planError === null ? null : (
					<ErrorBanner
						error={planError}
						action={
							<Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
								{t(SHARED.tryAgain)}
							</Button>
						}
					/>
				)}
				{applyError === null ? null : <ErrorBanner error={applyError} />}
				<div className="flex justify-end gap-3">
					<Button variant="secondary" disabled={applying} onClick={cancel}>
						{t(M.cancel)}
					</Button>
					<Button
						variant="primary"
						disabled={!canConfirm}
						loading={applying}
						// Kumo's spinner is labelled "Loading" in English: the label names the button.
						aria-label={t(M.confirm)}
						aria-busy={applying || undefined}
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
function ErrorBanner({ error, action }: { error: Described; action?: ReactNode }) {
	const t = useT();
	const problems = error.problems ?? [];
	return (
		<Banner
			role="alert"
			variant="error"
			title={t(error.msg, error.values)}
			action={action}
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
