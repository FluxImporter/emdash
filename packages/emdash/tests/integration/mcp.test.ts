/**
 * M6c on sites/dev (SQLite) with the SDK's real MCP client: consent, scopes, the acceptance
 * sequence three ways, and the refusals (spec "Testing"). Its own server on 4391: URL sources
 * here fetch from 127.0.0.1, which needs allowPrivateNetwork.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_PREFIX } from "../../src/emdash/uploads.js";
import type { Job } from "../../src/engine/types.js";
import type { SourceRow } from "../../src/plugin/sources.js";
import type { StepReply } from "../../src/plugin/summaries.js";
import type { SavedResult } from "../../src/plugin/templates.js";
import { Client, devBypass } from "./client.js";
import { createUserToken, withDb } from "./db.js";
import { FeedServer } from "./feed-server.js";
import { productsCsv, template } from "./fixtures.js";
import {
	agentImport,
	call,
	connectMcp,
	drive,
	enableTools,
	json,
	type McpClient,
	mintToken,
	revokeToken,
	seen,
	TOOL_NAMES,
	TOOL_PREFIX,
	tool,
	UPLOAD_ID_PATTERN,
} from "./mcp-client.js";
import { type DevServer, startServer, stopServer } from "./server.js";

const PORT = 4391;
/** The consent snapshot tests/unit/mcp.test.ts pins (spec Ruling 20). */
const CONSENT_FIXTURE = new URL("../unit/fixtures/mcp-consent.txt", import.meta.url);

let server: DevServer;
let admin: Client;
let agent: McpClient;
const feeds = new FeedServer();
const clients: McpClient[] = [];
/** Every PAT minted here, revoked in `afterAll`. */
const minted: string[] = [];

async function connect(bearer: string): Promise<McpClient> {
	const mcp = await connectMcp(server.baseUrl, bearer);
	clients.push(mcp);
	return mcp;
}

async function mint(scopes: string[]): Promise<string> {
	const { token, id } = await mintToken(admin, scopes);
	minted.push(id);
	return token;
}

async function saveTemplate(name: string, body: object): Promise<string> {
	const saved = await admin.plugin<SavedResult>("templates/create", { name, template: body });
	return saved.template.id;
}

const listed = async (mcp: McpClient) =>
	(await mcp.listTools()).tools.filter((t) => t.name.startsWith(TOOL_PREFIX));

const toolAudits = () =>
	withDb(server.dbPath, (db) =>
		db
			.prepare(
				"SELECT resource_id AS tool, status FROM audit_logs WHERE action = 'plugin_tool_invoke'",
			)
			.all(),
	) as { tool: string; status: string }[];

const storedConsent = () =>
	withDb(server.dbPath, (db) =>
		db
			.prepare("SELECT mcp_tools_consent AS consent FROM _plugin_state WHERE plugin_id = ?")
			.get("fluximporter"),
	) as { consent: string | null } | undefined;

beforeAll(async () => {
	await feeds.start();
	server = await startServer(PORT, undefined, undefined, true);
	admin = new Client(server.baseUrl, await devBypass(server.baseUrl));
	for (const slug of ["it_mcp", "it_mcp_owned", "it_mcp_url", "it_mcp_no"]) {
		await admin.createProducts(slug);
	}
});

afterAll(async () => {
	for (const mcp of clients) await mcp.close().catch(() => {});
	try {
		for (const id of minted) await revokeToken(admin, id).catch(() => {});
		// `server` is unset when startServer threw in beforeAll.
		if (server) {
			await stopServer(server);
			await rm(server.dir, { recursive: true, force: true });
		}
	} finally {
		await feeds.stop();
	}
});

