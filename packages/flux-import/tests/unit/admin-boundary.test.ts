import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The admin module's boundary (M7a Global Constraints, plan Rulings 2 and 9): what `src/admin/**`
 * may import, the Tailwind classes it may use, and the shape of its messages.
 */

const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const ADMIN_SRC = join(PACKAGE_DIR, "src/admin");
const ENTRY = join(ADMIN_SRC, "index.tsx");

/** Every package the admin module may import at runtime (Global Constraints). */
const RUNTIME_ALLOWED = [
	"react",
	"@cloudflare/kumo",
	"@lingui/core",
	"@lingui/react",
	"@tanstack/react-query",
	"@dnd-kit/core",
	"emdash/plugin-utils",
];

interface ImportSite {
	file: string;
	specifier: string;
	/** The whole clause is `import type` / `export type`: nothing remains at runtime. */
	typeOnly: boolean;
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return walk(path);
		return /\.tsx?$/.test(e.name) ? [path] : [];
	});
}

function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function importsOf(file: string): ImportSite[] {
	const sites: ImportSite[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			// A side-effect import, or `import { type A }`, still loads the module.
			const typeOnly = node.importClause?.isTypeOnly === true;
			sites.push({ file, specifier: node.moduleSpecifier.text, typeOnly });
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			sites.push({ file, specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			sites.push({ file, specifier: node.arguments[0].text, typeOnly: false });
		}
		ts.forEachChild(node, visit);
	};
	visit(parse(file));
	return sites;
}

/** Resolves a relative specifier the way NodeNext does for our `.js` imports of `.ts(x)` files. */
function resolveRelative(from: string, specifier: string): string {
	const target = resolve(dirname(from), specifier);
	for (const candidate of [
		target.replace(/\.js$/, ".ts"),
		target.replace(/\.js$/, ".tsx"),
		target,
	]) {
		try {
			readFileSync(candidate);
			return candidate;
		} catch {
			// try the next one
		}
	}
	throw new Error(`${relative(PACKAGE_DIR, from)}: cannot resolve ${specifier}`);
}

/** The files that hold messages (plan Ruling 2, preflight F11). */
const isMessageTable = (file: string) => /(^|[/\\])(messages|errors)\.ts$/.test(file);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const insideAdmin = (path: string) => path === ADMIN_SRC || path.startsWith(ADMIN_SRC + sep);

/**
 * Every admin file: the graph from `index.tsx` (following runtime and type imports inside
 * `src/admin/`), plus every file under `src/admin/`, so nothing escapes by not being imported.
 */
function adminFiles(): string[] {
	const seen = new Set<string>();
	const queue = [ENTRY, ...walk(ADMIN_SRC)];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const site of importsOf(file)) {
			if (!site.specifier.startsWith(".")) continue;
			const target = resolveRelative(file, site.specifier);
			if (insideAdmin(target)) queue.push(target);
		}
	}
	return [...seen].sort();
}

const packageName = (specifier: string) =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");

function runtimeImports(): ImportSite[] {
	return adminFiles()
		.flatMap(importsOf)
		.filter((s) => !s.typeOnly && !s.specifier.startsWith("."));
}

