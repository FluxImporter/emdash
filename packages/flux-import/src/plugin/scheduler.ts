/** The cron hook's dispatch and plugin activation (M6b spec "Cron tasks and the hook", plan Ruling 17). */
import type { PluginContext } from "emdash";
import { pluginCollections } from "../emdash/storage.js";
import { markDue } from "./launch.js";
import { pumpDeps, pumpTick } from "./pump.js";
import {
	purgeExpired,
	RETENTION_DAYS_DEFAULT,
	RETENTION_QUERY_TARGET,
	RETENTION_SCAN_MAX,
	RETENTION_TASK,
} from "./retention.js";
import { cronOf, PUMP_TASK, reconcile, scheduleIdOf, schedulesCollection } from "./schedules.js";
import { withScheduledServices } from "./services.js";
import { latestSourceUploads, sourcesCollection } from "./sources.js";
import { redact } from "./summaries.js";

/** Above a launch's 120 s fetch plus job creation (spec Ruling 16). */
export const CRON_HOOK_TIMEOUT_MS = 180_000;

/** The cron hook's event (emdash 1.2.0 does not export its type, `dist/types-C4P7F1Vq.d.mts:836`). */
export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

/** `retention`: the bounded purge, then the reconciliation of the tasks (spec "Reconciliation"). */
async function retention(ctx: PluginContext): Promise<void> {
	const days = (await ctx.settings.get<number>("retentionDays")) ?? RETENTION_DAYS_DEFAULT;
	await withScheduledServices(ctx, async ({ deps, uploads }) => {
		const schedules = schedulesCollection(ctx.storage);
		const keep = await latestSourceUploads(sourcesCollection(ctx.storage));
		const result = await purgeExpired(deps, uploads, days, keep, {
			schedules,
			kv: ctx.kv,
			target: RETENTION_QUERY_TARGET,
		});
		if (result.skipped === undefined) {
			ctx.log.info("Removed expired import data", result);
		} else {
			ctx.log.warn(
				`flux-import: retention deleted nothing: more than ${RETENTION_SCAN_MAX} jobs are kept; lower retentionDays`,
				result,
			);
		}
		const repaired = await reconcile({ schedules, jobs: deps.jobs, cron: cronOf(ctx) });
		const changed =
			repaired.scheduled.length > 0 ||
			repaired.cancelled.length > 0 ||
			repaired.failed.length > 0 ||
			repaired.pump ||
			repaired.retention;
		// IDs and task names only: reconcile keeps no message (spec Ruling 47).
		if (changed) ctx.log.info("Repaired the schedule tasks", repaired);
	});
}

/**
 * The plugin's cron hook: `retention`, `pump` and each `schedule-<id>`. An expected failure is
 * recorded on its schedule and never thrown; an unexpected one is logged, redacted, and rethrown,
 * which EmDash logs, leaving a recurring task for its next run (spec F4, preflight F12).
 */
export async function cronHook(event: CronEvent, ctx: PluginContext): Promise<void> {
	try {
		if (event.name === RETENTION_TASK) {
			await retention(ctx);
			return;
		}
		if (event.name === PUMP_TASK) {
			// The scheduled services: no actor, so the batch's writes are unattributed (spec Ruling 5).
			const tick = await withScheduledServices(ctx, (services) =>
				pumpTick(pumpDeps(ctx, services)),
			);
			const worked =
				tick.batch !== undefined ||
				tick.launch !== undefined ||
				tick.finalized.length > 0 ||
				(tick.closed?.length ?? 0) > 0;
			if (worked) ctx.log.info("Pump tick", tick);
			return;
		}
		const id = scheduleIdOf(event.name);
		if (id !== null) {
			const deps = { schedules: schedulesCollection(ctx.storage), cron: cronOf(ctx) };
			await markDue(deps, id, event.scheduledAt);
		}
	} catch (e) {
		ctx.log.error(`flux-import: cron task ${event.name} failed`, {
			error: redact(e instanceof Error ? e.message : String(e)),
		});
		throw e;
	}
}

/**
 * `plugin:activate`: repairs every task from storage, `retention` included (plan Ruling 17). No
 * runtime: on a fresh database this hook runs inside the runtime's own creation, whose init lock
 * a second caller would wait on (preflight F5). A schedule whose task could not be set is logged
 * by ID; the hourly reconciliation tries it again.
 */
export async function activate(ctx: PluginContext): Promise<void> {
	const result = await reconcile({
		schedules: schedulesCollection(ctx.storage),
		jobs: pluginCollections(ctx.storage).jobs,
		cron: cronOf(ctx),
	});
	if (result.failed.length > 0) {
		ctx.log.warn(`flux-import: ${result.failed.length} schedule task(s) could not be scheduled`, {
			failed: result.failed,
		});
	}
}
