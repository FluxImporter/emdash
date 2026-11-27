import { Button, Dialog } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { useT } from "../../i18n.js";
import { M } from "./messages.js";

/**
 * A confirmation before a change that cannot be undone (as `SchemaDiffDialog`): a title, one
 * sentence, optional details, and Cancel (or `cancelLabel`) and the confirm button. Escape and
 * Cancel close it unless `busy`; the confirm button shows `busy`.
 */
export function ConfirmDialog(props: {
	open: boolean;
	title: string;
	sentence: string;
	confirmLabel: string;
	/** The dismiss button's text, when "Cancel" would read as the action itself. */
	cancelLabel?: string;
	danger?: boolean;
	busy: boolean;
	error?: ReactNode;
	children?: ReactNode;
	onConfirm(): void;
	onClose(): void;
}) {
	const t = useT();
	const close = () => {
		if (!props.busy) props.onClose();
	};
	return (
		<Dialog.Root
			open={props.open}
			onOpenChange={(open: boolean) => {
				if (!open) close();
			}}
		>
			<Dialog size="lg" className="space-y-4 p-6">
				<Dialog.Title className="text-lg font-semibold">{props.title}</Dialog.Title>
				<Dialog.Description className="text-sm text-kumo-subtle">
					{props.sentence}
				</Dialog.Description>
				{props.children}
				{props.error}
				<div className="flex justify-end gap-3">
					<Button variant="secondary" disabled={props.busy} onClick={close}>
						{props.cancelLabel ?? t(M.cancel)}
					</Button>
					<Button
						variant={props.danger === true ? "destructive" : "primary"}
						loading={props.busy}
						// Kumo's spinner is labelled "Loading" in English: the label names the button.
						aria-label={props.confirmLabel}
						aria-busy={props.busy || undefined}
						disabled={props.busy}
						onClick={props.onConfirm}
					>
						{props.confirmLabel}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