/** CSS.escape for a class name, as Tailwind writes its selectors. */
function cssEscape(name: string): string {
	return [...name]
		.map((ch, i) => {
			if (i === 0 && /[0-9]/.test(ch)) return `\\3${ch} `;
			return /[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80 ? ch : `\\${ch}`;
		})
		.join("");
}

interface ClassUse {
	file: string;
	line: number;
	/** The literal's text, or null for a className that is not built from string literals. */
	text: string | null;
}

/** The string literals a className is made of; null for anything else (a variable, a call). */
function literalsOf(expr: ts.Expression): string[] | null {
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
	if (ts.isParenthesizedExpression(expr)) return literalsOf(expr.expression);
	if (ts.isConditionalExpression(expr)) {
		const a = literalsOf(expr.whenTrue);
		const b = literalsOf(expr.whenFalse);
		return a && b ? [...a, ...b] : null;
	}
	return null;
}

function classUses(file: string): ClassUse[] {
	const source = parse(file);
	const uses: ClassUse[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isJsxAttribute(node) && node.name.getText(source) === "className") {
			const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
			const init = node.initializer;
			let texts: string[] | null = null;
			if (init && ts.isStringLiteral(init)) texts = [init.text];
			else if (init && ts.isJsxExpression(init) && init.expression) {
				texts = literalsOf(init.expression);
			}
			if (texts === null) uses.push({ file, line, text: null });
			else for (const text of texts) uses.push({ file, line, text });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return uses;
}

describe("the admin module's boundary", () => {
	const files = adminFiles();

	it("imports server code and emdash with whole-clause import type only", () => {
		const offending = files
			.flatMap(importsOf)
			.filter((s) => {
				if (s.typeOnly) return false;
				if (s.specifier === "emdash") return true;
				return s.specifier.startsWith(".") && !insideAdmin(resolveRelative(s.file, s.specifier));
			})
			.map((s) => `${relative(PACKAGE_DIR, s.file)}: ${s.specifier}`);
		expect(files).toContain(ENTRY);
		expect(offending).toEqual([]);
	});

	it("imports at runtime only the allowed packages", () => {
		const offending = runtimeImports()
			.filter((s) => !RUNTIME_ALLOWED.includes(s.specifier))
			.map((s) => `${relative(PACKAGE_DIR, s.file)}: ${s.specifier}`);
		expect(offending).toEqual([]);
	});

	it("declares every runtime package as a peer, except @dnd-kit/*, which are dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
			dependencies: Record<string, string>;
			peerDependencies: Record<string, string>;
		};
		const names = new Set([
			...RUNTIME_ALLOWED.map(packageName),
			...runtimeImports().map((s) => packageName(s.specifier)),
		]);
		const undeclared = [...names].filter((name) =>
			name.startsWith("@dnd-kit/")
				? !(name in pkg.dependencies) || name in pkg.peerDependencies
				: !(name in pkg.peerDependencies) || name in pkg.dependencies,
		);
		expect(undeclared).toEqual([]);
	});

	it("uses only class names the admin's prebuilt CSS defines (Ruling 9)", () => {
		const admin = realpathSync(join(PACKAGE_DIR, "node_modules/@emdash-cms/admin"));
		const css = readFileSync(join(admin, "dist/styles.css"), "utf8");
		const defined = (token: string) =>
			new RegExp(
				`\\.${cssEscape(token).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![A-Za-z0-9_\\\\-])`,
			).test(css);
		const problems: string[] = [];
		for (const use of files.filter((f) => f.endsWith(".tsx")).flatMap(classUses)) {
			const where = `${relative(PACKAGE_DIR, use.file)}:${use.line}`;
			if (use.text === null) {
				problems.push(`${where}: className is not a string literal`);
				continue;
			}
			for (const token of use.text.split(/\s+/).filter(Boolean)) {
				if (!defined(token)) problems.push(`${where}: ${token}`);
			}
		}
		expect(problems).toEqual([]);
	});

	it("keeps message IDs unique, well-formed and free of ICU syntax (Ruling 2)", async () => {
		const ID = /^flux-import\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
		const seen = new Map<string, string>();
		const problems: string[] = [];
		for (const file of files.filter(isMessageTable)) {
			const where = relative(PACKAGE_DIR, file);
			const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
			// Message tables are plain objects, nested or not; a value with an `id` or a `message`
			// must be a Msg. Arrays (such as lists of codes), primitives and functions are skipped.
			const msgs: [string, Record<string, unknown>][] = [];
			const collect = (path: string, value: unknown) => {
				if (!isPlainObject(value)) return;
				if ("id" in value || "message" in value || "one" in value) msgs.push([path, value]);
				else for (const [k, v] of Object.entries(value)) collect(`${path}.${k}`, v);
			};
			for (const [name, value] of Object.entries(mod)) collect(name, value);
			for (const [path, msg] of msgs) {
				// A Msg has one message; a PluralMsg (i18n.ts) has its English `one` and `other`.
				const texts =
					typeof msg.message === "string"
						? [msg.message]
						: typeof msg.one === "string" && typeof msg.other === "string"
							? [msg.one, msg.other]
							: null;
				if (typeof msg.id !== "string" || texts === null) {
					problems.push(`${where} ${path}: not a Msg`);
					continue;
				}
				if (!ID.test(msg.id)) problems.push(`${where} ${path}: bad ID ${msg.id}`);
				const other = seen.get(msg.id);
				if (other) problems.push(`${where} ${path}: duplicate ID ${msg.id} (also ${other})`);
				seen.set(msg.id, `${where} ${path}`);
				// Only {name} placeholders: no plural, select or other ICU syntax.
				for (const text of texts) {
					const braces = text.replace(/\{[A-Za-z]+\}/g, "");
					if (/[{}]/.test(braces)) problems.push(`${where} ${path}: ICU syntax in ${text}`);
				}
			}
		}
		expect(problems).toEqual([]);
		expect(seen.size).toBeGreaterThan(0);
	});

	it("defines the shared Try again once, in the admin's own messages.ts (Task 7 review)", async () => {
		const found: string[] = [];
		for (const file of files.filter(isMessageTable)) {
			const where = relative(PACKAGE_DIR, file);
			const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
			const visit = (path: string, value: unknown) => {
				if (!isPlainObject(value)) return;
				if (value.message === "Try again") found.push(`${where} ${path}`);
				else for (const [k, v] of Object.entries(value)) visit(`${path}.${k}`, v);
			};
			for (const [name, value] of Object.entries(mod)) visit(name, value);
		}
		expect(found).toEqual(["src/admin/messages.ts M.tryAgain"]);
	});

	it("defines messages only in messages.ts and errors.ts (Ruling 2)", () => {
		const stray = files
			.filter((f) => !isMessageTable(f))
			.flatMap((file) => {
				const source = parse(file);
				const found: string[] = [];
				const visit = (node: ts.Node) => {
					if (ts.isObjectLiteralExpression(node)) {
						const names = node.properties
							.filter((p) => ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer))
							.map((p) => p.name?.getText(source).replace(/^["']|["']$/g, ""));
						if (names.includes("id") && names.includes("message")) {
							const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
							found.push(`${relative(PACKAGE_DIR, file)}:${line}`);
						}
					}
					ts.forEachChild(node, visit);
				};
				visit(source);
				return found;
			});
		expect(stray).toEqual([]);
	});
});
