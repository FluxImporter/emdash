import { describe, expect, it } from "vitest";
import { allowPrivateNetwork } from "../../src/astro/config.js";
import {
	checkHost,
	dohResolver,
	guardedFetch,
	isBlockedHostname,
	isPublicAddress,
	MAX_REDIRECTS,
	type NetOptions,
	nodeResolver,
	parseSourceUrl,
	type Resolver,
	URL_MAX_LENGTH,
	UrlSourceError,
} from "../../src/sources/net.js";

interface Sent {
	url: string;
	headers: Record<string, string>;
	redirect: RequestRedirect | undefined;
}

/** A fetch that answers from `routes` by URL and records every request. */
function fakeNet(
	routes: Record<string, () => Response>,
	resolver: Resolver = async () => ["93.184.215.14"],
	allowPrivate = false,
) {
	const sent: Sent[] = [];
	const resolved: string[] = [];
	const net: NetOptions = {
		allowPrivateNetwork: allowPrivate,
		resolver: async (host) => {
			resolved.push(host);
			return resolver(host);
		},
		fetch: async (input, init) => {
			const url = String(input);
			sent.push({
				url,
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				redirect: init?.redirect,
			});
			const answer = routes[url];
			if (!answer) throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
			return answer();
		},
	};
	return { net, sent, resolved };
}

const redirect =
	(location: string, status = 302) =>
	() =>
		new Response("moved", { status, headers: { location } });
const ok =
	(body = "a,b\n1,2\n") =>
	() =>
		new Response(body, { status: 200 });

function request(headers: Record<string, string> = {}, credentialHeader?: string) {
	return {
		headers: new Headers(headers),
		signal: new AbortController().signal,
		...(credentialHeader === undefined ? {} : { credentialHeader }),
	};
}

async function failure(promise: Promise<unknown>): Promise<UrlSourceError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(UrlSourceError);
	return error as UrlSourceError;
}

describe("parseSourceUrl", () => {
	it("accepts http and https URLs", () => {
		expect(parseSourceUrl("https://feeds.example.com/a.csv?x=1").href).toBe(
			"https://feeds.example.com/a.csv?x=1",
		);
		expect(parseSourceUrl("http://example.com").href).toBe("http://example.com/");
	});

	it.each([
		["ftp://example.com/a.csv", 'The URL scheme "ftp:" is not allowed; use http or https'],
		["file:///etc/passwd", 'The URL scheme "file:" is not allowed; use http or https'],
		["data:text/csv,a", 'The URL scheme "data:" is not allowed; use http or https'],
		["https://user@example.com/", "URLs cannot contain a user name or password; use a credential"],
		["https://:pw@example.com/", "URLs cannot contain a user name or password; use a credential"],
		["not a url", "The URL is not valid"],
		[`https://example.com/${"a".repeat(URL_MAX_LENGTH)}`, "URLs are limited to 2048 characters"],
	])("rejects %s", (text, message) => {
		expect(() => parseSourceUrl(text)).toThrow(new UrlSourceError("URL_BLOCKED", message));
	});
});

describe("isPublicAddress", () => {
	it.each([
		"0.0.0.0",
		"0.255.255.255",
		"10.0.0.1",
		"10.255.255.255",
		"100.64.0.1",
		"100.127.255.255",
		"127.0.0.1",
		"127.255.255.254",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.8",
		"192.168.1.1",
		"198.18.0.1",
		"198.19.255.255",
		"224.0.0.1",
		"239.255.255.250",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"febf::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:10.1.2.3",
		"::ffff:a9fe:a9fe",
		"::127.0.0.1",
		"64:ff9b::10.0.0.1",
		"64:ff9b::a00:1",
		"64:ff9b::7f00:1",
		"2001::1",
		"2001:db8::1",
		"2002:7f00:1::1",
	])("blocks %s", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"93.184.215.14",
		"100.63.255.255",
		"100.128.0.0",
		"172.15.255.255",
		"172.32.0.0",
		"192.0.1.1",
		"198.17.255.255",
		"198.20.0.0",
		"223.255.255.255",
		"2606:4700:4700::1111",
		"2a00:1450:4001:80b::200e",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
	])("allows %s", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});

	it.each([
		"example.com",
		"1.2.3",
		"1.2.3.4.5",
		"01.2.3.4",
		"256.1.1.1",
		"1::2::3",
		"fe80::1%eth0",
		"12345::",
		"1:2:3:4:5:6:7:8:9",
	])("does not read %s as an address", (text) => {
		expect(isPublicAddress(text)).toBeNull();
	});
});

