/**
 * log-db.ts — Pure SQLite layer for session logs.
 *
 * PORTABILITY RULES:
 *  - Import ONLY better-sqlite3 and Node built-ins.
 *  - No electron, no debug-logger, no other main-process modules.
 *  - Side-effect-free at import time (no top-level DB open).
 *  - No default export (project convention).
 *
 * This module is the sole consumer of better-sqlite3 and will be owned by a
 * logging utilityProcess worker. It runs cleanly under Electron-as-Node in tests.
 */
import Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  sessionId: string
  configId: string | null
  configLabel: string
  projectCwd: string | null
  accountEmail: string | null
  profileId: string | null
  provider: string
  startedAt: number
  endedAt: number | null
  status: string
  byteSize: number
  eventCount: number
}

export interface EventRecord {
  id: number
  sessionId: string
  seq: number
  ts: number
  type: string
  raw: Buffer
  text: string
}

export interface SearchHit {
  sessionId: string
  eventId: number
  seq: number
  ts: number
  snippet?: string
}

export interface LogDb {
  upsertSession(s: {
    sessionId: string
    configId?: string
    configLabel: string
    projectCwd?: string
    accountEmail?: string
    profileId?: string
    provider: string
    startedAt: number
  }): void

  appendBatch(
    events: Array<{
      sessionId: string
      ts: number
      type: 'start' | 'data' | 'restart' | 'switch' | 'end'
      raw: Buffer | Uint8Array
      text: string
    }>,
  ): void

  listSessions(opts?: { offset?: number; limit?: number }): SessionRecord[]

  readEvents(sessionId: string, opts: { offset: number; limit: number }): EventRecord[]

  search(query: string, opts?: { limit?: number }): SearchHit[]

  pruneSessions(ids: string[]): void

  finishSession(sessionId: string, endedAt: number, status: string): void