describe("M6c MCP tools on sites/dev", () => {
	it("lists no tool before consent, and the eight after it, two destructive (V1, V4)", async () => {
		const before = await connect(admin.token);
		expect(await listed(before)).toEqual([]);
		const early = await tool(before, "list_templates", {});
		expect(early.isError).toBe(true);
		expect(early.text).toContain("Tool fluximporter__list_templates not found");

		await enableTools(admin);
		// EmDash's own serializer stored the snapshot the unit test pins (spec F3, Ruling 20).
		expect(storedConsent()?.consent).toBe(await readFile(CONSENT_FIXTURE, "utf8"));
		agent = await connect(await mint(["mcp:tools:fluximporter"]));
		const tools = await listed(agent);
		expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.map((n) => TOOL_PREFIX + n));
		for (const t of tools) {
			const destructive = ["start_import", "next_batch"].some((n) => t.name.endsWith(n));
			expect(t.annotations?.destructiveHint, t.name).toBe(destructive);
		}
	});

	it("lets an Admin PAT with mcp:tools call the tools (V5)", async () => {
		const wide = await connect(await mint(["mcp:tools"]));
		const result = await tool(wide, "list_templates", {});
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.text)).toHaveProperty("items");
	});

	it("completes the agent's flow with pasted text, starts it once, and rolls it back", async () => {
		const templateId = await saveTemplate("Plain", template("it_mcp"));
		const run = await agentImport(agent, templateId, { text: productsCsv(20) });
		expect(run.dryRun).toMatchObject({ status: "completed", origin: "agent", missing: null });
		expect(run.dryRun.counters).toMatchObject({ created: 20, failed: 0 });
		expect(run.planned).toHaveLength(10);
		expect(run.planned[0]?.changes.map((c) => c.field)).toContain("title");
		expect(run.real).toMatchObject({
			status: "completed",
			dryRun: false,
			origin: "agent",
			dryRunOf: run.dryRun.id,
			counters: { created: 20, failed: 0 },
		});
		const entries = await admin.listAll("it_mcp");
		expect(entries).toHaveLength(20);
		expect(entries.every((e) => e.status === "published")).toBe(true);
		const first = entries.find((e) => e.data.flux_source_id === "SKU-0");
		expect(first?.data).toMatchObject({ title: 'Product 0, "quoted"', price: 0.5 });
		const stored = await admin.plugin<Job>("jobs/get", { id: run.real.id });
		expect(stored).toMatchObject({ journal: true, origin: "agent" });
		expect(stored).not.toHaveProperty("sourceId");

		const again = await json<{ job: { id: string } }>(agent, "start_import", {
			dryRunId: run.dryRun.id,
		});
		expect(again.job.id).toBe(run.real.id);
		const rollback = await admin.plugin<Job>("jobs/rollback", { id: run.real.id });
		// A rollback job never carries the agent marker, so the tools cannot advance it.
		expect(await tool(agent, "next_batch", { id: rollback.id })).toMatchObject({
			isError: true,
			code: "JOB_NOT_AGENT",
		});
		expect(await admin.runToEnd(rollback.id)).toMatchObject({ status: "completed" });
		// The rollback deletes the entries the import created, not into Trash (as M5a's).
		expect(await admin.listAll("it_mcp")).toEqual([]);
		const trash = await admin.api<{ items: unknown[] }>(
			"GET",
			"/_emdash/api/content/it_mcp/trash?locale=en",
		);
		expect(trash.items).toEqual([]);
		const used = await tool(agent, "start_import", { dryRunId: run.dryRun.id });
		expect(used).toMatchObject({ isError: true, code: "DRY_RUN_USED" });
		expect(used.details).toEqual({ jobId: run.real.id });
	});

	it("never removes an owned entry the agent's data leaves out (spec Ruling 29)", async () => {
		const owned = {
			...template("it_mcp_owned"),
			rules: { owner: "shop", missing: { action: "unpublish" } },
		};
		// An Admin's import of 21 rows makes SKU-20 an entry the template owns.
		const { uploadId } = await admin.upload(productsCsv(21));
		const first = await admin.plugin("jobs/create", { uploadId, template: owned, dryRun: false });
		await admin.runToEnd(first.id);
		const templateId = await saveTemplate("Owned", owned);
		const run = await agentImport(agent, templateId, { text: productsCsv(20) });
		expect(run.dryRun.missing).toBe(false);
		expect(run.real).toMatchObject({ missing: false, counters: { unchanged: 20, removed: 0 } });
		expect(run.real).not.toHaveProperty("missingPhase");
		const left = (await admin.listAll("it_mcp_owned")).find(
			(e) => e.data.flux_source_id === "SKU-20",
		);
		expect(left?.status).toBe("published");
	});

	it("imports a URL source by its ID, recording the fetch but no import (spec Ruling 9)", async () => {
		feeds.feeds.set("/m6c.csv", { body: productsCsv(20) });
		const source = await admin.plugin<SourceRow>("sources/create", {
			name: "m6c",
			url: feeds.url("/m6c.csv"),
		});
		const templateId = await saveTemplate("Url", template("it_mcp_url"));
		const run = await agentImport(agent, templateId, { sourceId: source.id });
		expect(run.real.counters).toMatchObject({ created: 20 });
		const after = await admin.plugin<SourceRow>("sources/get", { id: source.id });
		expect(after.lastFetch).toBeDefined();
		expect(after.lastImport).toBeUndefined();
		const urlEntries = await admin.listAll("it_mcp_url");
		expect(urlEntries).toHaveLength(20);
		expect(urlEntries.every((e) => e.status === "published")).toBe(true);
	});

	it("refuses what the token, the input or the job does not allow", async () => {
		const adminMcp = await connect(admin.token);
		expect(await tool(adminMcp, "list_templates", {})).toMatchObject({
			isError: true,
			code: "INSUFFICIENT_SCOPE",
		});
		expect(await call(agent, "content_list", { collection: "it_mcp" })).toMatchObject({
			isError: true,
			code: "INSUFFICIENT_SCOPE",
		});
		const editor = await connect(createUserToken(server.dbPath, 40, ["mcp:tools"]));
		expect(await tool(editor, "list_templates", {})).toMatchObject({
			isError: true,
			code: "INSUFFICIENT_PERMISSIONS",
		});
		// M6d's read tools need import:execute too (spec "Security").
		for (const name of ["list_sources", "list_schedules"]) {
			expect(await tool(editor, name, {}), name).toMatchObject({
				isError: true,
				code: "INSUFFICIENT_PERMISSIONS",
			});
		}

		const templateId = await saveTemplate("Refusals", template("it_mcp_no"));
		const audits = toolAudits().length;
		const bogus = await tool(agent, "dry_run", { templateId, text: "x", bogus: 1 });
		expect(bogus.isError).toBe(true);
		expect(bogus.code).toBeUndefined();
		expect(bogus.text).toContain("Input validation error");
		expect(bogus.text).toContain('Unrecognized key: "bogus"');
		// The SDK refuses before EmDash's handler: no audit row (Fact E1).
		expect(toolAudits()).toHaveLength(audits);

		const plan = await json<{ job: { id: string } }>(agent, "dry_run", {
			templateId,
			text: productsCsv(3),
		});
		const early = await tool(agent, "start_import", { dryRunId: plan.job.id });
		expect(early).toMatchObject({ code: "DRY_RUN_INCOMPLETE", details: { status: "created" } });

		const { uploadId } = await admin.upload(productsCsv(3));
		const rest = await admin.plugin("jobs/create", { uploadId, templateId, dryRun: true });
		const restStart = await tool(agent, "start_import", { dryRunId: rest.id });
		expect(restStart).toMatchObject({ code: "NOT_A_DRY_RUN" });
		expect(await tool(agent, "next_batch", { id: rest.id })).toMatchObject({
			code: "JOB_NOT_AGENT",
		});
		expect(await admin.plugin<Job>("jobs/get", { id: rest.id })).toMatchObject({
			status: "created",
		});

		await drive(agent, plan.job.id);
		await admin.plugin<SavedResult>("templates/update", {
			id: templateId,
			revision: 1,
			description: "edited after the dry run",
		});
		const edited = await tool(agent, "start_import", { dryRunId: plan.job.id });
		expect(edited).toMatchObject({ code: "TEMPLATE_CHANGED", details: { revision: 2 } });
	});

	it("is refused during a site import, and gone once the consent no longer matches (V4, V6)", async () => {
		withDb(server.dbPath, (db) =>
			db
				.prepare(
					"INSERT INTO _emdash_transfer_operations (id, kind, state, staging_secret, created_by) VALUES (?, 'import', 'running', ?, ?)",
				)
				.run("m6c-fence", "probe-secret", "admin"),
		);
		try {
			expect(await tool(agent, "list_templates", {})).toMatchObject({
				code: "TRANSFER_IMPORT_IN_PROGRESS",
			});
		} finally {
			withDb(server.dbPath, (db) =>
				db.prepare("DELETE FROM _emdash_transfer_operations WHERE id = ?").run("m6c-fence"),
			);
		}
		expect(await tool(agent, "list_templates", {})).toMatchObject({ isError: false });

		withDb(server.dbPath, (db) =>
			db
				.prepare("UPDATE _plugin_state SET mcp_tools_consent = '[]' WHERE plugin_id = ?")
				.run("fluximporter"),
		);
		expect(await listed(agent)).toEqual([]);
		const plugins = await admin.api<{ items: { id: string; mcpToolsEnabled: boolean }[] }>(
			"GET",
			"/_emdash/api/admin/plugins",
		);
		// The stale switch (spec F3): the admin still reports the tools enabled.
		expect(plugins.items.find((p) => p.id === "fluximporter")?.mcpToolsEnabled).toBe(true);
		await enableTools(admin);
		expect(await listed(agent)).toHaveLength(8);
	});

	it("keeps the tools off on a site upgraded from the six M6c tools until it consents again (M6d V6)", async () => {
		const fixture = await readFile(CONSENT_FIXTURE, "utf8");
		const m6c = [
			"dry_run",
			"get_template",
			"import_status",
			"list_templates",
			"next_batch",
			"start_import",
		];
		// The six rows are unchanged (spec Ruling 40), so this is 0.4.0's stored snapshot (plan Ruling 15).
		const six = JSON.stringify(
			(JSON.parse(fixture) as { name: string }[]).filter((row) => m6c.includes(row.name)),
		);
		withDb(server.dbPath, (db) =>
			db
				.prepare("UPDATE _plugin_state SET mcp_tools_consent = ? WHERE plugin_id = ?")
				.run(six, "fluximporter"),
		);
		expect(await listed(agent)).toEqual([]);
		const early = await tool(agent, "list_sources", {});
		expect(early.isError).toBe(true);
		expect(early.text).toContain("Tool fluximporter__list_sources not found");
		await enableTools(admin);
		expect(storedConsent()?.consent).toBe(fixture);
		expect(await listed(agent)).toHaveLength(8);
	});

	it("answers list_sources and list_schedules with hosts and codes only (spec Rulings 38, 39)", async () => {
		await admin.plugin("credentials/set", {
			name: "m6d-cred",
			header: "Authorization",
			value: "Bearer s3cr3t-value",
		});
		feeds.feeds.set("/m6d/s3cr3t-path.csv", { body: productsCsv(2) });
		const source = await admin.plugin<SourceRow>("sources/create", {
			name: "M6d feed",
			url: `${feeds.url("/m6d/s3cr3t-path.csv")}?token=t0ken`,
			credential: "m6d-cred",
		});
		const templateId = await saveTemplate("M6d schedule", template("it_mcp_url"));
		const { schedule } = await admin.plugin<{
			schedule: { id: string; armedBy: string; revision: number };
		}>("schedules/create", {
			name: "M6d",
			templateId,
			templateRevision: 1,
			sourceId: source.id,
			cron: "0 0 1 1 *",
		});
		try {
			const sources = await tool(agent, "list_sources", {});
			expect(sources.isError).toBe(false);
			const listedSource = (JSON.parse(sources.text) as { items: { id: string }[] }).items.find(
				(s) => s.id === source.id,
			);
			expect(listedSource).toMatchObject({ host: "127.0.0.1", credential: true });
			for (const marker of ["s3cr3t", "t0ken", "m6d-cred", "/m6d/"]) {
				expect(sources.text, marker).not.toContain(marker);
			}
			const schedules = await tool(agent, "list_schedules", {});
			expect(schedules.isError).toBe(false);
			const listedSchedule = (JSON.parse(schedules.text) as { items: { id: string }[] }).items.find(
				(s) => s.id === schedule.id,
			);
			expect(listedSchedule).toMatchObject({ templateId, sourceId: source.id, runCount: 0 });
			for (const marker of [schedule.armedBy, "sourcePin", "armedBy", "createdBy", "claimedAt"]) {
				expect(schedules.text, marker).not.toContain(marker);
			}
		} finally {
			await admin.plugin("schedules/delete", { id: schedule.id, revision: schedule.revision });
		}
	});

	it("redacts the upload ID of a dry run whose staged file is gone (spec Ruling 33)", async () => {
		const templateId = await saveTemplate("Redaction", template("it_mcp_no"));
		const plan = await json<{ job: { id: string } }>(agent, "dry_run", {
			templateId,
			text: productsCsv(3),
		});
		const { uploadId } = await admin.plugin<Job>("jobs/get", { id: plan.job.id });
		// The pattern the transcript scan uses matches a real upload ID.
		expect(uploadId).toMatch(UPLOAD_ID_PATTERN);
		const staged = (await readdir(server.uploadsDir)).filter(
			(f) => f.startsWith(UPLOAD_PREFIX) && f.includes(uploadId),
		);
		expect(staged).toHaveLength(1);
		await rm(join(server.uploadsDir, staged[0] as string));

		const reply = await json<StepReply>(agent, "next_batch", { id: plan.job.id });
		const redacted = { code: "source_missing", message: "Upload [staged file] not found" };
		expect(reply).toMatchObject({ status: "failed", next: "stopped", error: redacted });
		const status = await json<{ job: { error: unknown } }>(agent, "import_status", {
			id: plan.job.id,
		});
		expect(status.job.error).toEqual(redacted);
		// REST, for an administrator, keeps the ID that the tools left out.
		const stored = await admin.plugin<Job>("jobs/get", { id: plan.job.id });
		expect(stored.error?.message).toContain(uploadId);
	});

	it("audits every tool, and never returns an upload ID (spec Ruling 33)", () => {
		const audits = toolAudits();
		for (const name of TOOL_NAMES) {
			const ok = audits.some((a) => a.tool === TOOL_PREFIX + name && a.status === "success");
			expect(ok, name).toBe(true);
		}
		expect(audits.some((a) => a.status === "denied")).toBe(true);
		expect(seen.length).toBeGreaterThan(30);
		for (const text of seen) expect(text).not.toMatch(UPLOAD_ID_PATTERN);
	});
});