describe("checkHost", () => {
	it.each([
		"http://localhost/",
		"http://LOCALHOST./feed",
		"http://api.localhost/",
		"http://printer.local/",
		"http://db.internal/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://metadata/",
		"http://nas.home.arpa/",
	])("blocks the host of %s", (text) => {
		expect(() => checkHost(new URL(text), false)).toThrow(UrlSourceError);
	});

	it.each([
		["http://2130706433/", "127.0.0.1"],
		["http://0x7f.1/", "127.0.0.1"],
		["http://0177.0.0.1/", "127.0.0.1"],
		["http://127.1/", "127.0.0.1"],
		["http://0xa9fea9fe/", "169.254.169.254"],
		["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
		["http://[64:ff9b::10.0.0.1]/", "64:ff9b::a00:1"],
		["http://[::1]:8080/", "::1"],
	])("blocks %s, which URL normalises to %s", (text, host) => {
		expect(() => checkHost(new URL(text), false)).toThrow(
			new UrlSourceError("URL_BLOCKED", `The address ${host} is not public`),
		);
	});

	it("allows public hosts and addresses, and anything when private networks are allowed", () => {
		for (const text of ["https://example.com/", "http://8.8.8.8/", "http://[2606:4700::1]/"]) {
			expect(() => checkHost(new URL(text), false)).not.toThrow();
		}
		for (const text of ["http://localhost/", "http://127.0.0.1:4000/", "http://[::1]/"]) {
			expect(() => checkHost(new URL(text), true)).not.toThrow();
		}
		expect(isBlockedHostname("localhost.example.com")).toBe(false);
		expect(isBlockedHostname("internal.example.com")).toBe(false);
	});
});

describe("guardedFetch", () => {
	it("resolves the host, then fetches with manual redirects", async () => {
		const { net, sent, resolved } = fakeNet({ "https://feeds.example.com/a.csv": ok() });
		const response = await guardedFetch("https://feeds.example.com/a.csv", request(), net);
		expect(await response.text()).toBe("a,b\n1,2\n");
		expect(resolved).toEqual(["feeds.example.com"]);
		expect(sent).toEqual([
			{ url: "https://feeds.example.com/a.csv", headers: {}, redirect: "manual" },
		]);
	});

	it("blocks a host that resolves to a private address before connecting", async () => {
		const { net, sent } = fakeNet({}, async () => ["93.184.215.14", "10.0.0.5"]);
		const error = await failure(guardedFetch("https://evil.example.com/", request(), net));
		expect(error).toMatchObject({
			code: "URL_BLOCKED",
			message: "evil.example.com resolves to an address that is not public",
		});
		expect(sent).toEqual([]);
	});

	it("fails with FETCH_FAILED when DNS fails or gives no address", async () => {
		const down = fakeNet({}, async () => {
			throw new Error("getaddrinfo ENOTFOUND nowhere.example");
		});
		expect(await failure(guardedFetch("https://nowhere.example/", request(), down.net))).toEqual(
			new UrlSourceError(
				"FETCH_FAILED",
				"Could not resolve nowhere.example: getaddrinfo ENOTFOUND nowhere.example",
			),
		);
		const empty = fakeNet({}, async () => []);
		expect(await failure(guardedFetch("https://empty.example/", request(), empty.net))).toEqual(
			new UrlSourceError("FETCH_FAILED", "empty.example has no addresses"),
		);
	});

	it("fails with FETCH_FAILED when the connection fails, naming the host only", async () => {
		const { net } = fakeNet({});
		expect(
			await failure(guardedFetch("https://down.example/feed?key=SECRET", request(), net)),
		).toEqual(
			new UrlSourceError(
				"FETCH_FAILED",
				"Could not fetch from down.example: fetch failed: ECONNREFUSED",
			),
		);
	});

	it("checks every redirect target and blocks one that points to a private host", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/feed": redirect("http://169.254.169.254/latest/meta-data/"),
		});
		expect(await failure(guardedFetch("https://a.example/feed", request(), net))).toEqual(
			new UrlSourceError("URL_BLOCKED", "The address 169.254.169.254 is not public"),
		);
		expect(sent.map((s) => s.url)).toEqual(["https://a.example/feed"]);
	});

	it("blocks a redirect to another scheme or to a URL with a user name", async () => {
		const ftp = fakeNet({ "https://a.example/": redirect("ftp://a.example/x") });
		expect((await failure(guardedFetch("https://a.example/", request(), ftp.net))).code).toBe(
			"URL_BLOCKED",
		);
		const user = fakeNet({ "https://a.example/": redirect("https://u:p@b.example/") });
		expect((await failure(guardedFetch("https://a.example/", request(), user.net))).code).toBe(
			"URL_BLOCKED",
		);
	});

	it("keeps the credential on same-origin hops and drops it for good once the origin changes", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/1": redirect("/2", 301),
			"https://a.example/2": redirect("https://b.example/3", 307),
			"https://b.example/3": redirect("https://a.example/4", 308),
			"https://a.example/4": ok(),
		});
		const response = await guardedFetch(
			"https://a.example/1",
			request({ "x-api-key": "k1", "if-none-match": '"v1"' }, "x-api-key"),
			net,
		);
		expect(response.status).toBe(200);
		expect(sent.map((s) => [s.url, s.headers["x-api-key"], s.headers["if-none-match"]])).toEqual([
			["https://a.example/1", "k1", '"v1"'],
			["https://a.example/2", "k1", '"v1"'],
			["https://b.example/3", undefined, '"v1"'],
			["https://a.example/4", undefined, '"v1"'],
		]);
	});

	it("drops the credential when a redirect moves from https to http on the same host", async () => {
		const { net, sent } = fakeNet({
			"https://a.example/": redirect("http://a.example/"),
			"http://a.example/": ok(),
		});
		await guardedFetch(
			"https://a.example/",
			request({ authorization: "Bearer t" }, "authorization"),
			net,
		);
		expect(sent.map((s) => s.headers.authorization)).toEqual(["Bearer t", undefined]);
	});

	it(`follows ${MAX_REDIRECTS} redirects and fails on the next one`, async () => {
		const chain = (hops: number) =>
			Object.fromEntries(
				Array.from({ length: hops + 1 }, (_, i) => [
					`https://a.example/${i}`,
					i < hops ? redirect(`/${i + 1}`) : ok(),
				]),
			);
		const five = fakeNet(chain(MAX_REDIRECTS));
		expect((await guardedFetch("https://a.example/0", request(), five.net)).status).toBe(200);
		expect(five.sent).toHaveLength(6);
		const six = fakeNet(chain(MAX_REDIRECTS + 1));
		expect(await failure(guardedFetch("https://a.example/0", request(), six.net))).toEqual(
			new UrlSourceError("TOO_MANY_REDIRECTS", "More than 5 redirects"),
		);
		expect(six.sent).toHaveLength(6);
	});

	it("returns a redirect status without a Location, and a 304, as the response", async () => {
		const { net } = fakeNet({
			"https://a.example/300": () => new Response(null, { status: 300 }),
			"https://a.example/304": () => new Response(null, { status: 304 }),
		});
		expect((await guardedFetch("https://a.example/300", request(), net)).status).toBe(300);
		expect((await guardedFetch("https://a.example/304", request(), net)).status).toBe(304);
	});

	it("skips host and address checks, but not the scheme, when private networks are allowed", async () => {
		const { net, resolved } = fakeNet(
			{
				"http://127.0.0.1:4000/feed": redirect("http://localhost:4000/x"),
				"http://localhost:4000/x": ok(),
			},
			async () => ["127.0.0.1"],
			true,
		);
		expect((await guardedFetch("http://127.0.0.1:4000/feed", request(), net)).status).toBe(200);
		expect(resolved).toEqual([]);
		expect((await failure(guardedFetch("ftp://127.0.0.1/", request(), net))).code).toBe(
			"URL_BLOCKED",
		);
	});

	it("rejects with the abort reason when the signal aborts during DNS", async () => {
		const controller = new AbortController();
		const { net } = fakeNet({}, () => new Promise<string[]>(() => {}));
		const pending = guardedFetch(
			"https://slow-dns.example/",
			{ headers: new Headers(), signal: controller.signal },
			net,
		);
		const reason = new UrlSourceError("FETCH_FAILED", "No response headers within 15 s");
		controller.abort(reason);
		expect(await failure(pending)).toBe(reason);
	});
});

