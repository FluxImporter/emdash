#!/usr/bin/env node
// Reports Tailwind classes that EmDash's prebuilt admin stylesheet does not define.
//
// Plugin admin pages render inside the EmDash admin, which loads one prebuilt stylesheet
// (@emdash-cms/admin/dist/styles.css); our source is not scanned by its Tailwind build, so a
// class that stylesheet lacks does nothing. This checks:
//   1. every class in packages/emdash/src/admin (className="…" and string literals in
//      className={…}), with file and line;
//   2. every utility named in the design spec (docs/flux-design-handoff/admin/Spec.dc.html),
//      flagging the ones the spec marks with * as "needs checking", with the spec's suggested
//      alternative where it gives one;
//   3. rule breaks in the source: dark: variants and arbitrary colour values.
//
// Usage: node scripts/check-classes.mjs [--all]   (--all also lists the classes that exist)
// Exit code 1 when a class used in the source is missing or a rule is broken.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages/emdash");
const SRC = join(PKG, "src/admin");
const SPEC = join(ROOT, "docs/flux-design-handoff/admin/Spec.dc.html");
const showAll = process.argv.includes("--all");

// ---- The stylesheet: every class selector it defines ----

const require = createRequire(join(PKG, "package.json"));
const cssPath = require.resolve("@emdash-cms/admin/styles.css");
const adminPkg = JSON.parse(readFileSync(join(dirname(cssPath), "..", "package.json"), "utf8"));
const css = readFileSync(cssPath, "utf8");

function unescapeCss(s) {
	return s
		.replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/\\(.)/g, "$1");
}

const defined = new Set();
for (const m of css.matchAll(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\[^0-9a-fA-F]|[\w-])+)/g)) {
	defined.add(unescapeCss(m[1]));
}

// ---- Which tokens are Tailwind utilities (so prose in the spec is ignored) ----

const ROOTS = new Set(
	(
		"flex grid gap items justify text font bg border rounded p px py pt pb pl pr ps pe m mx my mt mb ml mr ms me " +
		"w h size min max col row divide shadow opacity pointer truncate tabular animate inline block hidden sr not " +
		"overflow space leading tracking uppercase lowercase capitalize whitespace aspect z top left right bottom inset " +
		"absolute relative sticky fixed static order self place content shrink grow basis line underline decoration " +
		"outline ring transition duration ease delay cursor select resize list align break object fill stroke visible " +
		"invisible italic contents table caption float clear isolate isolation mix backdrop blur filter scroll snap " +
		"touch will appearance accent caret columns box indent field forced @container container"
	).split(" "),
);

function utilityPart(token) {
	// Variants are everything before the last ":" outside brackets.
	let depth = 0;
	let cut = -1;
	for (let i = 0; i < token.length; i++) {
		const c = token[i];
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") depth--;
		else if (c === ":" && depth === 0) cut = i;
	}
	return { variants: cut < 0 ? "" : token.slice(0, cut), utility: token.slice(cut + 1) };
}

// Roots that are a whole class on their own; any other root needs a value ("gap-2", "text-sm").
const STANDALONE = new Set(
	(
		"flex grid truncate hidden block inline italic uppercase lowercase capitalize visible invisible relative " +
		"absolute fixed sticky static contents table isolate underline grow shrink border rounded shadow outline ring " +
		"transition container @container"
	).split(" "),
);

function isUtility(token) {
	if (!/^[!@a-z0-9[(-]/.test(token) || /[:;]$/.test(token)) return false;
	const { utility } = utilityPart(token);
	const u = utility.replace(/^!/, "").replace(/^-/, "");
	if (u.startsWith("[")) return true;
	const root = u.split(/[-[(/]/)[0];
	if (!ROOTS.has(root)) return false;
	return u !== root || STANDALONE.has(root);
}

/** Defined classes in the same family (same prefix up to the last "-"), for suggestions. */
function nearest(cls) {
	const { variants, utility } = utilityPart(cls);
	const stem = utility.replace(/-[^-]*$/, "-");
	if (stem === utility) return [];
	const pre = variants ? `${variants}:` : "";
	return [...defined]
		.filter((d) => d.startsWith(pre + stem) && !d.slice(pre.length).includes(":") && /^[\w.-]+$/.test(d.slice((pre + stem).length)))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
		.slice(0, 10);
}

// ---- 1. Classes in the admin source ----

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return walk(p);
		return /\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
	});
}

/** String literals inside a JS expression (template literals: their static parts). */
function literals(expr) {
	const out = [];
	for (const m of expr.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
		// A value compared against (c.action === "conflict") is not a class.
		if (/(===|!==|==|!=|case)\s*$/.test(expr.slice(0, m.index))) continue;
		const s = m[1] ?? m[2] ?? m[3]?.replace(/\$\{[^}]*\}/g, " ");
		if (s) out.push(s);
	}
	return out;
}