  close(): void
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
  sessionId   TEXT PRIMARY KEY,
  configId    TEXT,
  configLabel TEXT NOT NULL,
  projectCwd  TEXT,
  accountEmail TEXT,
  profileId   TEXT,
  provider    TEXT NOT NULL,
  startedAt   INTEGER NOT NULL,
  endedAt     INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',
  byteSize    INTEGER NOT NULL DEFAULT 0,
  eventCount  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(sessionId) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL,
  raw       BLOB NOT NULL,
  text      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(sessionId, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_config_started ON sessions(configId, startedAt);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
  USING fts5(text, content='events', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', '1');
`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) a log database at the given path.
 * Pass ':memory:' for an in-memory database (tests, ephemeral use).
 */
export function openLogDb(path: string): LogDb {
  const sqlite = new Database(path)

  // Apply PRAGMAs and create schema. exec() runs multiple semicolon-separated
  // statements so we can do this in one shot.
  sqlite.exec(DDL)

  // ---------------------------------------------------------------------------
  // Prepared statements (prepared once; reused across calls for performance)
  // ---------------------------------------------------------------------------

  const stmtUpsertSession: Statement = sqlite.prepare(`
    INSERT INTO sessions (sessionId, configId, configLabel, projectCwd, accountEmail, profileId, provider, startedAt)
    VALUES (@sessionId, @configId, @configLabel, @projectCwd, @accountEmail, @profileId, @provider, @startedAt)
    ON CONFLICT(sessionId) DO NOTHING
  `)

  const stmtInsertEvent: Statement = sqlite.prepare(`
    INSERT INTO events (sessionId, seq, ts, type, raw, text)
    VALUES (@sessionId, @seq, @ts, @type, @raw, @text)
  `)

  // Reads the current eventCount for seq assignment — called once per touched
  // session inside the appendBatch transaction.
  const stmtGetEventCount: Statement = sqlite.prepare<[string], { eventCount: number }>(
    `SELECT eventCount FROM sessions WHERE sessionId = ?`,
  )

  const stmtUpdateSessionCounts: Statement = sqlite.prepare(`
    UPDATE sessions
    SET byteSize   = byteSize   + @bytesDelta,
        eventCount = eventCount + @countDelta
    WHERE sessionId = @sessionId
  `)

  const stmtListSessions: Statement = sqlite.prepare(`
    SELECT * FROM sessions ORDER BY startedAt DESC LIMIT @limit OFFSET @offset
  `)

  const stmtReadEvents: Statement = sqlite.prepare(`
    SELECT * FROM events WHERE sessionId = @sessionId ORDER BY seq LIMIT @limit OFFSET @offset
  `)

  // FTS5 search: join events_fts to events to get the full row.
  // snippet() uses FTS column index 0 (text), marks up to 16 tokens.
  const stmtSearch: Statement = sqlite.prepare(`
    SELECT
      e.id         AS eventId,
      e.sessionId  AS sessionId,
      e.seq        AS seq,
      e.ts         AS ts,
      snippet(events_fts, 0, '[', ']', '...', 16) AS snippet
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH @query
    ORDER BY rank
    LIMIT @limit
  `)

  const stmtFinishSession: Statement = sqlite.prepare(`
    UPDATE sessions SET endedAt = @endedAt, status = @status WHERE sessionId = @sessionId
  `)

  const stmtDeleteSession: Statement = sqlite.prepare(
    `DELETE FROM sessions WHERE sessionId = ?`,
  )

  // Wrap the entire appendBatch in a single SQLite transaction.
  const runAppendBatch = sqlite.transaction(
    (
      events: Array<{
        sessionId: string
        ts: number
        type: string
        raw: Buffer | Uint8Array
        text: string
      }>,
    ) => {
      // Group events by sessionId so we can read eventCount once per session
      // rather than once per event, and accumulate byte/count deltas together.
      const sessionDeltas = new Map<string, { bytesDelta: number; countDelta: number; nextSeq: number }>()

      for (const ev of events) {
        if (!sessionDeltas.has(ev.sessionId)) {
          const row = stmtGetEventCount.get(ev.sessionId) as { eventCount: number } | undefined
          const currentCount = row?.eventCount ?? 0
          sessionDeltas.set(ev.sessionId, { bytesDelta: 0, countDelta: 0, nextSeq: currentCount })
        }

        const delta = sessionDeltas.get(ev.sessionId)!

        // Convert Uint8Array (non-Buffer view) to a proper Buffer without
        // copying the wrong bytes from a shared ArrayBuffer.
        let rawBuf: Buffer
        if (Buffer.isBuffer(ev.raw)) {
          rawBuf = ev.raw
        } else {
          const u8 = ev.raw as Uint8Array
          rawBuf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
        }

        stmtInsertEvent.run({
          sessionId: ev.sessionId,
          seq: delta.nextSeq,
          ts: ev.ts,
          type: ev.type,
          raw: rawBuf,
          text: ev.text,
        })

        delta.bytesDelta += rawBuf.length
        delta.countDelta += 1
        delta.nextSeq += 1
      }

      // Flush per-session deltas in one UPDATE each
      for (const [sessionId, delta] of sessionDeltas) {
        stmtUpdateSessionCounts.run({
          sessionId,
          bytesDelta: delta.bytesDelta,
          countDelta: delta.countDelta,
        })
      }
    },
  )

  // Wrap the entire pruneSessions in a single transaction.
  // events CASCADE-delete when the session is deleted, and the events_ad
  // trigger fires for each deleted event row, cleaning up events_fts.
  const runPruneSessions = sqlite.transaction((ids: string[]) => {
    for (const id of ids) {
      stmtDeleteSession.run(id)
    }
  })

  // ---------------------------------------------------------------------------
  // LogDb implementation
  // ---------------------------------------------------------------------------

  return {
    upsertSession(s) {
      stmtUpsertSession.run({
        sessionId: s.sessionId,
        configId: s.configId ?? null,
        configLabel: s.configLabel,
        projectCwd: s.projectCwd ?? null,
        accountEmail: s.accountEmail ?? null,
        profileId: s.profileId ?? null,
        provider: s.provider,
        startedAt: s.startedAt,
      })
    },

    appendBatch(events) {
      if (events.length === 0) return
      runAppendBatch(events)
    },

    listSessions(opts = {}) {
      const offset = opts.offset ?? 0
      const limit = opts.limit ?? 100
      return stmtListSessions.all({ limit, offset }) as SessionRecord[]
    },

    readEvents(sessionId, opts) {
      return stmtReadEvents.all({
        sessionId,
        limit: opts.limit,
        offset: opts.offset,
      }) as EventRecord[]
    },

    search(query, opts = {}) {
      const limit = opts.limit ?? 50

      // Sanitize the query: tokenize on whitespace and double-quote each token
      // per FTS5 phrase rules (embedded `"` → `""`). This makes every plain
      // query match literally regardless of casing or special chars — so a
      // term like "AND", "OR", "NOT", or "foo(bar)" is never parsed as an FTS
      // boolean operator or a syntax error.  The try/catch below is a final
      // safety net for any edge case the sanitizer doesn't cover.
      const trimmed = query.trim()
      const safeQuery = trimmed
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => `"${tok.replace(/"/g, '""')}"`)
        .join(' ')

      try {
        return stmtSearch.all({ query: safeQuery, limit }) as SearchHit[]
      } catch {
        // If FTS still chokes on a malformed query, return empty rather than throwing
        return []
      }
    },

    pruneSessions(ids) {
      if (ids.length === 0) return
      runPruneSessions(ids)
    },

    finishSession(sessionId, endedAt, status) {
      stmtFinishSession.run({ sessionId, endedAt, status })
    },

    close() {
      sqlite.close()
    },
  }
}
