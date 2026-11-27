import { pathProblem } from "../sources/paths.js";
import { checkSource } from "../sources/readers.js";
import { MAX_MEDIA_MAPPINGS } from "./media.js";
import { MAX_PORTABLE_TEXT_MAPPINGS } from "./portable-text.js";
import {
	compileTemplate,
	rulesProblems,
	type Template,
	templatePaths,
	templateSchema,
} from "./template.js";

export type TemplateShape =
	| { ok: false; problems: string[] } // step 1 (schema) and step 2 (__proto__ keys)
	| { ok: true; template: Template; fit: string[]; expressions: string[]; source: string[] };

/**
 * Every check of a template that does not depend on the site (spec "Validation", Ruling 27), in
 * order: (1) the schema; (2) no `__proto__` key anywhere in the raw input; then, on the parsed
 * template, `fit`: (3) JSON, JSON Lines and XML path syntax, (4) at most `MAX_MEDIA_MAPPINGS`
 * image and file fields and `MAX_PORTABLE_TEXT_MAPPINGS` portableText fields, (5)
 * `translationOf.locale` other than `locale`, (6) `rulesProblems`; (7) `expressions`, compiled
 * and never evaluated; (8) `source`, from `checkSource`. Every caller runs it first: `createJob`,
 * `schema/apply` and the template routes. `checkTemplate` checks the rest, against the site.
 */
export function templateShapeProblems(input: unknown): TemplateShape {
	const parsed = templateSchema.safeParse(input);
	// The schema drops a select map's `__proto__` key (Fact E1), so the raw input is walked.
	const protoPaths = protoKeyPaths(input);
	// A strict object also refuses the key as unrecognized: the walk's problem replaces that one.
	const duplicates = new Set(protoPaths.map((path) => `${path}: Unrecognized key: "__proto__"`));
	const schema = parsed.success
		? []
		: parsed.error.issues
				.map((i) => `${i.path.join(".") || "template"}: ${i.message}`)
				.filter((problem) => !duplicates.has(problem));
	const proto = protoPaths.map(protoProblem);
	if (!parsed.success || proto.length > 0) return { ok: false, problems: [...schema, ...proto] };
	const t = parsed.data;

	const fit: string[] = [];
	const format = t.source.format;
	if (format === "json" || format === "jsonl" || format === "xml") {
		for (const path of templatePaths(t)) {
			const problem = pathProblem(path, format);
			if (problem !== null) fit.push(problem);
		}
	}
	const mappings = Object.values(t.fields);
	const media = mappings.filter((m) => m.type === "image" || m.type === "file");
	if (media.length > MAX_MEDIA_MAPPINGS) {
		fit.push(
			`The template maps ${media.length} image and file fields; at most ${MAX_MEDIA_MAPPINGS} are allowed`,
		);
	}
	const rich = mappings.filter((m) => m.type === "portableText");
	if (rich.length > MAX_PORTABLE_TEXT_MAPPINGS) {
		fit.push(
			`The template maps ${rich.length} portableText fields; at most ${MAX_PORTABLE_TEXT_MAPPINGS} are allowed`,
		);
	}
	const sourceLocale = t.translationOf?.locale;
	if (sourceLocale !== undefined && sourceLocale.toLowerCase() === t.locale.toLowerCase()) {
		fit.push(`translationOf.locale must differ from locale ("${t.locale}")`);
	}
	fit.push(...rulesProblems(t));

	const compiled = compileTemplate(t);
	return {
		ok: true,
		template: t,
		fit,
		expressions: compiled.ok ? [] : compiled.problems,
		source: checkSource(t.source),
	};
}

/** A path as a chain of parent links, so a deep walk never copies the path above it. */
type PathNode = { parent: PathNode | null; key: string } | null;

/** A reported path keeps this many characters at each end when it is over twice as long. */
export const PATH_KEEP = 100;

/**
 * The dotted path of `node`, or for one over `2 * PATH_KEEP` characters its first and last
 * `PATH_KEEP` characters around "…". A long path is never built whole: one pass measures it, a
 * second keeps only the segments nearest each end.
 */
function pathOf(node: PathNode): string {
	let length = -1;
	for (let n = node; n !== null; n = n.parent) length += n.key.length + 1;
	if (length <= 2 * PATH_KEEP) {
		const keys: string[] = [];
		for (let n = node; n !== null; n = n.parent) keys.push(n.key);
		return keys.reverse().join(".");
	}
	// The leaf end: segments until they hold PATH_KEEP characters.
	const tail: string[] = [];
	let tailLength = -1;
	let n = node;
	for (; n !== null && tailLength < PATH_KEEP; n = n.parent) {
		tail.push(n.key);
		tailLength += n.key.length + 1;
	}
	// The root end: a window of the segments seen last that still holds PATH_KEEP characters.
	const head: string[] = [];
	let headLength = -1;
	for (; n !== null; n = n.parent) {
		head.push(n.key);
		headLength += n.key.length + 1;
		while (head.length > 1 && headLength - ((head[0] as string).length + 1) >= PATH_KEEP) {
			headLength -= (head.shift() as string).length + 1;
		}
	}
	const tailText = tail.reverse().join(".");
	const start =
		head.length === 0 ? tailText : `${head.reverse().join(".")}.${tailText.slice(0, PATH_KEEP)}`;
	return `${start.slice(0, PATH_KEEP)}…${tailText.slice(-PATH_KEEP)}`;
}

/** The most `__proto__` keys reported: each problem spells out its path, which can be long. */
export const MAX_PROTO_PROBLEMS = 20;

const protoProblem = (path: string) => `${path}: "__proto__" is not allowed as a key`;

/**
 * The first `MAX_PROTO_PROBLEMS` object keys `__proto__` in `input`, at any depth, depth-first
 * with keys in order. It walks with an explicit stack, since route input can nest tens of
 * thousands of levels (Review Focus 1), and never into a `__proto__` key's value, which is
 * refused anyway. A path over `2 * PATH_KEEP` characters is shortened around "…", so 20 problems
 * stay small however deep the input nests.
 */
export function protoKeyProblems(input: unknown): string[] {
	return protoKeyPaths(input).map(protoProblem);
}

/** The paths of `protoKeyProblems`, `template` for the root. */
function protoKeyPaths(input: unknown): string[] {
	const paths: string[] = [];
	const stack: [unknown, PathNode][] = [[input, null]];
	for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
		const [value, path] = top;
		if (typeof value !== "object" || value === null) continue;
		const children: [unknown, PathNode][] = [];
		if (Array.isArray(value)) {
			value.forEach((item, i) => {
				children.push([item, { parent: path, key: String(i) }]);
			});
		} else {
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				if (key === "__proto__") {
					paths.push(pathOf(path) || "template");
					if (paths.length >= MAX_PROTO_PROBLEMS) return paths;
					continue;
				}
				children.push([record[key], { parent: path, key }]);
			}
		}
		// Pushed last first, so the first child is visited next.
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as [unknown, PathNode]);
	}
	return paths;
}

/** Every problem of a template that parsed: fit, expressions, source, in that order. */
export function shapeProblems(shape: Extract<TemplateShape, { ok: true }>): string[] {
	return [...shape.fit, ...shape.expressions, ...shape.source];
}