describe("resolvers", () => {
	it("dohResolver asks for A and AAAA records and keeps only addresses of that type", async () => {
		const asked: string[] = [];
		const resolve = dohResolver(async (input, init) => {
			asked.push(`${String(input)} ${new Headers(init?.headers).get("accept")}`);
			const type = new URL(String(input)).searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer:
					type === "A"
						? [
								{ name: "feeds.example.com", type: 5, data: "cdn.example.net." },
								{ name: "cdn.example.net", type: 1, data: "93.184.215.14" },
							]
						: [
								{
									name: "cdn.example.net",
									type: 28,
									data: "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
								},
							],
			});
		});
		expect(await resolve("feeds.example.com")).toEqual([
			"93.184.215.14",
			"2606:2800:21f:cb07:6820:80da:af6b:8b2c",
		]);
		expect(asked).toEqual([
			"https://cloudflare-dns.com/dns-query?name=feeds.example.com&type=A application/dns-json",
			"https://cloudflare-dns.com/dns-query?name=feeds.example.com&type=AAAA application/dns-json",
		]);
	});

	it("dohResolver gives no addresses for NXDOMAIN and rejects other failures", async () => {
		expect(await dohResolver(async () => Response.json({ Status: 3 }))("nx.example")).toEqual([]);
		await expect(
			dohResolver(async () => Response.json({ Status: 2 }))("x.example"),
		).rejects.toThrow("DNS over HTTPS failed with status 2");
		await expect(
			dohResolver(async () => new Response("no", { status: 503 }))("x.example"),
		).rejects.toThrow("DNS over HTTPS answered 503");
	});

	it("nodeResolver returns every address from the system resolver", async () => {
		const addresses = await nodeResolver("localhost");
		expect(addresses.length).toBeGreaterThan(0);
		expect(addresses.every((a) => isPublicAddress(a) === false)).toBe(true);
	});
});

describe("allowPrivateNetwork", () => {
	it("is honoured only in development", () => {
		expect(allowPrivateNetwork(true, true)).toBe(true);
		expect(allowPrivateNetwork(true, false)).toBe(false);
		expect(allowPrivateNetwork(false, true)).toBe(false);
	});

	it("is off when fluxImportRoutes() did not set it", () => {
		expect(allowPrivateNetwork()).toBe(false);
	});
});
