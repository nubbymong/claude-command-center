/**
 * transcripts-db.ts — Pure SQLite layer for the transcript-indexing system (Logs v2).
 *
 * PORTABILITY RULES (same as log-db.ts):
 *  - Import ONLY better-sqlite3 and Node built-ins.
 *  - No electron, no debug-logger, no other main-process modules.
 *  - Side-effect-free at import time (no top-level DB open).
 *  - No default export (project convention).
 *
 * This module runs ONLY inside the forked log worker — better-sqlite3 is allowed
 * here and must never be importable from the main bundle.
 *
 * Data model (schema v1):
 *  - runs: one row PER SPAWN. CCC reuses sessionId across restarts, so insertRun
 *    ALWAYS creates a new row; closeRun/setRunAccount target the latest OPEN run.
 *  - transcripts: source files bound to a run, ordered by `ord` (bind order),
 *    upserted by (runId, path).
 *  - messages: parsed transcript messages addressed by the pair (runId, idx) —
 *    there is no global ordinal.
 *  - messages_fts: FTS5 index over messages.content, maintained by triggers
 *    (the FK cascade on runs-delete fires the delete trigger, so FTS rows are
 *    cleaned up automatically).
 *
 * Stitching semantics:
 *  - Stitched order over a scope = runs ordered by (startedAt, runId), messages
 *    by idx within each run.
 *  - Whenever a returned page spans a run boundary, a synthesized
 *    { idx: -1, kind: 'relaunch' } row is inserted between the two runs. It is
 *    never stored in the DB and never counts against the page limit.
 */
import Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StitchedMessage {
  runId: number
  idx: number
  ts: number
  role: string
  kind: string
  content: string
  toolName: string | null
  toolMeta: string | null
}

/** Shape returned by listResumableTranscripts(). */
export interface ResumableTranscript {
  transcriptId: number
  runId: number
  path: string
  ingestCursor: number
  parserVersion: number
}

/** Shape returned by listSlots(). */
export interface SlotSummary {
  slotKey: string
  configId: string | null
  configLabel: string
  accountEmail: string | null
  lastActive: number
  runCount: number
  messageCount: number
}

/** Shape returned by searchMessages(). */
export interface TranscriptSearchHit {
  runId: number
  idx: number
  configId: string | null
  sessionId: string
  snippet: string
}

/** One message passed to appendMessages(). */
export interface NewMessage {
  idx: number
  ts: number
  role: string
  kind: string
  content: string
  toolName?: string
  toolMeta?: string
  raw?: string
}

export type TranscriptScope = { configId: string } | { sessionId: string }

export interface TranscriptsDb {
  /**
   * Insert a NEW run row and return its runId. ALWAYS a new row — CCC reuses
   * sessionId across restarts, so runs are per-spawn.
   */
  insertRun(meta: {
    sessionId: string
    configId?: string
    configLabel: string
    projectCwd?: string
    accountEmail?: string
    profileId?: string
    provider: string
    startedAt: number
  }): number

  /** Close the LATEST OPEN run (status='running') for sessionId; no-op if none. */
  closeRun(sessionId: string, endedAt: number, status: string): void

  /** runId of the LATEST OPEN run (status='running') for sessionId, or null when
   *  none. Lets run-start find a prior un-closed run (live-restart race OR a
   *  boot-resurrected orphan whose in-memory sessionToRun entry is empty) so it
   *  can retire it before opening the new one. */
  getOpenRunId(sessionId: string): number | null

  /** Close EVERY open run (status='running') with the given endedAt + status,
   *  returning their runIds. Called by the worker on a clean shutdown so live
   *  runs are finalized (not left 'running' to be resurrected next boot). */
  closeAllOpenRuns(endedAt: number, status: string): number[]

  /** Set accountEmail on the latest open run for sessionId; no-op if none. */
  setRunAccount(sessionId: string, accountEmail: string): void

  /** Update configLabel (display name) on the latest open run for sessionId;
   *  no-op if none. Drives the logs/history tab's session name after a rename. */
  renameRun(sessionId: string, configLabel: string): void

  /**
   * Close EVERY dangling run (status='running') as crashed in one statement:
   * endedAt = max(message ts for that run) falling back to startedAt. Called by
   * the worker on open — a dangling run means the previous app session died.
   * Returns the number of runs closed.
   */
  closeDanglingRuns(): number

  /**
   * Re-open a run to status='running' (clearing endedAt). Called by the worker's
   * resume loop after closeDanglingRuns(): a run with a resumable ('tailing')
   * transcript is genuinely still live (worker-only restart while Claude keeps
   * appending), so it must not stay 'crashed'.
   */
  reopenRun(runId: number): void

