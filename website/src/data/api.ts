// Data for the API route reference pages (ApiPage.dc.html). One object per route; the MDX page
// passes it to the components in src/components/api/. Until the reference is generated from the
// plugin's route schemas, these are written by hand from packages/flux-import/src/plugin/routes.ts.

export const API_BASE = "/_emdash/api/plugins/flux-import/";

export interface ApiField {
	name: string;
	type: string;
	/** true: required. A string: a condition shown instead, e.g. "one of". */
	required?: boolean | string;
	default?: string;
	description: string;
	link?: { label: string; href: string };
	/** Nested fields, shown in a <details> under the field. */
	fields?: ApiField[];
	/** Placeholder copy, shown muted until it is written. */
	placeholder?: boolean;
}

export interface ApiCode {
	label: string;
	lang: string;
	code: string;
}

export interface ApiRouteData {
	method: "GET" | "POST";
	/** The route's name under API_BASE, e.g. "jobs/create". */
	route: string;
	/** Who can call it. */
	role: string;
	/** Whether state-changing requests need the X-EmDash-Request: 1 header. */
	csrf: boolean;
	/** The agent tool name, when the route is also an MCP tool. */
	agentTool?: string;
	contentType: string;
	fields: ApiField[];
	request: ApiCode[];
	response: ApiCode & { status: number };
	errors: { code: string; status: number; meaning: string }[];
}

const TEMPLATE_KIDS: ApiField[] = [
	{ name: "collection", type: "string", required: true, default: "—", description: "Target collection slug. [EXAMPLE CHILD ROW]", placeholder: true },
	{ name: "mappings", type: "array", required: true, default: "—", description: "Column-to-field pairs. [EXAMPLE CHILD ROW]", placeholder: true },
	{ name: "recordRule", type: "string", default: '"create"', description: "create, update, or never overwrite edits. [EXAMPLE CHILD ROW]", placeholder: true },
];

export const jobsCreate: ApiRouteData = {
	method: "POST",
	route: "jobs/create",
	role: "Administrator",
	csrf: true,
	// TODO: jobs/create is not an MCP tool (plugin/mcp.ts); the mockup shows the section with a placeholder.
	agentTool: "[tool]",
	contentType: "application/json",
	fields: [
		{ name: "uploadId", type: "string", required: "one of", default: "—", description: "ID of the uploaded source file. Set exactly one of uploadId and sourceId." },
		{ name: "sourceId", type: "string", required: "one of", default: "—", description: "A saved URL source, fetched first. A real run is skipped when the feed and template are unchanged since the last import." },
		{ name: "force", type: "boolean", default: "false", description: "With sourceId: fetch without validators and create the job even if nothing changed." },
		{
			name: "template",
			type: "object",
			required: "one of",
			default: "—",
			description: "How source columns map to fields. Set exactly one of template and templateId.",
			link: { label: "Template format", href: "/emdash/reference/template-format/" },
			fields: TEMPLATE_KIDS,
		},
		{ name: "templateId", type: "string", required: "one of", default: "—", description: "A saved template, read once; the job keeps a snapshot of it." },
		{ name: "templateRevision", type: "integer", default: "—", description: "With templateId: refuse with TEMPLATE_CHANGED unless the template is at this revision." },
		{ name: "dryRun", type: "boolean", required: true, default: "—", description: "Plan the job without writing entries." },
		{ name: "publish", type: "boolean", default: "true", description: "Publish the entries the job writes." },
		{ name: "batchSize", type: "integer · 1–500", default: "50", description: "Records per batch." },
		{ name: "budgetMs", type: "integer · 500–25,000", default: "4000", description: "Time budget per batch, in milliseconds." },
		{ name: "journal", type: "boolean", default: "true", description: "Keep a journal so the job can be rolled back. Dry runs keep none.", link: { label: "Rollback", href: "/emdash/guides/rollback/" } },
		{ name: "missing", type: "false | object", default: "—", description: "false skips the missing-entries phase for this run; { maxPercent: 0–100 } replaces its threshold.", link: { label: "Missing entries", href: "/emdash/guides/missing-entries/" } },
	],
	request: [
		{
			label: "curl",
			lang: "sh",
			code: [
				'curl -X POST "https://example.com/_emdash/api/plugins/flux-import/jobs/create" \\',
				'  -H "Content-Type: application/json" \\',
				'  -H "X-EmDash-Request: 1" \\',
				'  -b "$ADMIN_SESSION" \\',
				"  -d '{\"uploadId\":\"upl_8f2c\",\"template\":{…},\"dryRun\":false}'",
			].join("\n"),
		},
		{
			label: "fetch",
			lang: "js",
			code: [
				"const res = await fetch(",
				'  "/_emdash/api/plugins/flux-import/jobs/create",',
				"  {",
				'    method: "POST",',
				"    headers: {",
				'      "Content-Type": "application/json",',
				'      "X-EmDash-Request": "1",',
				"    },",
				"    body: JSON.stringify({",
				'      uploadId: "upl_8f2c",',
				"      template,",
				"      dryRun: false,",
				"      batchSize: 100,",
				"    }),",
				"  },",
				");",
				"const { data: job } = await res.json();",
			].join("\n"),
		},
	],
	response: {
		status: 200,
		label: "response.json · example",
		lang: "json",
		code: ["{", '  "data": {', '    "id": "[job ID]",', '    "status": "created",', '    "dryRun": false,', '    "publish": true,', '    "batchSize": 50', "  }", "}"].join("\n"),
	},
	errors: [
		{ code: "INVALID_SOURCE", status: 400, meaning: "The uploaded file cannot be read as the template’s source format." },
		{ code: "NOT_FOUND", status: 404, meaning: "The upload or a referenced item does not exist." },
		{ code: "CONFLICT", status: 409, meaning: "The request conflicts with the current state of the job or source." },
	],
};
