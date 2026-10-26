import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FeedRequest {
	path: string;
	headers: IncomingHttpHeaders;
	status: number;
}

export interface Feed {
	body: string;
	/** Sends an ETag and answers a matching If-None-Match with 304. */
	etag?: boolean;
	/** Answers 401 unless the Authorization header is exactly this. */
	authorization?: string;
	/** Sends the body in two chunks without a Content-Length (Transfer-Encoding: chunked). */
	chunked?: boolean;
}

/**
 * A local HTTP server for URL source tests. Paths not in `feeds` answer 404; every request is
 * logged with its headers and the status sent.
 */
export class FeedServer {
	readonly feeds = new Map<string, Feed>();
	readonly requests: FeedRequest[] = [];
	private server: Server | undefined;
	baseUrl = "";

	async start(): Promise<void> {
		const server = createServer((req, res) => {
			const path = new URL(req.url ?? "/", "http://feed").pathname;
			const feed = this.feeds.get(path);
			const send = (status: number, headers: Record<string, string> = {}, body?: string) => {
				this.requests.push({ path, headers: req.headers, status });
				if (feed?.chunked && status === 200 && body !== undefined) {
					res.writeHead(status, headers);
					const half = Math.floor(body.length / 2);
					res.write(body.slice(0, half));
					setTimeout(() => res.end(body.slice(half)), 20);
					return;
				}
				res.writeHead(status, {
					...headers,
					...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
				});
				res.end(body);
			};
			if (!feed) return send(404, {}, "not found");
			if (feed.authorization !== undefined && req.headers.authorization !== feed.authorization) {
				return send(401, {}, "unauthorized");
			}
			const tag = `"${createHash("sha256").update(feed.body).digest("hex").slice(0, 16)}"`;
			if (feed.etag && req.headers["if-none-match"] === tag) return send(304, { etag: tag });
			send(200, { "content-type": "text/csv", ...(feed.etag ? { etag: tag } : {}) }, feed.body);
		});
		this.server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${port}`;
	}

	url(path: string): string {
		return `${this.baseUrl}${path}`;
	}

	/** The requests made to `path`, oldest first. */
	log(path: string): FeedRequest[] {
		return this.requests.filter((r) => r.path === path);
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
}