const used = new Map(); // class -> ["file:line", ...]
const rules = []; // rule breaks
function use(cls, where) {
	if (!used.has(cls)) used.set(cls, []);
	used.get(cls).push(where);
	const { variants, utility } = utilityPart(cls);
	if (/(^|:)dark$/.test(variants) || variants.split(":").includes("dark")) {
		rules.push(`${where}  ${cls}  (dark: variant; Kumo handles the theme)`);
	}
	if (/\[(#|rgb|hsl|oklch|color:)/i.test(utility) || /-(black|white)(\/|$)/.test(utility)) {
		rules.push(`${where}  ${cls}  (raw colour; use a Kumo token class)`);
	}
}

for (const file of walk(SRC)) {
	const text = readFileSync(file, "utf8");
	const lineAt = (i) => text.slice(0, i).split("\n").length;
	const rel = relative(ROOT, file);
	for (const m of text.matchAll(/className=(?:"([^"]*)"|\{)/g)) {
		const at = `${rel}:${lineAt(m.index)}`;
		let strings;
		if (m[1] !== undefined) {
			strings = [m[1]];
		} else {
			// Balance braces to find the end of the expression.
			let depth = 1;
			let i = m.index + m[0].length;
			for (; i < text.length && depth > 0; i++) {
				if (text[i] === "{") depth++;
				else if (text[i] === "}") depth--;
			}
			strings = literals(text.slice(m.index + m[0].length, i - 1));
		}
		for (const s of strings) for (const cls of s.split(/\s+/).filter(Boolean)) use(cls, at);
	}
}

// ---- 2. Utilities named in the design spec ----

const spec = readFileSync(SPEC, "utf8");
const specRows = []; // { screen, element, cls }
let screen = "";
for (const line of spec.split("\n")) {
	const head = line.match(/^(\w+): \['([^']*)', \[/);
	if (head) screen = head[2];
	const row = line.match(/^\['((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', (?:'((?:[^'\\]|\\.)*)'|null)/);
	if (row && row[3]) specRows.push({ screen, element: row[1], cls: row[3] });
}

const specClasses = new Map(); // class -> { marked, where[], alternative }
for (const r of specRows) {
	// "a* → or b c*": the part after → is the spec's alternative for what comes before it.
	// The alternative runs to the next " · "; what follows it belongs to the main list again.
	const [before, after = ""] = r.cls.split("→");
	const [altText = "", ...rest] = after.split(" · ");
	const main = [before, ...rest].join(" · ");
	const alternative = altText.replace(/^\s*or\s*/, "").replace(/\*/g, "").trim();
	for (const part of [main, altText]) {
		for (const raw of part.split(/[\s·,]+/)) {
			const marked = raw.endsWith("*");
			const token = raw.replace(/\*$/, "");
			if (!token || !isUtility(token)) continue;
			const entry = specClasses.get(token) ?? { marked: false, where: [], alternative: "" };
			entry.marked ||= marked;
			entry.where.push(`${r.screen} › ${r.element}`);
			if (part === main && alternative) entry.alternative = alternative;
			specClasses.set(token, entry);
		}
	}
}

// ---- Report ----

const sourceMissing = [...used].filter(([c]) => !defined.has(c)).sort(([a], [b]) => a.localeCompare(b));
const specMissing = [...specClasses].filter(([c]) => !defined.has(c)).sort(([a], [b]) => a.localeCompare(b));
const markedOk = [...specClasses].filter(([c, e]) => e.marked && defined.has(c)).map(([c]) => c);

console.log(`Admin stylesheet: ${relative(ROOT, cssPath)} (@emdash-cms/admin ${adminPkg.version})`);
console.log(`  ${defined.size} class selectors defined\n`);

console.log(`1. Admin source: ${used.size} distinct classes, ${sourceMissing.length} missing`);
for (const [c, where] of sourceMissing) {
	console.log(`   MISSING  ${c}    ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` (+${where.length - 3})` : ""}`);
	const near = nearest(c);
	if (near.length) console.log(`            nearest: ${near.join(" ")}`);
}
if (showAll) for (const [c] of [...used].filter(([c]) => defined.has(c)).sort()) console.log(`   ok       ${c}`);

console.log(`\n2. Design spec: ${specClasses.size} distinct utilities, ${specMissing.length} missing`);
for (const [c, e] of specMissing) {
	let alt = "no alternative given";
	if (e.alternative) {
		const utils = e.alternative.split(/\s+/).filter(isUtility);
		const state = utils.length ? (utils.every((a) => defined.has(a)) ? "exists" : "also missing") : "a component prop";
		alt = `spec alternative: ${e.alternative} (${state})`;
	}
	console.log(`   MISSING${e.marked ? "*" : " "} ${c}    ${e.where[0]}`);
	console.log(`            ${alt}`);
	const near = nearest(c);
	if (near.length) console.log(`            nearest: ${near.join(" ")}`);
}
console.log(`   Marked * and present: ${markedOk.length ? markedOk.sort().join(", ") : "none"}`);
if (showAll) for (const [c] of [...specClasses].filter(([c]) => defined.has(c)).sort()) console.log(`   ok       ${c}`);

console.log(`\n3. Rule breaks in the source (dark: variants, raw colours): ${rules.length}`);
for (const r of rules) console.log(`   ${r}`);

process.exit(sourceMissing.length || rules.length ? 1 : 0);
