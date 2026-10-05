/**
 * Per-session index tables in history.db, keyed by session id:
 *
 * - `session_titles`: session id → display title, written whenever a title is
 *   created or renamed ({@link SessionManager.setSessionName}) and backfilled by
 *   the recent-session fallback scan. Lets the welcome "Recent sessions" list
 *   resolve names from a stat + lookup instead of content-scanning every session
 *   file in the project directory (multi-hundred-ms on dirs with thousands of
 *   sessions).
 * - `session_recaps`: append-only journal of idle recaps
 *   ({@link SessionManager.recordRecap}). Recaps are side-channel output that
 *   never enters the session JSONL or LLM context; this table is their only
 *   durable record. `omp gc` drops rows of archived sessions.
 *
 * Holds its own lazily-opened connection instead of {@link HistoryStorage}'s
 * path-pinned singleton: the db path is re-resolved on every call so
 * `setAgentDir`/profile switches (and test isolation) transparently reopen
 * against the right file. The cached connection is keyed on the *file* behind
 * that path, not the path alone — a corruption quarantine unlinks the store and
 * recreates a fresh one at the same path, so a path-only key would keep serving
 * a handle pinned to the deleted inode (#13929). Opens go through
 * `openSqliteDatabaseSync` so this store gets the same BUSY handling and
 * corruption recovery as every other `history.db` owner. Never versions the db —
 * `PRAGMA user_version` is owned by HistoryStorage's rebuild pass, which drops
 * only its own tables.
 */
import { type Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getHistoryDbPath,
	isSqliteBusyError,
	isSqliteCorruptionError,
	logger,
	openSqliteDatabaseSync,
	type SqliteFileIdentity,
	sqliteFileIdentity,
} from "@oh-my-pi/pi-utils";

const SESSION_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE TABLE IF NOT EXISTS session_recaps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	recap TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_session_recaps_session ON session_recaps(session_id, created_at);
`;

/**
 * Identity of the store file: `dev:ino:birthtimeMs`, from
 * {@link sqliteFileIdentity}. `null` is a known-absent file; `undefined` is a
 * path we could not stat, which must never match a cached entry.
 */
type StoreIdentity = SqliteFileIdentity;

/** A db path paired with the identity of the file that was behind it. */
interface StoreRef {
	dbPath: string;
	identity: StoreIdentity;
}

interface SessionIndexHandle extends StoreRef {
	db: Database;
	upsertTitle: Statement;
	selectTitle: Statement;
	insertRecap: Statement;
}

let handle: SessionIndexHandle | undefined;
/** Open failure latched until the path or the file behind it changes; skips retries and log spam. */
let failed: StoreRef | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsertTitle.finalize();
		handle.selectTitle.finalize();
		handle.insertRecap.finalize();
		handle.db.close();
	} catch {}
	handle = undefined;
}

function openSessionIndex(): SessionIndexHandle | undefined {
	const dbPath = getHistoryDbPath();
	const identity = sqliteFileIdentity(dbPath);
	// Reuse a cached entry only while the file it was opened against is still
	// the file at this path. An unknown identity (a stat that failed for any
	// reason other than "absent") matches nothing, so a handle can never be
	// served for a file we cannot identify.
	if (handle && identity !== undefined && handle.dbPath === dbPath && handle.identity === identity) return handle;
	if (failed && identity !== undefined && failed.dbPath === dbPath && failed.identity === identity) return undefined;
	closeHandle();
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const opened = openSqliteDatabaseSync(
			dbPath,
			db => {
				db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${SESSION_INDEX_DDL}`);
				return {
					db,
					upsertTitle: db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
			`),
					selectTitle: db.prepare("SELECT title FROM session_titles WHERE session_id = ?"),
					insertRecap: db.prepare("INSERT INTO session_recaps (session_id, cwd, recap) VALUES (?, ?, ?)"),
				};
			},
			// Same recovery as HistoryStorage: a damaged store is quarantined and
			// recreated once, and the index tables are rebuilt on the live file.
			{ recoverCorruption: true },
		);
		// Re-stat after the open so a store this call just created counts as the
		// current file on the next one.
		handle = { dbPath, identity: sqliteFileIdentity(dbPath), ...opened };
		failed = undefined;
		return handle;
	} catch (error) {
		// A lock conflict means another writer holds the store for a moment, not
		// that the store is broken, so it must not latch the path for the rest
		// of the process (#13929).
		if (!isSqliteBusyError(error)) failed = { dbPath, identity };
		logger.warn("Session index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/**
 * Run `use` against the index connection, re-resolving the store once when the
 * handle turns out to be pinned to a damaged file. A quarantine replaces the
 * store at the same path, so the retry — never a stale handle — is what reaches
 * the live file. Returns undefined when no index is available.
 */
function withSessionIndex<T>(use: (index: SessionIndexHandle) => T): T | undefined {
	const index = openSessionIndex();
	if (!index) return undefined;
	try {
		return use(index);
	} catch (error) {
		if (!isSqliteCorruptionError(error)) throw error;
		logger.warn("Session index store is damaged; reopening", { dbPath: index.dbPath, error: String(error) });
	}
	// Drop the connection before reopening: leaving it attached keeps the dead
	// file pinned and blocks the quarantine's unlink.
	if (handle === index) closeHandle();
	const reopened = openSessionIndex();
	return reopened ? use(reopened) : undefined;
}

/**
 * Record (or replace) the indexed title for a session id. Best-effort: index
 * failures must never break a rename, so errors are logged and swallowed. A
 * write that never lands is logged at warn: the caller would otherwise believe
 * the title is durable while no reader can ever find it.
 */
export function recordSessionTitle(sessionId: string, title: string): void {
	try {
		withSessionIndex(index => {
			index.upsertTitle.run(sessionId, title);
		});
	} catch (error) {
		logger.warn("Session title index write failed", { sessionId, error: String(error) });
	}
}

/** Indexed title for a session id, or undefined when unindexed/unavailable. */
export function lookupSessionTitle(sessionId: string): string | undefined {
	try {
		return withSessionIndex(index => (index.selectTitle.get(sessionId) as { title: string } | null)?.title);
	} catch (error) {
		logger.debug("Session title index read failed", { sessionId, error: String(error) });
		return undefined;
	}
}

/**
 * Append an idle recap to the session's recap journal. Best-effort: a journal
 * failure must never disturb the recap display, so errors are logged and swallowed.
 * Recaps have no other durable record, so a dropped write is logged at warn.
 */
export function recordSessionRecap(sessionId: string, cwd: string, recap: string): void {
	try {
		withSessionIndex(index => {
			index.insertRecap.run(sessionId, cwd, recap);
		});
	} catch (error) {
		logger.warn("Session recap journal write failed", { sessionId, error: String(error) });
	}
}

/** @internal Close the cached connection so the next call re-resolves the db path — test-only. */
export function resetSessionIndexForTests(): void {
	closeHandle();
	failed = undefined;
}
