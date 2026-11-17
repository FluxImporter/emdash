import type { ScheduleView } from "../../src/plugin/schedules.js";
import { withDb } from "./db.js";
import type { DevServer } from "./server.js";

export type { ScheduleView };

/** A cron task name this file writes into SQL: flux-import's own names and ULIDs only. */
const TASK_NAME = /^[0-9A-Za-z_-]{1,80}$/;

/** The tasks a schedule's launch needs: its due mark and the pump. */
export const taskNames = (scheduleId: string): string[] => [`schedule-${scheduleId}`, "pump"];

/** Polls `read` every 250 ms until `done` holds; fails with `label` and the last value. */
export async function waitFor<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	{ timeoutMs, label }: { timeoutMs: number; label: string },
): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last = await read();
	while (!done(last)) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
		}
		await new Promise((r) => setTimeout(r, 250));
		last = await read();
	}
	return last;
}

async function post(baseUrl: string, path: string): Promise<unknown> {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
	if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	return res.json();
}

/** Stops EmDash's cron timer for the rest of the server's life (plan Ruling 1, Fact V9). */
export async function stopCronTimer(baseUrl: string): Promise<void> {
	await post(baseUrl, "/test/stop-cron-timer");
}

/** One scheduler tick on Node: EmDash's `runScheduledTasks` through the test route (Fact V9). */
export async function runScheduled(baseUrl: string): Promise<void> {
	await post(baseUrl, "/test/run-scheduled");
}

/** The SQL that makes flux-import's `names` due now; names are checked, so the text is safe. */
export function dueSql(names: string[]): string {
	for (const name of names) {
		if (!TASK_NAME.test(name)) throw new Error(`Not a task name: ${name}`);
	}
	const list = names.map((name) => `'${name}'`).join(", ");
	return `UPDATE _emdash_cron_tasks SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE plugin_id = 'flux-import' AND task_name IN (${list})`;
}

/** Makes `names` due now in the Node site's SQLite file, with bound parameters. */
export function dueNow(dbPath: string, names: string[]): void {
	withDb(dbPath, (db) => {
		const marks = names.map(() => "?").join(", ");
		db.prepare(
			`UPDATE _emdash_cron_tasks SET next_run_at = ? WHERE plugin_id = 'flux-import' AND task_name IN (${marks})`,
		).run("2000-01-01T00:00:00.000Z", ...names);
	});
}

/** One deterministic tick on Node after `stopCronTimer`: `names` due, then one scheduler run. */
export async function tick(server: DevServer, names: string[]): Promise<void> {
	dueNow(server.dbPath, names);
	await runScheduled(server.baseUrl);
}
