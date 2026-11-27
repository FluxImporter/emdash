/**
 * The MCP side of the M6c tests: the SDK's own client against a started site (spec "Testing").
 * Tokens are minted at run time and held in memory only; none is written anywhere.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StatusReply } from "../../src/plugin/agent.js";
import type { JobSummary, RecordSummary, StepReply } from "../../src/plugin/summaries.js";
import type { Client } from "./client.js";

export type { McpClient };

export const TOOL_PREFIX = "fluximporter__";
export const TOOL_NAMES = [
	"dry_run",
	"get_template",
	"import_status",
	"list_schedules",
	"list_sources",
	"list_templates",
	"next_batch",
	"start_import",
];
/** A bare upload ID anywhere in a text (src/emdash/uploads.ts:23, unanchored). */
export const UPLOAD_ID_PATTERN = /[0-9A-HJKMNP-TV-Z]{26}[0-9a-f]{32}/;
/**
 * Every tool result this process received, serialized whole (`_meta` too, where EmDash puts an
 * error's details), checked for upload IDs by the tests.
 */
export const seen: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectMcp(baseUrl: string, token: string): Promise<McpClient> {
	const mcp = new McpClient({ name: "fluximporter-tests", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL("/_emdash/api/mcp", baseUrl), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	// The transport's getter `sessionId(): string | undefined` (client/streamableHttp.d.ts:158)
	// meets `Transport`'s `sessionId?: string` (shared/transport.d.ts:93), which
	// `exactOptionalPropertyTypes` refuses; the two are the same at run time.
	await mcp.connect(transport as Transport);
	return mcp;
}

export interface ToolResult {
	isError: boolean;
	text: string;
	code?: string;
	details?: unknown;
}

/** Calls any tool by its full name; a refusal is a result, never a throw (spec F8). */
export async function call(
	mcp: McpClient,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const result = await mcp.callTool({ name, arguments: args });
	const content = (result.content ?? []) as { type: string; text?: string }[];
	const text = content.map((c) => c.text ?? "").join("");
	seen.push(JSON.stringify(result));
	const meta = result._meta as { code?: string; details?: unknown } | undefined;
	return {
		isError: result.isError === true,
		text,
		...(meta?.code === undefined ? {} : { code: meta.code }),
		...(meta?.details === undefined ? {} : { details: meta.details }),
	};
}

export const tool = (mcp: McpClient, name: string, args: Record<string, unknown>) =>
	call(mcp, `${TOOL_PREFIX}${name}`, args);

/** A successful call's JSON (spec F7: one text block of the route's result). */
export async function json<T>(mcp: McpClient, name: string, args: Record<string, unknown>) {
	const result = await tool(mcp, name, args);
	if (result.isError) throw new Error(`${name} failed: ${result.text}`);
	return JSON.parse(result.text) as T;
}

/** One PUT stores a fresh consent snapshot, whatever is stored (Fact V4). */
export async function enableTools(admin: Client): Promise<void> {
	await admin.api("PUT", "/_emdash/api/admin/plugins/fluximporter/mcp", { enabled: true });
}

export async function mintToken(admin: Client, scopes: string[]) {
	const minted = await admin.api<{ token: string; info: { id: string } }>(
		"POST",
		"/_emdash/api/admin/api-tokens",
		{ name: `m6c ${scopes.join(" ")}`, scopes },
	);
	return { token: minted.token, id: minted.info.id };
}

export async function revokeToken(admin: Client, id: string): Promise<void> {
	await admin.api("DELETE", `/_emdash/api/admin/api-tokens/${id}`);
}

/** next_batch until `done`, as the description says: `retryAfterMs` is waited out. */
export async function drive(mcp: McpClient, id: string, maxCalls = 500): Promise<StepReply[]> {
	const replies: StepReply[] = [];
	while (replies.length < maxCalls) {
		const reply = await json<StepReply>(mcp, "next_batch", { id });
		replies.push(reply);
		if (reply.next === "done") return replies;
		if (reply.next === "stopped") throw new Error(`Job ${id} stopped: ${JSON.stringify(reply)}`);
		if (reply.retryAfterMs !== undefined) await sleep(reply.retryAfterMs);
	}
	throw new Error(`Job ${id} did not finish in ${maxCalls} calls`);
}

export interface AgentRun {
	dryRun: JobSummary;
	real: JobSummary;
	planned: RecordSummary[];
	steps: StepReply[];
}

/** The acceptance sequence of spec "The agent's flow", with the user's agreement assumed. */
export async function agentImport(
	mcp: McpClient,
	templateId: string,
	data: { text: string } | { sourceId: string },
): Promise<AgentRun> {
	const listed = await json<{ items: { id: string }[] }>(mcp, "list_templates", {});
	if (!listed.items.some((t) => t.id === templateId)) throw new Error("Template not listed");
	await json(mcp, "get_template", { id: templateId });
	const plan = await json<{ job: JobSummary }>(mcp, "dry_run", { templateId, ...data });
	const steps = await drive(mcp, plan.job.id);
	const dryRun = await json<StatusReply>(mcp, "import_status", { id: plan.job.id });
	const sample = await json<StatusReply>(mcp, "import_status", {
		id: plan.job.id,
		records: "planned",
	});
	const start = await json<{ job: JobSummary }>(mcp, "start_import", { dryRunId: plan.job.id });
	steps.push(...(await drive(mcp, start.job.id)));
	const real = await json<StatusReply>(mcp, "import_status", { id: start.job.id });
	return { dryRun: dryRun.job, real: real.job, planned: sample.records?.items ?? [], steps };
}
