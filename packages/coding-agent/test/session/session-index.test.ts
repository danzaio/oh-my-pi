import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	lookupSessionTitle,
	recordSessionRecap,
	recordSessionTitle,
	resetSessionIndexForTests,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * `history.db` can be quarantined and recreated at the same path underneath a
 * live session-index connection (HistoryStorage's corruption recovery unlinks the
 * damaged store). A handle cached on the path alone then keeps writing to the
 * deleted file, so every indexed title and recap is accepted and lost. These
 * tests pin that a write after a quarantine reaches the live store, and that a
 * transient lock conflict does not disable the index for the rest of the process.
 */
describe("session index store replacement", () => {
	const SESSION_ID = "01a0f40f-6f2a-4c1e-9d3b-5a7c8e0f1a2b";
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-index-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
		resetSessionIndexForTests();
	});

	afterEach(() => {
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	/** Reads through an independent connection, so only the live store can satisfy it. */
	function readLiveStore<T>(use: (db: Database) => T): T {
		const db = new Database(getHistoryDbPath());
		try {
			return use(db);
		} finally {
			db.close();
		}
	}

	it("writes titles and recaps to the live store after the store is quarantined and recreated", () => {
		recordSessionTitle(SESSION_ID, "Recoverable title");
		recordSessionRecap(SESSION_ID, cwd, "recap before quarantine");
		// Fold the WAL into the main file so the damage below lands on the pages a
		// fresh reader has to parse, exactly as it would after a real corruption.
		readLiveStore(db => db.run("PRAGMA wal_checkpoint(TRUNCATE)"));
		expect(
			readLiveStore(db => db.query("SELECT title FROM session_titles WHERE session_id = ?").get(SESSION_ID)),
		).toEqual({
			title: "Recoverable title",
		});

		const dbPath = getHistoryDbPath();
		fs.writeFileSync(dbPath, new Uint8Array(fs.statSync(dbPath).size).fill(0x5a));

		recordSessionTitle(SESSION_ID, "after quarantine");
		recordSessionRecap(SESSION_ID, cwd, "recap after quarantine");

		// The damaged file is gone: these rows are only observable if the index
		// re-resolved the store instead of serving its cached connection.
		expect(lookupSessionTitle(SESSION_ID)).toBe("after quarantine");
		expect(
			readLiveStore(db => db.query("SELECT title FROM session_titles WHERE session_id = ?").get(SESSION_ID)),
		).toEqual({ title: "after quarantine" });
		expect(
			readLiveStore(db =>
				db.query("SELECT recap FROM session_recaps WHERE recap = ?").get("recap after quarantine"),
			),
		).toEqual({ recap: "recap after quarantine" });
		// The damaged store was preserved aside by the quarantine, which is what
		// replaced the file behind the cached handle.
		expect(
			fs.readdirSync(path.dirname(dbPath)).filter(name => name.startsWith("history.db.corrupt-")),
		).not.toHaveLength(0);
	});

	it("keeps the index usable after a busy store rejects the first open", () => {
		const dbPath = getHistoryDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		// Left in the rollback journal mode, so the index's own
		// `PRAGMA journal_mode=WAL` is the statement that collides with the lock.
		const seed = new Database(dbPath);
		seed.run("CREATE TABLE seed (a)");
		seed.close();
		const blocker = new Database(dbPath);
		blocker.run("BEGIN EXCLUSIVE");
		recordSessionTitle(SESSION_ID, "written while locked");
		blocker.run("ROLLBACK");
		blocker.close();

		recordSessionTitle(SESSION_ID, "written after lock released");

		expect(lookupSessionTitle(SESSION_ID)).toBe("written after lock released");
		expect(
			readLiveStore(db => db.query("SELECT title FROM session_titles WHERE session_id = ?").get(SESSION_ID)),
		).toEqual({ title: "written after lock released" });
	});
});
