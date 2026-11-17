import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Opens the dev server's SQLite file directly. Tests use it only for what no API offers: a second
 * user's lock (invites need a passkey), and moving a cron task's due time.
 */
export function withDb<T>(path: string, run: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		return run(db);
	} finally {
		db.close();
	}
}

/** Inserts an account (columns as `emdash` src/astro/routes/api/auth/dev-bypass.ts inserts them). */
function insertUser(db: DatabaseSync, role: number, name: string): string {
	const userId = `01USER${role}X${Date.now()}${Math.floor(Math.random() * 1e6)}`;
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO users (id, email, name, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
	).run(userId, `${userId.toLowerCase()}@example.test`, name, role, now, now);
	return userId;
}

/** Inserts a second account and moves the entry's lock to it. */
export function giveLockToSecondUser(dbPath: string, collection: string, entryId: string): string {
	return withDb(dbPath, (db) => {
		const userId = insertUser(db, 40, "Second editor");
		const moved = db
			.prepare("UPDATE _emdash_entry_locks SET user_id = ? WHERE collection = ? AND entry_id = ?")
			.run(userId, collection, entryId);
		if (moved.changes !== 1) throw new Error(`No lock row for ${collection}/${entryId}`);
		return userId;
	});
}

export function expireLock(dbPath: string, collection: string, entryId: string): void {
	withDb(dbPath, (db) => {
		db.prepare(
			"UPDATE _emdash_entry_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE collection = ? AND entry_id = ?",
		).run(collection, entryId);
	});
}

/**
 * Creates a user with `role` and a PAT with `scopes` for it, stored the way
 * `handleApiTokenCreate` stores one (SHA-256 of the raw token, base64url without padding,
 * `@emdash-cms/auth` src/tokens.ts:206-210). The scope lets the request past the middleware, so
 * only the role decides what the route answers. `scopes` defaults to `admin`; M6c passes
 * `mcp:tools` (Fact E4).
 */
export function createUserToken(dbPath: string, role: number, scopes = ["admin"]): string {
	const raw = `ec_pat_test${role}x${Date.now()}${Math.floor(Math.random() * 1e6)}`;
	const hash = createHash("sha256").update(raw).digest("base64url");
	withDb(dbPath, (db) => {
		const userId = insertUser(db, role, `Role ${role}`);
		db.prepare(
			"INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes) VALUES (?, ?, ?, ?, ?, ?)",
		).run(`TOKEN${userId}`, "test", hash, raw.slice(0, 11), userId, JSON.stringify(scopes));
	});
	return raw;
}