  /** sessionId + configId for a run (new-messages attribution on tail resume);
   *  null when the run does not exist. */
  getRunScope(runId: number): { sessionId: string; configId: string | null } | null

  /** max(ts) over a run's messages, or null when it has none (normalizer startTs seed). */
  lastMessageTs(runId: number): number | null

  /**
   * Upsert a transcript binding by (runId, path). A new path for a run gets
   * ord = max(ord)+1 (0 for the first). A re-bind keeps id + ord + cursor and
   * refreshes confidence / sourceVersion / parserVersion. `cursor` is the
   * current ingestCursor (0 for a new binding) so the caller can seed its tail.
   */
  bindTranscript(
    runId: number,
    path: string,
    opts: { confidence: 'exact' | 'heuristic'; sourceVersion?: string; parserVersion: number },
  ): { transcriptId: number; ord: number; isNew: boolean; cursor: number }

  setTranscriptStatus(transcriptId: number, status: 'pending' | 'tailing' | 'complete' | 'failed'): void

  advanceCursor(transcriptId: number, cursor: number): void

  /** All transcripts with status='tailing' (worker restart resume points). */
  listResumableTranscripts(): ResumableTranscript[]

  /**
   * Append messages to a run in a single transaction. A duplicate (runId, idx)
   * throws (UNIQUE violation) and rolls back the whole batch.
   *
   * Throws FOREIGN KEY constraint failed if the run does not exist (e.g. after
   * deleteSlot — unlike clearAll, deleteSlot does NOT protect running runs).
   */
  appendMessages(runId: number, msgs: NewMessage[]): void

  /**
   * Append messages AND advance the transcript's ingest cursor in ONE
   * transaction. This is the tail loop's only write path: because rows and
   * cursor move together, a crash between batches can never duplicate or skip
   * messages on resume (the cursor always reflects exactly what was stored).
   * msgs may be empty (cursor-only advance past lines that produced no rows).
   */
  appendBatch(runId: number, transcriptId: number, msgs: NewMessage[], newCursor: number): void

  /** max(idx)+1 for the run, or 0 when it has no messages. */
  nextIdx(runId: number): number

  /**
   * Read a page of stored messages in stitched order.
   *  - anchor 'tail' + dir 'older': the LAST `limit` messages, ascending.
   *  - anchor pair + dir 'older': the `limit` messages strictly BEFORE the
   *    anchor pair (nearest first), returned ascending.
   *  - anchor pair + dir 'newer': the `limit` messages strictly AFTER the
   *    anchor pair, ascending.
   * Synthesized relaunch rows are inserted at run boundaries inside the page
   * and never count against `limit`.
   */
  readMessagesPage(
    scope: TranscriptScope,
    page: { anchor: 'tail' | { runId: number; idx: number }; dir: 'older' | 'newer'; limit: number },
  ): StitchedMessage[]

  /** Every message in the scope, stitched order, without content payloads. */
  turnSummary(scope: TranscriptScope): {
    runId: number
    idx: number
    role: string
    kind: string
    ts: number
    toolName: string | null
  }[]

  /**
   * FTS search over message content. Tokens are double-quoted (FTS5 phrase
   * rules) so operator words / syntax chars match literally and never throw.
   */
  searchMessages(query: string, limit?: number): TranscriptSearchHit[]

  /**
   * One row per configId; runs with configId NULL group per sessionId under
   * slotKey `orphan:<sessionId>`. Identity fields (configLabel, accountEmail)
   * come from the group's latest run.
   */
  listSlots(): SlotSummary[]

  /**
   * Delete every run in the scope; FK cascade removes messages + transcripts.
   * Note: unlike clearAll, deleteSlot does NOT protect running runs — a running
   * run's runId becomes invalid after this call (appendMessages will throw
   * FOREIGN KEY constraint failed if called with that runId).
   */
  deleteSlot(scope: TranscriptScope): { deletedRuns: number; deletedMessages: number }

  /** Delete all runs EXCEPT status='running' (their messages/transcripts kept). */
  clearAll(): { deletedRuns: number; deletedMessages: number }

  /**
   * Ingest snapshot for the latest open run for sessionId (falls back to the
   * latest run when none is open); null when the session has no runs.
   */
  ingestStats(
    sessionId: string,
  ): { transcripts: { path: string; status: string; ord: number }[]; messageCount: number } | null

  /**
   * Force a WAL checkpoint (TRUNCATE mode) so the WAL file is flushed back into
   * the main database file. Call after large deletes so that the reported file
   * size reflects the freed space (mirrors log-db.ts checkpoint()).
   */
  checkpoint(): void

