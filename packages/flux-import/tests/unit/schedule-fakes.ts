import type { Job } from "../../src/engine/types.js";
import { STORAGE } from "../../src/plugin/definition.js";
import type { CronPort, ScheduleDeps, ScheduleRow } from "../../src/plugin/schedules.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { SavedTemplate } from "../../src/plugin/templates.js";
import { MemoryKv } from "./fakes.js";

export const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const AT = new Date(NOW).toISOString();

/** EmDash's cron for one plugin, in memory: names, expressions and data (spec F1, F3). */
export class FakeCron implements CronPort {
	readonly tasks = new Map<string, { schedule: string; data?: Record<string, unknown> }>();
	readonly calls: string[] = [];
	/** The expression `schedule()` refuses, as EmDash refuses a date that never comes (Fact E1). */
	refuse = "0 3 31 2 *";

	async schedule(name: string, opts: { schedule: string; data?: Record<string, unknown> }) {
		this.calls.push(`schedule ${name} ${opts.schedule}`);
		if (opts.schedule === this.refuse) {
			throw new Error(`Invalid cron expression or no future run: "${opts.schedule}"`);
		}
		const task = { schedule: opts.schedule };
		this.tasks.set(name, opts.data === undefined ? task : { ...task, data: opts.data });
	}

	async cancel(name: string) {
		this.calls.push(`cancel ${name}`);
		this.tasks.delete(name);
	}

	async list() {
		return [...this.tasks].map(([name, t]) => ({
			name,
			schedule: t.schedule,
			nextRunAt: "2026-11-18T03:00:00.000Z",
			lastRunAt: null,
		}));
	}
}

export const PLAIN = {
	version: 1,
	collection: "products",
	locale: "en",
	key: { from: "sku" },
	fields: { title: { from: "Name", type: "text" } },
};
export const OWNED = {
	...PLAIN,
	rules: { owner: "shop", missing: { action: "trash", maxPercent: 10 } },
};

export function savedTemplate(id: string, template: object = PLAIN, revision = 1): SavedTemplate {
	return {
		id,
		name: id,
		template: template as SavedTemplate["template"],
		revision,
		collection: "products",
		locale: "en",
		format: "csv",
		createdAt: "",
		updatedAt: "",
		createdBy: "admin",
		updatedBy: "admin",
	};
}

export function sourceRow(id: string, extra: Partial<SourceRow> = {}): SourceRow {
	return {
		id,
		name: id,
		url: `https://feeds.example/${id}.csv`,
		createdAt: "",
		updatedAt: "",
		...extra,
	};
}

/** A schedule row as `createSchedule` writes it, on T1 and S1. */
export function scheduleRow(id: string, extra: Partial<ScheduleRow> = {}): ScheduleRow {
	return {
		id,
		name: id,
		templateId: "T1",
		templateRevision: 1,
		sourceId: "S1",
		sourcePin: "pin",
		cron: "0 3 * * *",
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		enabled: true,
		runs: [],
		launchFailures: 0,
		armedBy: "admin",
		revision: 1,
		createdAt: AT,
		updatedAt: AT,
		createdBy: "admin",
		updatedBy: "admin",
		...extra,
	};
}

export function jobRow(id: string, extra: Partial<Job> = {}): Job {
	return {
		id,
		status: "created",
		uploadId: "u1",
		template: PLAIN as unknown as Job["template"],
		dryRun: false,
		publish: true,
		batchSize: 50,
		budgetMs: 4000,
		cursor: { offset: 0, seq: 0 },
		counters: {
			created: 0,
			updated: 0,
			unchanged: 0,
			locked: 0,
			conflict: 0,
			failed: 0,
			filtered: 0,
		},
		lease: null,
		phase: "import",
		retryFromSeq: 0,
		schemaReady: false,
		error: null,
		failures: 0,
		createdAt: "2026-11-17T11:00:00.000Z",
		updatedAt: "2026-11-17T11:00:00.000Z",
		...extra,
	};
}

/**
 * The schedule service's dependencies in memory, with the indexes the plugin declares: templates
 * T1 (plain) and T2 (`rules.missing` at 10 %), source S1. `problems` are the site problems every
 * template has while the test sets them.
 */
export async function scheduleDeps() {
	const clock = { t: NOW };
	const problems: string[] = [];
	let ids = 0;
	const deps = {
		schedules: new MemoryKv<ScheduleRow>(STORAGE.schedules.indexes),
		jobs: new MemoryKv<Job>(STORAGE.jobs.indexes),
		templates: new MemoryKv<SavedTemplate>(STORAGE.templates.indexes),
		sources: new MemoryKv<SourceRow>(STORAGE.sources.indexes),
		cron: new FakeCron(),
		templateProblems: async () => [...problems],
		now: () => clock.t,
		newId: () => `SCH${++ids}`,
	} satisfies ScheduleDeps;
	await deps.templates.put("T1", savedTemplate("T1"));
	await deps.templates.put("T2", savedTemplate("T2", OWNED));
	await deps.sources.put("S1", sourceRow("S1"));
	return { deps, clock, problems };
}
