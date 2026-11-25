// Checks every internal link in the built site (dist/): the target page or file must exist,
// and a #fragment must match an id on that page. External links are listed, not fetched.
// Usage: node scripts/check-links.mjs [distDir]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const dist = process.argv[2] ?? "dist";

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return htmlFiles(path);
		return name.endsWith(".html") ? [path] : [];
	});
}

/** @param {string} pathname @returns {string | null} the file a URL path resolves to */
function resolveFile(pathname) {
	const clean = decodeURIComponent(pathname).replace(/^\//, "");
	for (const candidate of [clean, join(clean, "index.html"), `${clean.replace(/\/$/, "")}.html`]) {
		const path = join(dist, candidate);
		if (existsSync(path) && statSync(path).isFile()) return path;
	}
	return null;
}

const idCache = new Map();
/** @param {string} file @returns {Set<string>} */
function idsOf(file) {
	if (!idCache.has(file)) {
		const html = readFileSync(file, "utf8");
		idCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	}
	return idCache.get(file);
}

const pages = htmlFiles(dist);
const broken = [];
const external = new Set();
let checked = 0;

for (const page of pages) {
	const html = readFileSync(page, "utf8");
	const pagePath = `/${relative(dist, page).split("\\").join("/")}`;
	for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		// The site's own absolute URLs (canonical, sitemap) are checked as internal links.
		const url = m[1].replaceAll("&amp;", "&").replace(/^https:\/\/fluximporter\.com(?=\/)/, "");
		if (/^(mailto:|tel:|data:|javascript:)/.test(url)) continue;
		if (/^(https?:)?\/\//.test(url)) {
			external.add(url);
			continue;
		}
		checked++;
		const [pathAndQuery, fragment] = url.split("#");
		const path = pathAndQuery.split("?")[0];
		const target = path
			? resolveFile(path.startsWith("/") ? path : posix.join(posix.dirname(pagePath), path))
			: page;
		if (!target) {
			broken.push(`${pagePath}: ${url} (no such page)`);
		} else if (fragment && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(fragment))) {
			broken.push(`${pagePath}: ${url} (no #${fragment} on the page)`);
		}
	}
}

console.log(`${pages.length} pages, ${checked} internal links checked, ${external.size} external links (not fetched).`);
for (const url of [...external].sort()) console.log(`  external: ${url}`);
if (broken.length) {
	console.error(`\n${broken.length} broken:`);
	for (const b of broken) console.error(`  ${b}`);
	process.exit(1);
}
console.log("No broken internal links.");