  /**
   * One row per sessionId: lastActive = MAX(COALESCE(endedAt, startedAt)) across
   * all runs for the session; projectCwd comes from the session's LATEST run
   * (same no-bare-column-with-MAX discipline as listSlots). Ordered by lastActive
   * DESC. Used by the Memory page to show recent sessions for a project.
   */
  sessionActivity(): Array<{ sessionId: string; lastActive: number; projectCwd: string | null }>

  /**
   * Returns the configId of the latest run for sessionId, or null when the
   * session exists but has no configId. Returns null (not a wrapped object) when
   * no run for sessionId exists at all.
   */
  sessionConfig(sessionId: string): { configId: string | null } | null

  close(): void
}

// ---------------------------------------------------------------------------
// Schema DDL (v1)
// ---------------------------------------------------------------------------

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS runs (
  runId        INTEGER PRIMARY KEY,
  sessionId    TEXT NOT NULL,
  configId     TEXT,
  configLabel  TEXT NOT NULL,
  projectCwd   TEXT,
  accountEmail TEXT,
  profileId    TEXT,
  provider     TEXT NOT NULL,
  startedAt    INTEGER NOT NULL,
  endedAt      INTEGER,
  status       TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_runs_config_started ON runs(configId, startedAt);
CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(sessionId, startedAt);

CREATE TABLE IF NOT EXISTS transcripts (
  id            INTEGER PRIMARY KEY,
  runId         INTEGER NOT NULL REFERENCES runs(runId) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  sourceFormat  TEXT NOT NULL DEFAULT 'claude-jsonl',
  sourceVersion TEXT,
  parserVersion INTEGER NOT NULL,
  ingestCursor  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  confidence    TEXT NOT NULL DEFAULT 'exact',
  UNIQUE(runId, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY,
  runId    INTEGER NOT NULL REFERENCES runs(runId) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  role     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  content  TEXT NOT NULL,
  toolName TEXT,
  toolMeta TEXT,
  raw      TEXT,
  UNIQUE(runId, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', '1');
`

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PageRow {
  runId: number
  idx: number
  ts: number
  role: string
  kind: string
  content: string
  toolName: string | null
  toolMeta: string | null
  runStartedAt: number
}

interface StitchOptions {
  /**
   * If set, a relaunch divider is prepended BEFORE the first row, using the
   * provided ts value. Used when a page boundary coincides with a run boundary
   * (the first returned row belongs to a different run than the anchor).
   */
  leadingDivider?: { runId: number; ts: number }
  /**
   * If set, a relaunch divider is appended AFTER the last row, using the
   * provided runId and ts. Used when the last returned row belongs to a
   * different run than the anchor (i.e. the anchor's run starts after the page).
   */
  trailingDivider?: { runId: number; ts: number }
}

/** Insert synthesized relaunch rows at run boundaries inside an ASC page. */
function stitchRows(rows: PageRow[], opts: StitchOptions = {}): StitchedMessage[] {
  const out: StitchedMessage[] = []

  if (opts.leadingDivider && rows.length > 0) {
    out.push({
      runId: opts.leadingDivider.runId,
      idx: -1,
      ts: opts.leadingDivider.ts,
      role: 'system',
      kind: 'relaunch',
      content: '',
      toolName: null,
      toolMeta: null,
    })
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (i > 0 && rows[i - 1].runId !== row.runId) {
      out.push({
        runId: row.runId,
        idx: -1,
        ts: row.runStartedAt,
        role: 'system',
        kind: 'relaunch',
        content: '',
        toolName: null,
        toolMeta: null,
      })
    }
    out.push({
      runId: row.runId,
      idx: row.idx,
      ts: row.ts,
      role: row.role,
      kind: row.kind,
      content: row.content,
      toolName: row.toolName,
      toolMeta: row.toolMeta,
    })
  }

  if (opts.trailingDivider && rows.length > 0) {
    out.push({
      runId: opts.trailingDivider.runId,
      idx: -1,
      ts: opts.trailingDivider.ts,
      role: 'system',
      kind: 'relaunch',
      content: '',
      toolName: null,
      toolMeta: null,
    })
  }

  return out
}

/**
 * Sanitize an FTS5 query: tokenize on whitespace and double-quote each token
 * (embedded `"` → `""`) so operator words (AND/OR/NOT) and syntax characters
 * always match literally. Mirrors log-db.ts's search() sanitizer.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replace(/"/g, '""')}"`)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) a transcripts database at the given path.
 * Pass ':memory:' for an in-memory database (tests, ephemeral use).
 */
export function openTranscriptsDb(dbPath: string): TranscriptsDb {
  const sqlite = new Database(dbPath)

  // Apply PRAGMAs and create schema. exec() runs multiple semicolon-separated
  // statements so we can do this in one shot.
  sqlite.exec(DDL)

  // ---------------------------------------------------------------------------
  // Prepared statements (prepared once; reused across calls for performance)
  // ---------------------------------------------------------------------------

  // ---- runs ----
  const stmtInsertRun: Statement = sqlite.prepare(`
    INSERT INTO runs (sessionId, configId, configLabel, projectCwd, accountEmail, profileId, provider, startedAt)
    VALUES (@sessionId, @configId, @configLabel, @projectCwd, @accountEmail, @profileId, @provider, @startedAt)
  `)

  // "Latest open run" = max(startedAt) tie-broken by runId among status='running'.
  const latestOpenRunSubquery = `(
    SELECT runId FROM runs
    WHERE sessionId = @sessionId AND status = 'running'
    ORDER BY startedAt DESC, runId DESC LIMIT 1
  )`

  const stmtCloseRun: Statement = sqlite.prepare(`
    UPDATE runs SET endedAt = @endedAt, status = @status
    WHERE runId = ${latestOpenRunSubquery}
  `)

  const stmtSetRunAccount: Statement = sqlite.prepare(`
    UPDATE runs SET accountEmail = @accountEmail
    WHERE runId = ${latestOpenRunSubquery}
  `)

  const stmtRenameRun: Statement = sqlite.prepare(`
    UPDATE runs SET configLabel = @configLabel
    WHERE runId = ${latestOpenRunSubquery}
  `)

  const stmtGetRunStartedAt: Statement = sqlite.prepare(`SELECT startedAt FROM runs WHERE runId = ?`)

  // Single-statement dangling-run closure: endedAt = last message ts, falling
  // back to startedAt for runs that never produced a message.
  const stmtCloseDangling: Statement = sqlite.prepare(`
    UPDATE runs SET status = 'crashed',
      endedAt = COALESCE((SELECT MAX(ts) FROM messages WHERE messages.runId = runs.runId), startedAt)
    WHERE status = 'running'
  `)

  // Re-open a dangling run that turned out to have a live (resumable) transcript.
  const stmtReopenRun: Statement = sqlite.prepare(
    `UPDATE runs SET status = 'running', endedAt = NULL WHERE runId = ?`,
  )

  // Latest open run id for a session (run-start uses this to retire a prior
  // un-closed run; identical ordering to latestOpenRunSubquery).
  const stmtGetOpenRunId: Statement = sqlite.prepare(`
    SELECT runId FROM runs WHERE sessionId = ? AND status = 'running'
    ORDER BY startedAt DESC, runId DESC LIMIT 1
  `)
  // All currently open run ids (clean-shutdown finalization).
  const stmtListOpenRunIds: Statement = sqlite.prepare(`SELECT runId FROM runs WHERE status = 'running'`)
  const stmtCloseRunById: Statement = sqlite.prepare(
    `UPDATE runs SET endedAt = @endedAt, status = @status WHERE runId = @runId`,
  )

  const stmtGetRunScope: Statement = sqlite.prepare(`SELECT sessionId, configId FROM runs WHERE runId = ?`)

  const stmtLastMessageTs: Statement = sqlite.prepare(`SELECT MAX(ts) AS t FROM messages WHERE runId = ?`)

  // ---- transcripts ----
  const stmtGetTranscriptByRunPath: Statement = sqlite.prepare(
    `SELECT id, ord FROM transcripts WHERE runId = ? AND path = ?`,
  )
  const stmtRebindTranscript: Statement = sqlite.prepare(`
    UPDATE transcripts
    SET confidence = @confidence, sourceVersion = @sourceVersion, parserVersion = @parserVersion
    WHERE id = @id
  `)
  const stmtNextOrd: Statement = sqlite.prepare(
    `SELECT COALESCE(MAX(ord) + 1, 0) AS nextOrd FROM transcripts WHERE runId = ?`,
  )
  const stmtInsertTranscript: Statement = sqlite.prepare(`
    INSERT INTO transcripts (runId, path, ord, sourceVersion, parserVersion, confidence)
    VALUES (@runId, @path, @ord, @sourceVersion, @parserVersion, @confidence)
  `)
  const stmtSetTranscriptStatus: Statement = sqlite.prepare(
    `UPDATE transcripts SET status = @status WHERE id = @id`,
  )
  const stmtAdvanceCursor: Statement = sqlite.prepare(
    `UPDATE transcripts SET ingestCursor = @cursor WHERE id = @id`,
  )
  const stmtListResumable: Statement = sqlite.prepare(`
    SELECT id AS transcriptId, runId, path, ingestCursor, parserVersion
    FROM transcripts WHERE status = 'tailing' ORDER BY id
  `)

  const stmtGetCursor: Statement = sqlite.prepare(`SELECT ingestCursor FROM transcripts WHERE id = ?`)

  const runBindTranscript = sqlite.transaction(
    (
      runId: number,
      path: string,
      opts: { confidence: 'exact' | 'heuristic'; sourceVersion?: string; parserVersion: number },
    ): { transcriptId: number; ord: number; isNew: boolean; cursor: number } => {
      const existing = stmtGetTranscriptByRunPath.get(runId, path) as { id: number; ord: number } | undefined
      if (existing) {
        stmtRebindTranscript.run({
          id: existing.id,
          confidence: opts.confidence,
          sourceVersion: opts.sourceVersion ?? null,
          parserVersion: opts.parserVersion,
        })
        const { ingestCursor } = stmtGetCursor.get(existing.id) as { ingestCursor: number }
        return { transcriptId: existing.id, ord: existing.ord, isNew: false, cursor: ingestCursor }
      }
      const { nextOrd } = stmtNextOrd.get(runId) as { nextOrd: number }
      const info = stmtInsertTranscript.run({
        runId,
        path,
        ord: nextOrd,
        sourceVersion: opts.sourceVersion ?? null,
        parserVersion: opts.parserVersion,
        confidence: opts.confidence,
      })
      return { transcriptId: Number(info.lastInsertRowid), ord: nextOrd, isNew: true, cursor: 0 }
    },
  )

  // ---- messages ----
  const stmtInsertMessage: Statement = sqlite.prepare(`
    INSERT INTO messages (runId, idx, ts, role, kind, content, toolName, toolMeta, raw)
    VALUES (@runId, @idx, @ts, @role, @kind, @content, @toolName, @toolMeta, @raw)
  `)

  const insertMessageRow = (runId: number, m: NewMessage): void => {
    stmtInsertMessage.run({
      runId,
      idx: m.idx,
      ts: m.ts,
      role: m.role,
      kind: m.kind,
      content: m.content,
      toolName: m.toolName ?? null,
      toolMeta: m.toolMeta ?? null,
      raw: m.raw ?? null,
    })
  }

  const runAppendMessages = sqlite.transaction((runId: number, msgs: NewMessage[]) => {
    for (const m of msgs) insertMessageRow(runId, m)
  })

  // The tail loop's combined write: rows + cursor in ONE transaction so a crash
  // window between "messages stored" and "cursor advanced" cannot exist.
  const runAppendBatchWithCursor = sqlite.transaction(
    (runId: number, transcriptId: number, msgs: NewMessage[], newCursor: number) => {
      for (const m of msgs) insertMessageRow(runId, m)
      stmtAdvanceCursor.run({ id: transcriptId, cursor: newCursor })
    },
  )

  const stmtNextIdx: Statement = sqlite.prepare(
    `SELECT COALESCE(MAX(idx) + 1, 0) AS nextIdx FROM messages WHERE runId = ?`,
  )

  // ---- paging (stitched order = runs by (startedAt, runId), messages by idx) ----
  const pageSelect = `
    SELECT m.runId AS runId, m.idx AS idx, m.ts AS ts, m.role AS role, m.kind AS kind,
           m.content AS content, m.toolName AS toolName, m.toolMeta AS toolMeta,
           r.startedAt AS runStartedAt
    FROM messages m JOIN runs r ON r.runId = m.runId
  `
  const orderAsc = `ORDER BY r.startedAt ASC, r.runId ASC, m.idx ASC`
  const orderDesc = `ORDER BY r.startedAt DESC, r.runId DESC, m.idx DESC`
  // Row-value comparison against the stitched-order key of the anchor pair.
  const beforeAnchor = `(r.startedAt, r.runId, m.idx) < (@aStartedAt, @aRunId, @aIdx)`
  const afterAnchor = `(r.startedAt, r.runId, m.idx) > (@aStartedAt, @aRunId, @aIdx)`

  const makePageStmts = (scopeCol: 'configId' | 'sessionId') => ({
    // tail: last @limit rows, fetched DESC then reversed to ASC by the caller
    tail: sqlite.prepare(`${pageSelect} WHERE r.${scopeCol} = @scope ${orderDesc} LIMIT @limit`),
    // older: nearest @limit rows strictly before the anchor, DESC then reversed
    older: sqlite.prepare(
      `${pageSelect} WHERE r.${scopeCol} = @scope AND ${beforeAnchor} ${orderDesc} LIMIT @limit`,
    ),
    // newer: first @limit rows strictly after the anchor, already ASC
    newer: sqlite.prepare(
      `${pageSelect} WHERE r.${scopeCol} = @scope AND ${afterAnchor} ${orderAsc} LIMIT @limit`,
    ),
  })
  const stmtPage = {
    configId: makePageStmts('configId'),
    sessionId: makePageStmts('sessionId'),
  }

  const makeTurnSummaryStmt = (scopeCol: 'configId' | 'sessionId'): Statement =>
    sqlite.prepare(`
      SELECT m.runId AS runId, m.idx AS idx, m.role AS role, m.kind AS kind, m.ts AS ts,
             m.toolName AS toolName
      FROM messages m JOIN runs r ON r.runId = m.runId
      WHERE r.${scopeCol} = ? ${orderAsc}
    `)
  const stmtTurnSummary = {
    configId: makeTurnSummaryStmt('configId'),
    sessionId: makeTurnSummaryStmt('sessionId'),
  }

  // ---- search ----
  // snippet() uses FTS column index 0 (content), marks up to 16 tokens.
  const stmtSearchMessages: Statement = sqlite.prepare(`
    SELECT m.runId AS runId, m.idx AS idx, r.configId AS configId, r.sessionId AS sessionId,
           snippet(messages_fts, 0, '[', ']', '...', 16) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN runs r ON r.runId = m.runId
    WHERE messages_fts MATCH @query
    ORDER BY rank
    LIMIT @limit
  `)

  // ---- slots ----
  // One row per configId; configId-null runs group per sessionId under
  // 'orphan:<sessionId>'. Identity fields come from the group's latest run
  // (resolved explicitly — no reliance on SQLite's bare-column-with-MAX quirk).
  const stmtListSlots: Statement = sqlite.prepare(`
    WITH keyed AS (
      SELECT runId, sessionId, configId, startedAt, endedAt,
             CASE WHEN configId IS NULL THEN 'orphan:' || sessionId ELSE configId END AS slotKey
      FROM runs
    ),
    grouped AS (
      SELECT slotKey,
             MAX(COALESCE(endedAt, startedAt)) AS lastActive,
             COUNT(*) AS runCount
      FROM keyed
      GROUP BY slotKey
    )
    SELECT g.slotKey AS slotKey,
           lr.configId AS configId,
           lr.configLabel AS configLabel,
           lr.accountEmail AS accountEmail,
           g.lastActive AS lastActive,
           g.runCount AS runCount,
           (SELECT COUNT(*) FROM messages m JOIN keyed k ON k.runId = m.runId
            WHERE k.slotKey = g.slotKey) AS messageCount
    FROM grouped g
    JOIN runs lr ON lr.runId = (
      SELECT runId FROM keyed WHERE slotKey = g.slotKey ORDER BY startedAt DESC, runId DESC LIMIT 1
    )
    ORDER BY g.lastActive DESC
  `)

  // ---- session activity (Memory page: recent sessions per project) ----
  // Grouped per sessionId; lastActive mirrors listSlots' MAX(COALESCE(endedAt,
  // startedAt)); projectCwd comes from the session's LATEST run (explicit
  // subquery — same no-bare-column-with-MAX discipline as listSlots).
  const stmtSessionActivity: Statement = sqlite.prepare(`
    WITH grouped AS (
      SELECT sessionId, MAX(COALESCE(endedAt, startedAt)) AS lastActive
      FROM runs GROUP BY sessionId
    )
    SELECT g.sessionId AS sessionId, g.lastActive AS lastActive, lr.projectCwd AS projectCwd
    FROM grouped g
    JOIN runs lr ON lr.runId = (
      SELECT runId FROM runs WHERE sessionId = g.sessionId ORDER BY startedAt DESC, runId DESC LIMIT 1
    )
    ORDER BY g.lastActive DESC
  `)
  const stmtSessionConfig: Statement = sqlite.prepare(
    `SELECT configId FROM runs WHERE sessionId = ? ORDER BY startedAt DESC, runId DESC LIMIT 1`,
  )

  // ---- deletes ----
  const stmtCountMessagesByConfig: Statement = sqlite.prepare(
    `SELECT COUNT(*) AS c FROM messages m JOIN runs r ON r.runId = m.runId WHERE r.configId = ?`,
  )
  const stmtDeleteRunsByConfig: Statement = sqlite.prepare(`DELETE FROM runs WHERE configId = ?`)
  const stmtCountMessagesBySession: Statement = sqlite.prepare(
    `SELECT COUNT(*) AS c FROM messages m JOIN runs r ON r.runId = m.runId WHERE r.sessionId = ?`,
  )
  const stmtDeleteRunsBySession: Statement = sqlite.prepare(`DELETE FROM runs WHERE sessionId = ?`)

  // Count first (inside the txn, so it's consistent), then delete — the FK
  // CASCADE + messages_ad trigger clean up messages, transcripts and FTS rows.
  const runDeleteSlot = sqlite.transaction(
    (scope: TranscriptScope): { deletedRuns: number; deletedMessages: number } => {
      if ('configId' in scope) {
        const row = stmtCountMessagesByConfig.get(scope.configId) as { c: number }
        const info = stmtDeleteRunsByConfig.run(scope.configId)
        return { deletedRuns: info.changes, deletedMessages: row.c }
      }
      const row = stmtCountMessagesBySession.get(scope.sessionId) as { c: number }
      const info = stmtDeleteRunsBySession.run(scope.sessionId)
      return { deletedRuns: info.changes, deletedMessages: row.c }
    },
  )

  const stmtCountNonRunningMessages: Statement = sqlite.prepare(
    `SELECT COUNT(*) AS c FROM messages m JOIN runs r ON r.runId = m.runId WHERE r.status != 'running'`,
  )
  const stmtDeleteNonRunningRuns: Statement = sqlite.prepare(`DELETE FROM runs WHERE status != 'running'`)

  const runClearAll = sqlite.transaction((): { deletedRuns: number; deletedMessages: number } => {
    const row = stmtCountNonRunningMessages.get() as { c: number }
    const info = stmtDeleteNonRunningRuns.run()
    return { deletedRuns: info.changes, deletedMessages: row.c }
  })

  // ---- ingest stats ----
  const stmtLatestOpenRun: Statement = sqlite.prepare(`
    SELECT runId FROM runs WHERE sessionId = ? AND status = 'running'
    ORDER BY startedAt DESC, runId DESC LIMIT 1
  `)
  const stmtLatestRun: Statement = sqlite.prepare(`
    SELECT runId FROM runs WHERE sessionId = ?
    ORDER BY startedAt DESC, runId DESC LIMIT 1
  `)
  const stmtTranscriptsForRun: Statement = sqlite.prepare(
    `SELECT path, status, ord FROM transcripts WHERE runId = ? ORDER BY ord`,
  )
  const stmtCountMessagesForRun: Statement = sqlite.prepare(
    `SELECT COUNT(*) AS c FROM messages WHERE runId = ?`,
  )

  // ---------------------------------------------------------------------------
  // TranscriptsDb implementation
  // ---------------------------------------------------------------------------

  return {
    insertRun(meta) {
      const info = stmtInsertRun.run({
        sessionId: meta.sessionId,
        configId: meta.configId ?? null,
        configLabel: meta.configLabel,
        projectCwd: meta.projectCwd ?? null,
        accountEmail: meta.accountEmail ?? null,
        profileId: meta.profileId ?? null,
        provider: meta.provider,
        startedAt: meta.startedAt,
      })
      return Number(info.lastInsertRowid)
    },

    closeRun(sessionId, endedAt, status) {
      stmtCloseRun.run({ sessionId, endedAt, status })
    },

    getOpenRunId(sessionId) {
      const row = stmtGetOpenRunId.get(sessionId) as { runId: number } | undefined
      return row ? row.runId : null
    },

    closeAllOpenRuns(endedAt, status) {
      const rows = stmtListOpenRunIds.all() as { runId: number }[]
      for (const r of rows) stmtCloseRunById.run({ runId: r.runId, endedAt, status })
      return rows.map((r) => r.runId)
    },

    setRunAccount(sessionId, accountEmail) {
      stmtSetRunAccount.run({ sessionId, accountEmail })
    },

    renameRun(sessionId, configLabel) {
      stmtRenameRun.run({ sessionId, configLabel })
    },

    closeDanglingRuns() {
      return stmtCloseDangling.run().changes
    },

    reopenRun(runId) {
      stmtReopenRun.run(runId)
    },

    getRunScope(runId) {
      const row = stmtGetRunScope.get(runId) as { sessionId: string; configId: string | null } | undefined
      return row ?? null
    },

    lastMessageTs(runId) {
      const row = stmtLastMessageTs.get(runId) as { t: number | null }
      return row.t
    },

    bindTranscript(runId, path, opts) {
      return runBindTranscript(runId, path, opts)
    },

    setTranscriptStatus(transcriptId, status) {
      stmtSetTranscriptStatus.run({ id: transcriptId, status })
    },

    advanceCursor(transcriptId, cursor) {
      stmtAdvanceCursor.run({ id: transcriptId, cursor })
    },

    listResumableTranscripts() {
      return stmtListResumable.all() as ResumableTranscript[]
    },

    appendMessages(runId, msgs) {
      if (msgs.length === 0) return
      runAppendMessages(runId, msgs)
    },

    appendBatch(runId, transcriptId, msgs, newCursor) {
      runAppendBatchWithCursor(runId, transcriptId, msgs, newCursor)
    },

    nextIdx(runId) {
      const row = stmtNextIdx.get(runId) as { nextIdx: number }
      return row.nextIdx
    },

    readMessagesPage(scope, page) {
      if (page.limit <= 0) return []
      const scopeCol = 'configId' in scope ? ('configId' as const) : ('sessionId' as const)
      const scopeValue = 'configId' in scope ? scope.configId : scope.sessionId
      const stmts = stmtPage[scopeCol]

      let rows: PageRow[]
      if (page.anchor === 'tail') {
        // Nothing exists after the tail.
        if (page.dir === 'newer') return []
        rows = stmts.tail.all({ scope: scopeValue, limit: page.limit }) as PageRow[]
        rows.reverse()
        return stitchRows(rows)
      }

      const anchorRun = stmtGetRunStartedAt.get(page.anchor.runId) as { startedAt: number } | undefined
      if (!anchorRun) return []
      const params = {
        scope: scopeValue,
        aStartedAt: anchorRun.startedAt,
        aRunId: page.anchor.runId,
        aIdx: page.anchor.idx,
        limit: page.limit,
      }

      const stitchOpts: StitchOptions = {}

      if (page.dir === 'older') {
        rows = stmts.older.all(params) as PageRow[]
        rows.reverse()
        // Page-seam: if the last row belongs to a DIFFERENT run than the anchor
        // and the anchor is not itself a divider (idx === -1), synthesize a
        // trailing divider so consumers concatenating pages see the boundary.
        if (rows.length > 0 && rows[rows.length - 1].runId !== page.anchor.runId && page.anchor.idx !== -1) {
          stitchOpts.trailingDivider = { runId: page.anchor.runId, ts: anchorRun.startedAt }
        }
      } else {
        rows = stmts.newer.all(params) as PageRow[]
        // Page-seam: if the first row belongs to a DIFFERENT run than the anchor,
        // synthesize a leading divider before the first row.
        if (rows.length > 0 && rows[0].runId !== page.anchor.runId) {
          stitchOpts.leadingDivider = { runId: rows[0].runId, ts: rows[0].runStartedAt }
        }
      }

      return stitchRows(rows, stitchOpts)
    },

    turnSummary(scope) {
      const scopeCol = 'configId' in scope ? ('configId' as const) : ('sessionId' as const)
      const scopeValue = 'configId' in scope ? scope.configId : scope.sessionId
      return stmtTurnSummary[scopeCol].all(scopeValue) as {
        runId: number
        idx: number
        role: string
        kind: string
        ts: number
        toolName: string | null
      }[]
    },

    searchMessages(query, limit = 50) {
      const safeQuery = sanitizeFtsQuery(query)
      if (!safeQuery) return []
      try {
        return stmtSearchMessages.all({ query: safeQuery, limit }) as TranscriptSearchHit[]
      } catch {
        // If FTS still chokes on a malformed query, return empty rather than throwing
        return []
      }
    },

    listSlots() {
      return stmtListSlots.all() as SlotSummary[]
    },

    deleteSlot(scope) {
      return runDeleteSlot(scope)
    },

    clearAll() {
      return runClearAll()
    },

    ingestStats(sessionId) {
      const open = stmtLatestOpenRun.get(sessionId) as { runId: number } | undefined
      const run = open ?? (stmtLatestRun.get(sessionId) as { runId: number } | undefined)
      if (!run) return null
      const transcripts = stmtTranscriptsForRun.all(run.runId) as {
        path: string
        status: string
        ord: number
      }[]
      const { c } = stmtCountMessagesForRun.get(run.runId) as { c: number }
      return { transcripts, messageCount: c }
    },

    checkpoint() {
      sqlite.pragma('wal_checkpoint(TRUNCATE)')
    },

    sessionActivity() {
      return stmtSessionActivity.all() as Array<{ sessionId: string; lastActive: number; projectCwd: string | null }>
    },

    sessionConfig(sessionId: string) {
      const row = stmtSessionConfig.get(sessionId) as { configId: string | null } | undefined
      return row ?? null
    },

    close() {
      sqlite.close()
    },
  }
}
