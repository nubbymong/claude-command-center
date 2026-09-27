import Database from 'better-sqlite3'
import type { TkEvent, TkPricing, TkProvider, TkSummary, TkKpis, TkSummaryFilter, TkSessionsQuery, TkSessionsPage, TkSessionDetail, TkAccountPresent } from './tk-types'
import { tkAccountKeyOk, tkClaudeAccountKeyOk, TK_ACCOUNT_NOT_RECORDED } from './tk-types'

function dayOf(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function bucketOf(ts: number): number {
  const d = new Date(ts)
  return d.getDay() * 24 + d.getHours()
}

function pricingCte(pricing: Record<string, TkPricing>): { cte: string; binds: Record<string, unknown> } {
  const entries = Object.entries(pricing)
  if (entries.length === 0) return { cte: `pricing(pm,pin,pout,pcr,pcw) AS (SELECT NULL,0,0,0,0 WHERE 0)`, binds: {} }
  const rows: string[] = []
  const binds: Record<string, unknown> = {}
  entries.forEach(([model, p], i) => {
    rows.push(`(@pm${i},@pin${i},@pout${i},@pcr${i},@pcw${i})`)
    binds[`pm${i}`] = model; binds[`pin${i}`] = p.input; binds[`pout${i}`] = p.output
    binds[`pcr${i}`] = p.cacheRead; binds[`pcw${i}`] = p.cacheWrite
  })
  return { cte: `pricing(pm,pin,pout,pcr,pcw) AS (VALUES ${rows.join(',')})`, binds }
}
/** The daily rollup (schema v2, usage track MP9): one row per day, model,
 *  provider, config and account. `configId` and `accountKey` are '' when
 *  not recorded, never NULL: SQLite upserts never match NULLs. */
const dailyTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  day            TEXT NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  configId       TEXT,
  accountKey     TEXT NOT NULL DEFAULT '',
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  msgCount       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, provider, configId, accountKey)
);`
/** The hour-of-week rollup (schema v2): by provider and account too. */
const heatmapTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  bucket         INTEGER NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT '',
  configId       TEXT,
  accountKey     TEXT NOT NULL DEFAULT '',
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, model, provider, configId, accountKey)
);`
const dailyUpsert = (name: string) => `INSERT INTO ${name}(day,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@day,@model,@priceModel,@provider,@configId,@accountKey,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(day,model,provider,configId,accountKey) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1`
const heatmapUpsert = (name: string) => `INSERT INTO ${name}(bucket,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok)
    VALUES(@bucket,@model,@priceModel,@provider,@configId,@accountKey,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)
    ON CONFLICT(bucket,model,provider,configId,accountKey) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok`
/** The v2 rollups' own tables (MP9 round 1, Q-1): new names, so the v1
 *  tables below stay exactly as a build from before MP9 knows them. */
const DAILY = 'tk_daily2'
const HEAT = 'tk_heatmap2'
/** The rollups of schema v1, exactly as a build from before MP9 creates and
 *  writes them, and still written beside the v2 ones: such a build opening
 *  this database after a downgrade prepares its own statements against its
 *  own tables and keeps working, with totals that include what this build
 *  stored. */
const V1_DAILY_DDL = `CREATE TABLE IF NOT EXISTS tk_daily (
  day            TEXT NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  configId       TEXT,
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  msgCount       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, provider, configId)
);`
const V1_HEATMAP_DDL = `CREATE TABLE IF NOT EXISTS tk_heatmap (
  bucket         INTEGER NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  configId       TEXT,
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, model, configId)
);`
const V1_DAILY_UPSERT = `INSERT INTO tk_daily(day,model,priceModel,provider,configId,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@day,@model,@priceModel,@provider,@configId,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(day,model,provider,configId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1`
const V1_HEATMAP_UPSERT = `INSERT INTO tk_heatmap(bucket,model,priceModel,configId,inTok,outTok,cacheReadTok,cacheCreateTok)
    VALUES(@bucket,@model,@priceModel,@configId,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)
    ON CONFLICT(bucket,model,configId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok`
/** Rows the rollup rebuild replays per step (usage track MP9). */
export const TK_REBUILD_PAGE = 5000

/** A row's cost at its model's price, or NULL when its model has no price
 *  (usage track MP11): sums then cover the priced models only, and a model
 *  or session with no price reads as none, never as $0. */
const COST = (a: string) => `(CASE WHEN p.pm IS NULL THEN NULL ELSE (${a}.inTok*p.pin+${a}.outTok*p.pout+${a}.cacheReadTok*p.pcr+${a}.cacheCreateTok*p.pcw)/1000000.0 END)`
/** The providers a summary splits its figures by (MP11). */
const PROVIDERS: readonly TkProvider[] = ['claude', 'codex']

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO tk_meta(key, value) VALUES ('schemaVersion', '2');

CREATE TABLE IF NOT EXISTS tk_files (
  path           TEXT PRIMARY KEY,
  size           INTEGER NOT NULL,
  mtime          INTEGER NOT NULL,
  lastOffset     INTEGER NOT NULL DEFAULT 0,
  lastIngestedAt INTEGER NOT NULL DEFAULT 0,
  scannedTo      INTEGER NOT NULL DEFAULT 0,
  codexSessionId TEXT    NOT NULL DEFAULT '',
  codexModel     TEXT    NOT NULL DEFAULT '',
  codexCwd       TEXT    NOT NULL DEFAULT '',
  codexTurns     INTEGER NOT NULL DEFAULT 0,
  accountKey     TEXT    NOT NULL DEFAULT '',
  accountReread  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tk_events (
  dedupKey       TEXT PRIMARY KEY,
  sessionId      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  day            TEXT NOT NULL,
  configId       TEXT,
  projectDir     TEXT NOT NULL DEFAULT '',
  inTok          INTEGER NOT NULL,
  outTok         INTEGER NOT NULL,
  cacheReadTok   INTEGER NOT NULL,
  cacheCreateTok INTEGER NOT NULL,
  accountKey     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_session ON tk_events(sessionId);
CREATE INDEX IF NOT EXISTS idx_events_day ON tk_events(day);

CREATE TABLE IF NOT EXISTS tk_sessions (
  sessionId      TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  configId       TEXT,
  projectDir     TEXT NOT NULL DEFAULT '',
  firstTs        INTEGER NOT NULL,
  lastTs         INTEGER NOT NULL,
  lastModel      TEXT NOT NULL,
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  msgCount       INTEGER NOT NULL DEFAULT 0,
  accountKey     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_lastts ON tk_sessions(lastTs DESC, sessionId DESC);

-- Usage track MP10: the account each Claude session runs under, from now on:
-- the latest attribution applies to what is stored after it (a session
-- resumed under another account moves on to it). A table of its own, not a
-- column: a session is attributed before or after its rows are ingested,
-- and an earlier build opening the file ignores it.
CREATE TABLE IF NOT EXISTS tk_session_accounts (
  sessionId  TEXT PRIMARY KEY,
  accountKey TEXT NOT NULL,
  setAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_config ON tk_sessions(configId);

CREATE TABLE IF NOT EXISTS tk_session_models (
  sessionId      TEXT NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  msgCount       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionId, model)
);

${V1_DAILY_DDL}

${V1_HEATMAP_DDL}

CREATE TABLE IF NOT EXISTS tk_configs (
  configId        TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  workingDirectory TEXT NOT NULL DEFAULT ''
);
`

export interface TkFileCursor {
  path: string
  size: number
  mtime: number
  /** Where PARSING resumes: the end of the last complete line consumed. */
  lastOffset: number
  lastIngestedAt: number
  /** How far the file has been LOOKED AT, which runs ahead of `lastOffset`
   *  whenever the tail is a partial line. "Have we seen all of this file yet"
   *  is `scannedTo >= size` — asking that of `lastOffset` is wrong for any
   *  file whose last line has no newline, and re-reading such a tail on every
   *  sweep is how a healthy file turns into permanent background I/O. */
  scannedTo?: number
  /** Codex only: the rollout's identity, carried across ticks. A resumed tick
   *  used to re-derive this from a bounded read of the file's head, which
   *  silently yielded ZERO events for the whole tick whenever the head did not
   *  hold it — the parser returns nothing without a session id. */
  codexSessionId?: string
  /** Codex only: last model seen. The model is announced by `turn_context`
   *  lines near the top of a rollout, so a tick starting past them priced its
   *  turns as 'unknown' — which matches no pricing row and costs $0. */
  codexModel?: string
  codexCwd?: string
  /** Codex only: token_count lines already ingested FROM THIS FILE — the base
   *  for the dedup ordinal. Per-FILE, and written in the same transaction as
   *  the rows themselves, so it can never drift from what is stored. Deriving
   *  it from a per-session row count instead let a replayed byte range mint
   *  fresh keys for turns already stored, double-counting real money. */
  codexTurns?: number
  /** Whose file (usage track MP9): the account of the folder it lives in. */
  accountKey?: string
  /** Read-only here (the DB keeps it): 1 while the file waits to be re-read
   *  for the one-off account attribution, 2 once it has been. */
  accountReread?: number
}

/** One step of the rollup rebuild (usage track MP9). */
export interface TkRebuildStep { done: number; total: number; finished: boolean }

export interface TkDb {
  raw: Database.Database
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  getFileCursor(path: string): TkFileCursor | null
  setFileCursor(c: TkFileCursor): void
  /** Insert events AND advance that file's cursor in ONE transaction. Two
   *  separate transactions leave a window where the rows are committed and the
   *  cursor is not; the next tick then re-reads the same bytes against a moved
   *  ordinal base and inserts the same turns under fresh dedup keys, inflating
   *  spend permanently. The supervisor hard-kills the worker on app quit, so
   *  that window is hit in normal use, not only in a crash. */
  insertEventsWithCursor(events: TkEvent[], cursor: TkFileCursor): number
  eventCount(): number
  insertEvents(events: TkEvent[]): number
  upsertConfigs(configs: Array<{ configId: string; label: string; workingDirectory: string }>): void
  getSessionCwd(sessionId: string): string | null
  querySummary(pricing: Record<string, TkPricing>, filter?: TkSummaryFilter, nowMs?: number): TkSummary
  querySessions(pricing: Record<string, TkPricing>, query?: TkSessionsQuery): TkSessionsPage
  querySessionDetail(pricing: Record<string, TkPricing>, sessionId: string): TkSessionDetail | null
  /** Usage track MP9: every provider and account the stored usage has. */
  queryAccounts(): TkAccountPresent[]
  /** Usage track MP10: record the account a Claude session runs under now:
   *  rows stored after it take it (another account than before applies from
   *  then on; rows already attributed keep theirs; the same again records
   *  nothing). In the same transaction the session's rows stored with no
   *  account yet are attributed: its events and session row, and the daily
   *  and hourly rollups moved from "not recorded" to the account. While the
   *  rollups are dirty or being rebuilt they are left dirty for another
   *  rebuild instead. `stamped` counts the events attributed. */
  setSessionAccount(sessionId: string, accountKey: string, now: number): { recorded: boolean; stamped: number }
  /** Usage track MP9: the one-off Codex re-read that stamps stored history
   *  with its accounts is still due (set when a schema v1 database is
   *  opened). */
  accountRereadPending(): boolean
  /** The re-read is done: what it could reach has been re-read. */
  finishAccountReread(): void
  /** The rollups no longer match the stored events' accounts (a v1 database's
   *  hourly rollup had no provider; a stored row was stamped since). */
  rollupsDirty(): boolean
  /** Start (again) rebuilding the daily and hourly rollups from the stored
   *  events, into shadow tables; queries keep reading the live ones. */
  beginRollupRebuild(): void
  /** Replay up to `maxRows` more events into the shadow tables. The step
   *  that reaches the end swaps them in, in the same transaction. */
  stepRollupRebuild(maxRows?: number): TkRebuildStep
  checkpoint(): void
  close(): void
}

export function openTkDb(dbPath: string): TkDb {
  const sqlite = new Database(dbPath)
  sqlite.exec(DDL)

  // `CREATE TABLE IF NOT EXISTS` leaves an existing tk_files alone, so the
  // per-file streaming state added after the first release has to be grafted
  // on. Every column is NOT NULL DEFAULT, so an existing row migrates to the
  // "nothing known yet" state and simply re-derives on its next tick.
  {
    const have = new Set((sqlite.pragma('table_info(tk_files)') as Array<{ name: string }>).map((c) => c.name))
    const added: Array<[string, string]> = [
      ['scannedTo', 'INTEGER NOT NULL DEFAULT 0'],
      ['codexSessionId', "TEXT NOT NULL DEFAULT ''"],
      ['codexModel', "TEXT NOT NULL DEFAULT ''"],
      ['codexCwd', "TEXT NOT NULL DEFAULT ''"],
      ['codexTurns', 'INTEGER NOT NULL DEFAULT 0'],
      // Usage track MP9 (schema v2): whose file, and the account re-read.
      ['accountKey', "TEXT NOT NULL DEFAULT ''"],
      ['accountReread', 'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [col, ddl] of added) if (!have.has(col)) sqlite.exec(`ALTER TABLE tk_files ADD COLUMN ${col} ${ddl}`)
    // A pre-migration row has scannedTo=0 but was in fact scanned to
    // lastOffset; leaving it at 0 would report every known file as unscanned
    // and hold the index at "not complete" forever.
    if (!have.has('scannedTo')) sqlite.exec('UPDATE tk_files SET scannedTo = lastOffset WHERE scannedTo = 0')
    // A pre-migration Codex cursor cannot say how many turns of ITS file are
    // already stored — `codexTurns` arrives as 0 while `lastOffset` is deep
    // into the file. Numbering the next turns from zero would collide with the
    // rows already there, and `INSERT OR IGNORE` would drop them: a silent,
    // permanent UNDERCOUNT, once, for every existing user. Rewind those cursors
    // instead. A Codex file re-read from the top numbers its turns exactly as
    // they were numbered before, so the stored rows dedup against themselves
    // and nothing is lost or duplicated. Costs one re-read per rollout, once.
    if (!have.has('codexTurns')) sqlite.exec("UPDATE tk_files SET lastOffset = 0, scannedTo = 0 WHERE path LIKE '%rollout-%'")
  }

  // Usage track MP9: schema v2 (whose usage each row is). One transaction, in
  // the worker, at open; it touches only the small rollup tables and adds
  // columns, so it is quick however large the database:
  //  - tk_events, tk_sessions and tk_files gain `accountKey` ('' = not
  //    recorded); tk_files gains `accountReread`;
  //  - the rollups by account are NEW tables (MP9 round 1, Q-1): tk_daily2,
  //    keyed by account too, and tk_heatmap2, by provider and account too.
  //    The v1 tk_daily and tk_heatmap stay exactly as they were and are
  //    still written, so a build from before MP9 opening this file after a
  //    downgrade keeps working on its own tables. The new tables start as
  //    copies of the v1 ones ('' for what was not recorded; the hourly
  //    rollup never recorded its provider) and are rebuilt from the stored
  //    events later, worker-side and in steps (beginRollupRebuild), once
  //    the Codex re-read below has finished;
  //  - a database an earlier build of this work upgraded in place (its
  //    tk_daily and tk_heatmap carry the account) has those tables moved to
  //    the new names and its v1 tables derived back from them;
  //  - coming from v1, Codex cursors are rewound (the #307 mechanism) so each rollout still on
  //    disk is re-read and its stored rows stamped with the account of the
  //    folder it lives in. Unlike #307 no row is deleted: a re-read turn
  //    carries the same dedup key, so it stamps the stored row instead of
  //    being inserted again, the totals never dip, and the history of a
  //    rollout since pruned stays, not recorded. Claude history is not
  //    re-read (its attribution starts from now on, MP10).
  const colsOf = (t: string) => new Set((sqlite.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name))
  const tableExists = (t: string) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
  const maxEventRowid = () => Number((sqlite.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM tk_events').get() as { m: number | bigint }).m)
  const setMetaAtOpen = (key: string, value: string) => { sqlite.prepare('INSERT INTO tk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  if (!colsOf('tk_events').has('accountKey') || !colsOf('tk_sessions').has('accountKey') || !tableExists(DAILY) || !tableExists(HEAT)
    || colsOf('tk_daily').has('accountKey') || colsOf('tk_heatmap').has('accountKey')) {
    const v2 = sqlite.transaction(() => {
      const fromV1 = !colsOf('tk_events').has('accountKey')
      if (fromV1) sqlite.exec("ALTER TABLE tk_events ADD COLUMN accountKey TEXT NOT NULL DEFAULT ''")
      if (!colsOf('tk_sessions').has('accountKey')) sqlite.exec("ALTER TABLE tk_sessions ADD COLUMN accountKey TEXT NOT NULL DEFAULT ''")
      let dirty = false
      // Upgraded in place by an earlier build of this work: its tables move
      // to the new names, and the v1 ones are derived back from them.
      if (colsOf('tk_daily').has('accountKey')) {
        sqlite.exec(`DROP TABLE IF EXISTS ${DAILY}; DROP TABLE IF EXISTS tk_daily_next;
          ALTER TABLE tk_daily RENAME TO ${DAILY};
          ${V1_DAILY_DDL}
          INSERT INTO tk_daily(day,model,priceModel,provider,configId,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
            SELECT day,model,MIN(priceModel),provider,configId,SUM(inTok),SUM(outTok),SUM(cacheReadTok),SUM(cacheCreateTok),SUM(msgCount)
            FROM ${DAILY} GROUP BY day,model,provider,configId;`)
      }
      if (colsOf('tk_heatmap').has('accountKey')) {
        sqlite.exec(`DROP TABLE IF EXISTS ${HEAT}; DROP TABLE IF EXISTS tk_heatmap_next;
          ALTER TABLE tk_heatmap RENAME TO ${HEAT};
          ${V1_HEATMAP_DDL}
          INSERT INTO tk_heatmap(bucket,model,priceModel,configId,inTok,outTok,cacheReadTok,cacheCreateTok)
            SELECT bucket,model,MIN(priceModel),configId,SUM(inTok),SUM(outTok),SUM(cacheReadTok),SUM(cacheCreateTok)
            FROM ${HEAT} GROUP BY bucket,model,configId;`)
      }
      if (!tableExists(DAILY)) {
        sqlite.exec(`${dailyTable(DAILY)}
          INSERT INTO ${DAILY}(day,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
            SELECT day,model,priceModel,provider,COALESCE(configId,''),'',inTok,outTok,cacheReadTok,cacheCreateTok,msgCount FROM tk_daily;`)
      }
      if (!tableExists(HEAT)) {
        sqlite.exec(`${heatmapTable(HEAT)}
          INSERT INTO ${HEAT}(bucket,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok)
            SELECT bucket,model,priceModel,'',COALESCE(configId,''),'',inTok,outTok,cacheReadTok,cacheCreateTok FROM tk_heatmap;`)
        dirty = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${HEAT}`).get() as { n: number }).n > 0
      }
      if (fromV1) {
        const rewound = sqlite.prepare(`UPDATE tk_files SET lastOffset = 0, scannedTo = 0, codexTurns = 0,
            codexSessionId = '', codexModel = '', codexCwd = '', accountReread = 1
            WHERE codexSessionId <> '' OR path LIKE '%rollout-%'`).run().changes
        if (rewound > 0) { setMetaAtOpen('accountReread', 'pending'); dirty = true }
      }
      if (dirty) setMetaAtOpen('rollupsDirty', '1')
      setMetaAtOpen('schemaVersion', '2')
    })
    try {
      v2()
    } catch (err) {
      // Rolled back: the database is as it was, and the next open retries.
      try { sqlite.close() } catch { /* already closed */ }
      throw err
    }
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sessions_account ON tk_sessions(provider, accountKey)')

  // MP9 round 1 (Q-1): after a downgrade, a build from before MP9 stores
  // events and writes only its own (v1) rollups. `rollupRowid` says how far
  // the v2 rollups have seen; rows past it were stored by such a build. Its
  // Claude rows of attributed sessions take their account (MP10), and the
  // v2 rollups are rebuilt from the events. Its Codex rows stay not recorded.
  {
    const seen = Number((sqlite.prepare("SELECT value FROM tk_meta WHERE key = 'rollupRowid'").get() as { value?: string } | undefined)?.value)
    const stored = maxEventRowid()
    // None yet (a database just upgraded, or from an earlier build of this
    // work): the rollups hold everything stored so far.
    if (!Number.isFinite(seen)) setMetaAtOpen('rollupRowid', String(stored))
    else if (stored > seen) {
      sqlite.transaction(() => {
        const attributed = "SELECT sessionId FROM tk_session_accounts WHERE accountKey LIKE 'claude:%'"
        const accountOf = (t: string) => `(SELECT a.accountKey FROM tk_session_accounts a WHERE a.sessionId = ${t}.sessionId)`
        sqlite.prepare(`UPDATE tk_events SET accountKey = ${accountOf('tk_events')}
          WHERE rowid > ? AND provider = 'claude' AND accountKey = '' AND sessionId IN (${attributed})`).run(seen)
        sqlite.prepare(`UPDATE tk_sessions SET accountKey = ${accountOf('tk_sessions')}
          WHERE provider = 'claude' AND accountKey = '' AND sessionId IN (${attributed})`).run()
        setMetaAtOpen('rollupsDirty', '1')
        setMetaAtOpen('rollupRowid', String(stored))
      })()
    }
  }

  const getMetaStmt = sqlite.prepare('SELECT value FROM tk_meta WHERE key = ?')
  const setMetaStmt = sqlite.prepare('INSERT INTO tk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')

  // The #307 one-off re-index runs further down, once the rollup upserts it
  // rebuilds with have been prepared (see `reindex307`).
  const getCursorStmt = sqlite.prepare('SELECT path,size,mtime,lastOffset,lastIngestedAt,scannedTo,codexSessionId,codexModel,codexCwd,codexTurns,accountKey,accountReread FROM tk_files WHERE path = ?')
  // MP9: a file waiting for the account re-read is done once a write says it
  // has been scanned to its end.
  const setCursorStmt = sqlite.prepare(`INSERT INTO tk_files(path,size,mtime,lastOffset,lastIngestedAt,scannedTo,codexSessionId,codexModel,codexCwd,codexTurns,accountKey)
      VALUES(@path,@size,@mtime,@lastOffset,@lastIngestedAt,@scannedTo,@codexSessionId,@codexModel,@codexCwd,@codexTurns,@accountKey)
    ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,lastOffset=excluded.lastOffset,lastIngestedAt=excluded.lastIngestedAt,
      scannedTo=excluded.scannedTo,codexSessionId=excluded.codexSessionId,codexModel=excluded.codexModel,codexCwd=excluded.codexCwd,codexTurns=excluded.codexTurns,
      accountKey=excluded.accountKey,
      accountReread=CASE WHEN tk_files.accountReread = 1 AND excluded.scannedTo >= excluded.size THEN 2 ELSE tk_files.accountReread END`)

  // Fill the columns a caller predating them does not know about. `scannedTo`
  // defaults to lastOffset (the honest reading of "scanned this far") rather
  // than 0, so an old caller never reports a file as unscanned.
  const cursorRow = (c: TkFileCursor): Record<string, unknown> => ({
    path: c.path, size: c.size, mtime: c.mtime, lastOffset: c.lastOffset, lastIngestedAt: c.lastIngestedAt,
    scannedTo: c.scannedTo ?? c.lastOffset,
    codexSessionId: c.codexSessionId ?? '',
    codexModel: c.codexModel ?? '',
    codexCwd: c.codexCwd ?? '',
    codexTurns: c.codexTurns ?? 0,
    accountKey: tkAccountKeyOk(c.accountKey) ? c.accountKey : TK_ACCOUNT_NOT_RECORDED,
  })
  const countStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM tk_events')

  const insEvent = sqlite.prepare(`INSERT OR IGNORE INTO tk_events
    (dedupKey,sessionId,provider,model,priceModel,ts,day,configId,projectDir,inTok,outTok,cacheReadTok,cacheCreateTok,accountKey)
    VALUES (@dedupKey,@sessionId,@provider,@model,@priceModel,@ts,@day,@configId,@projectDir,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,@accountKey)`)
  // MP9: a row stored before its account was known is stamped by the re-read
  // of its rollout (same dedup key), never re-stamped once known.
  const restampEvent = sqlite.prepare("UPDATE tk_events SET accountKey = @accountKey WHERE dedupKey = @dedupKey AND accountKey = ''")
  // MP9 round 1 (B-F2): only a Codex session row: a rollout names its own
  // session id, and one naming a Claude session's never stamps it.
  const restampSession = sqlite.prepare("UPDATE tk_sessions SET accountKey = @accountKey WHERE sessionId = @sessionId AND provider = 'codex' AND accountKey = ''")
  /** Bumped by every stamp: a rebuild begun before one is not the last word. */
  let dirtyEpoch = 0

  const upDaily = sqlite.prepare(dailyUpsert(DAILY))
  const upDailyV1 = sqlite.prepare(V1_DAILY_UPSERT)

  const upSessionModel = sqlite.prepare(`INSERT INTO tk_session_models(sessionId,model,priceModel,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@sessionId,@model,@priceModel,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(sessionId,model) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1`)

  const upHeat = sqlite.prepare(heatmapUpsert(HEAT))
  const upHeatV1 = sqlite.prepare(V1_HEATMAP_UPSERT)

  const upSession = sqlite.prepare(`INSERT INTO tk_sessions(sessionId,provider,configId,projectDir,firstTs,lastTs,lastModel,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount,accountKey)
    VALUES(@sessionId,@provider,@configId,@projectDir,@ts,@ts,@model,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1,@accountKey)
    ON CONFLICT(sessionId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1,
      firstTs=MIN(firstTs, excluded.firstTs),
      lastTs=MAX(lastTs, excluded.lastTs),
      lastModel=CASE WHEN excluded.lastTs >= lastTs THEN excluded.lastModel ELSE lastModel END,
      configId=CASE WHEN tk_sessions.configId='' THEN excluded.configId ELSE tk_sessions.configId END,
      projectDir=CASE WHEN tk_sessions.projectDir='' THEN excluded.projectDir ELSE tk_sessions.projectDir END,
      accountKey=CASE WHEN tk_sessions.accountKey='' AND tk_sessions.provider=excluded.provider THEN excluded.accountKey ELSE tk_sessions.accountKey END`)

  const upConfig = sqlite.prepare(`INSERT INTO tk_configs(configId,label,workingDirectory) VALUES(@configId,@label,@workingDirectory)
    ON CONFLICT(configId) DO UPDATE SET label=excluded.label, workingDirectory=excluded.workingDirectory`)
  const getCwd = sqlite.prepare('SELECT projectDir FROM tk_sessions WHERE sessionId = ?')

  // MP10: the account a Claude session was attributed to, if it was.
  const sessionAccountStmt = sqlite.prepare('SELECT accountKey FROM tk_session_accounts WHERE sessionId = ?')
  const insertEventsTxn = sqlite.transaction((events: Array<TkEvent & { configId?: string | null }>) => {
    let inserted = 0
    let restamped = false
    let lastRowid = 0
    const attributed = new Map<string, string>()
    const sessionAccount = (sessionId: string): string => {
      let key = attributed.get(sessionId)
      if (key === undefined) {
        const row = sessionAccountStmt.get(sessionId) as { accountKey?: unknown } | undefined
        key = tkClaudeAccountKeyOk(row?.accountKey) ? row!.accountKey as string : TK_ACCOUNT_NOT_RECORDED
        attributed.set(sessionId, key)
      }
      return key
    }
    for (const e of events) {
      // '' = no-config sentinel (see KEY DESIGN). MUST be non-NULL for rollup PK aggregation.
      const configId = e.configId ?? ''
      const stamped = tkAccountKeyOk(e.accountKey) ? e.accountKey : TK_ACCOUNT_NOT_RECORDED
      // MP10: a Claude row with no account of its own takes its session's.
      const accountKey = stamped === TK_ACCOUNT_NOT_RECORDED && e.provider === 'claude' ? sessionAccount(e.sessionId) : stamped
      const day = dayOf(e.ts)
      const bucket = bucketOf(e.ts)
      const info = insEvent.run({ ...e, day, configId, projectDir: e.cwd, accountKey })
      if (info.changes === 0) {
        // Dedup hit -> do NOT touch rollups. MP9: a row stored before its
        // account was known is stamped now; the rollups catch up by rebuild.
        // Only by the row's own stamp (its folder's): a session's account
        // never re-stamps a row stored under another session (MP10: a
        // resumed transcript repeats earlier turns under the same keys).
        if (stamped !== TK_ACCOUNT_NOT_RECORDED && restampEvent.run({ dedupKey: e.dedupKey, accountKey: stamped }).changes > 0) {
          restampSession.run({ sessionId: e.sessionId, accountKey: stamped })
          restamped = true
        }
        continue
      }
      inserted++
      lastRowid = Number(info.lastInsertRowid)
      upSession.run({ ...e, configId, projectDir: e.cwd, accountKey })
      upSessionModel.run(e)
      upDaily.run({ ...e, day, configId, accountKey })
      upHeat.run({ ...e, bucket, configId, accountKey })
      // MP9 round 1 (Q-1): the v1 rollups too, for a build from before MP9.
      upDailyV1.run({ ...e, day, configId })
      upHeatV1.run({ ...e, bucket, configId })
    }
    // Once per transaction (MP9 round 1, Q-3).
    if (restamped) { dirtyEpoch++; setMetaStmt.run('rollupsDirty', '1') }
    if (lastRowid > 0) setMetaStmt.run('rollupRowid', String(lastRowid))
    return inserted
  })

  // One transaction over both writes. better-sqlite3 turns the nested
  // transaction into a savepoint, so a failure anywhere rolls back the rows
  // AND the cursor together — the invariant the ordinal base depends on.
  const insertEventsWithCursorTxn = sqlite.transaction((events: Array<TkEvent & { configId?: string | null }>, c: TkFileCursor) => {
    const n = events.length ? insertEventsTxn(events) : 0
    setCursorStmt.run(cursorRow(c))
    return n
  })

  // #307 one-off re-index. The Codex subagent-identity fix (tk-parse.ts /
  // tokenomics-worker.ts) changes a subagent rollout's dedup keys from the
  // parent's id to its own, so re-ingesting on top of rows stored under the OLD
  // keys would count those turns a second time. Codex rows therefore have to go
  // and come back from source.
  //
  // CODEX ROWS ONLY. The first cut of this wiped every event and rewound every
  // cursor "because the rollups are mixed" -- and anything whose source file was
  // gone could never come back: Claude Code deletes transcripts past its
  // retention window and people prune the Codex tree, so life-to-date Claude
  // spend older than the window was silently lost on first launch (found by the
  // ADR-009 pass before the build shipped). The rollups ARE pure aggregations of
  // tk_events, so they are rebuilt HERE, in the same transaction, by replaying
  // the surviving events through the very upserts the live ingest uses -- same
  // day/bucket maths, same first-config / last-model rules -- rather than by
  // hoping every source file still exists. Only Codex cursors are rewound (a
  // rollout is identified by its parsed header or its filename; a Claude
  // transcript that happens to sit under a directory called "rollout-…" merely
  // gets re-read, and its unchanged dedup keys make that a no-op). One
  // transaction: a crash mid-way leaves the old state intact. Guarded by a
  // tk_meta marker so it runs exactly once.
  // Pages by rowid: better-sqlite3 refuses other statements while an
  // `iterate()` cursor is open on the connection, and rowid order IS the
  // original ingest order, which is what the first-config / last-model upsert
  // rules were computed in the first time.
  // `day` is the STORED day (computed at ingest, in the ingest-time zone), not
  // re-derived from ts here: re-deriving would make the rebuilt rollups depend
  // on the machine's zone at re-index time and disagree with tk_events.day.
  // (`bucket` is not stored, so the heatmap is recomputed -- same maths the
  // live ingest uses, and the only value that exists for it.)
  const eventsPageStmt = sqlite.prepare('SELECT rowid AS rid,sessionId,provider,model,priceModel,ts,day,configId,projectDir,inTok,outTok,cacheReadTok,cacheCreateTok,accountKey FROM tk_events WHERE rowid > ? ORDER BY rowid ASC LIMIT 5000')
  const reindex307 = sqlite.transaction(() => {
    sqlite.exec(`
      DELETE FROM tk_events WHERE provider = 'codex';
      DELETE FROM tk_daily;
      DELETE FROM ${DAILY};
      DELETE FROM tk_session_models;
      DELETE FROM tk_heatmap;
      DELETE FROM ${HEAT};
      DELETE FROM tk_sessions;
      UPDATE tk_files SET lastOffset = 0, scannedTo = 0, codexTurns = 0,
        codexSessionId = '', codexModel = '', codexCwd = ''
        WHERE codexSessionId <> '' OR path LIKE '%rollout-%';
      DELETE FROM tk_meta WHERE key = 'firstIndexComplete';
    `)
    // ^ The index is NOT complete once every Codex row is gone and its files
    // are queued for re-read: leaving the flag would have the worker's first
    // `ready` report a complete total that is missing all Codex spend until the
    // re-ingest sweeps drain. Cleared, the worker takes its honest first-index
    // path and the UI says "indexing" until `drained`.
    let lastRid = 0
    for (;;) {
      const page = eventsPageStmt.all(lastRid) as Array<Record<string, unknown>>
      if (page.length === 0) break
      lastRid = page[page.length - 1].rid as number
      for (const row of page) {
      const e = {
        sessionId: row.sessionId as string,
        provider: row.provider as string,
        model: row.model as string,
        priceModel: row.priceModel as string,
        ts: row.ts as number,
        configId: (row.configId as string | null) ?? '',
        projectDir: (row.projectDir as string) ?? '',
        cwd: (row.projectDir as string) ?? '',
        inTok: row.inTok as number,
        outTok: row.outTok as number,
        cacheReadTok: row.cacheReadTok as number,
        cacheCreateTok: row.cacheCreateTok as number,
        accountKey: (row.accountKey as string | null) ?? '',
      }
      upSession.run(e)
      upSessionModel.run(e)
      upDaily.run({ ...e, day: (row.day as string | null) || dayOf(e.ts) })
      upHeat.run({ ...e, bucket: bucketOf(e.ts) })
      upDailyV1.run({ ...e, day: (row.day as string | null) || dayOf(e.ts) })
      upHeatV1.run({ ...e, bucket: bucketOf(e.ts) })
      }
    }
    setMetaStmt.run('codexReindex307', 'done')
  })
  if ((getMetaStmt.get('codexReindex307') as { value?: string } | undefined)?.value !== 'done') {
    try {
      reindex307()
    } catch (err) {
      // The transaction has rolled back (the DB is exactly as it was and the
      // marker is unset, so the next open retries). Do not leak the handle on
      // the way out: a failed open that kept the file open left a worker
      // alive-but-never-ready with the database held until the next launch.
      try { sqlite.close() } catch { /* already closed */ }
      throw err
    }
  }

  // Usage track MP9: rebuilding the daily and hourly rollups from the stored
  // events, in steps the worker paces (TK_REBUILD_PAGE rows each, yielding
  // between them), into shadow tables. Queries keep reading the live tables
  // throughout, and live ingest keeps writing them; events stored meanwhile
  // are later in rowid order, so the replay reaches them. The step that finds
  // the end swaps the shadow tables in, in the same transaction, so no event
  // falls between the last page read and the swap. A stamp during the rebuild
  // leaves the rollups dirty, for another one.
  const rebuildPageStmt = sqlite.prepare('SELECT rowid AS rid,provider,model,priceModel,ts,day,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok FROM tk_events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?')
  let rebuild: { lastRid: number; done: number; total: number; epoch: number; upD: Database.Statement; upH: Database.Statement } | null = null
  const beginRebuild = (): void => {
    sqlite.exec(`DROP TABLE IF EXISTS ${DAILY}_next; DROP TABLE IF EXISTS ${HEAT}_next;
      ${dailyTable(`${DAILY}_next`)}
      ${heatmapTable(`${HEAT}_next`)}`)
    rebuild = { lastRid: 0, done: 0, total: (countStmt.get() as { n: number }).n, epoch: dirtyEpoch, upD: sqlite.prepare(dailyUpsert(`${DAILY}_next`)), upH: sqlite.prepare(heatmapUpsert(`${HEAT}_next`)) }
  }
  const stepRebuildTxn = sqlite.transaction((maxRows: number): TkRebuildStep => {
    const r = rebuild
    if (!r) return { done: 0, total: 0, finished: true }
    const page = rebuildPageStmt.all(r.lastRid, maxRows) as Array<Record<string, unknown>>
    for (const row of page) {
      const e = {
        provider: row.provider as string,
        model: row.model as string,
        priceModel: row.priceModel as string,
        configId: (row.configId as string | null) ?? '',
        accountKey: (row.accountKey as string | null) ?? '',
        inTok: row.inTok as number,
        outTok: row.outTok as number,
        cacheReadTok: row.cacheReadTok as number,
        cacheCreateTok: row.cacheCreateTok as number,
      }
      // The stored day (ingest-time zone), as reindex307 replays it.
      r.upD.run({ ...e, day: (row.day as string | null) || dayOf(row.ts as number) })
      r.upH.run({ ...e, bucket: bucketOf(row.ts as number) })
    }
    if (page.length) r.lastRid = page[page.length - 1].rid as number
    r.done += page.length
    // Events stored meanwhile are replayed too: the total grows with them.
    const total = Math.max(r.total, r.done)
    if (page.length === maxRows) return { done: r.done, total, finished: false }
    sqlite.exec(`DROP TABLE ${DAILY}; ALTER TABLE ${DAILY}_next RENAME TO ${DAILY};
      DROP TABLE ${HEAT}; ALTER TABLE ${HEAT}_next RENAME TO ${HEAT};`)
    if (dirtyEpoch === r.epoch) setMetaStmt.run('rollupsDirty', '0')
    rebuild = null
    return { done: r.done, total: r.done, finished: true }
  })

  // Usage track MP10: a Claude session's account, recorded once, and the rows
  // already stored for it re-attributed in the same transaction. The rollups
  // are moved by exact deltas, grouped as the live ingest keyed them (the
  // stored day; the hour of week from the timestamp, as the rebuild does):
  // taken from the "not recorded" row, which must hold at least that much,
  // and added to the account's; a row left with no messages (daily) or no
  // tokens (hourly) is dropped. A group that cannot be taken leaves both rows
  // alone and the rollups dirty, so totals never move and a rebuild settles
  // the split. While the rollups are dirty or a rebuild runs, only the events
  // and session row are stamped and the rollups are left for a rebuild.
  // MP10 round 1: the latest account applies from then on; the same again
  // changes nothing (no row changed).
  const insSessionAccount = sqlite.prepare(`INSERT INTO tk_session_accounts(sessionId, accountKey, setAt) VALUES (?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET accountKey = excluded.accountKey, setAt = excluded.setAt
    WHERE tk_session_accounts.accountKey <> excluded.accountKey`)
  const sessionRowsStmt = sqlite.prepare(`SELECT day, ts, model, priceModel, provider, COALESCE(configId, '') AS configId, inTok, outTok, cacheReadTok, cacheCreateTok
    FROM tk_events WHERE sessionId = ? AND provider = 'claude' AND accountKey = ''`)
  const stampSessionEvents = sqlite.prepare("UPDATE tk_events SET accountKey = @accountKey WHERE sessionId = @sessionId AND provider = 'claude' AND accountKey = ''")
  const stampSessionRow = sqlite.prepare("UPDATE tk_sessions SET accountKey = @accountKey WHERE sessionId = @sessionId AND provider = 'claude' AND accountKey = ''")
  const TOKENS_AT_LEAST = 'inTok >= @inTok AND outTok >= @outTok AND cacheReadTok >= @cacheReadTok AND cacheCreateTok >= @cacheCreateTok'
  const TAKE_TOKENS = 'inTok = inTok - @inTok, outTok = outTok - @outTok, cacheReadTok = cacheReadTok - @cacheReadTok, cacheCreateTok = cacheCreateTok - @cacheCreateTok'
  const ADD_TOKENS = 'inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok, cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok'
  const dailyWhere = "day = @day AND model = @model AND provider = @provider AND configId = @configId AND accountKey = ''"
  const dailyTake = sqlite.prepare(`UPDATE ${DAILY} SET ${TAKE_TOKENS}, msgCount = msgCount - @msgCount WHERE ${dailyWhere} AND msgCount >= @msgCount AND ${TOKENS_AT_LEAST}`)
  const dailyPrune = sqlite.prepare(`DELETE FROM ${DAILY} WHERE ${dailyWhere} AND msgCount <= 0`)
  const dailyGive = sqlite.prepare(`INSERT INTO ${DAILY}(day,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@day,@model,@priceModel,@provider,@configId,@accountKey,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,@msgCount)
    ON CONFLICT(day,model,provider,configId,accountKey) DO UPDATE SET ${ADD_TOKENS}, msgCount=msgCount+excluded.msgCount`)
  const heatWhere = "bucket = @bucket AND model = @model AND provider = @provider AND configId = @configId AND accountKey = ''"
  const heatTake = sqlite.prepare(`UPDATE ${HEAT} SET ${TAKE_TOKENS} WHERE ${heatWhere} AND ${TOKENS_AT_LEAST}`)
  const heatPrune = sqlite.prepare(`DELETE FROM ${HEAT} WHERE ${heatWhere} AND inTok <= 0 AND outTok <= 0 AND cacheReadTok <= 0 AND cacheCreateTok <= 0`)
  const heatGive = sqlite.prepare(`INSERT INTO ${HEAT}(bucket,model,priceModel,provider,configId,accountKey,inTok,outTok,cacheReadTok,cacheCreateTok)
    VALUES(@bucket,@model,@priceModel,@provider,@configId,@accountKey,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)
    ON CONFLICT(bucket,model,provider,configId,accountKey) DO UPDATE SET ${ADD_TOKENS}`)
  type RollupDelta = { model: string; priceModel: string; provider: string; configId: string; inTok: number; outTok: number; cacheReadTok: number; cacheCreateTok: number; msgCount: number }
  const setSessionAccountTxn = sqlite.transaction((sessionId: string, accountKey: string, now: number): { recorded: boolean; stamped: number } => {
    if (insSessionAccount.run(sessionId, accountKey, now).changes === 0) return { recorded: false, stamped: 0 }
    const rows = sessionRowsStmt.all(sessionId) as Array<Record<string, unknown>>
    if (rows.length === 0) return { recorded: true, stamped: 0 }
    stampSessionEvents.run({ sessionId, accountKey })
    stampSessionRow.run({ sessionId, accountKey })
    const leaveDirty = (): void => { dirtyEpoch++; setMetaStmt.run('rollupsDirty', '1') }
    if (rebuild !== null || (getMetaStmt.get('rollupsDirty') as { value?: string } | undefined)?.value === '1') {
      leaveDirty()
      return { recorded: true, stamped: rows.length }
    }
    const daily = new Map<string, RollupDelta & { day: string }>()
    const heat = new Map<string, RollupDelta & { bucket: number }>()
    const add = <T extends RollupDelta>(into: Map<string, T>, key: string, fresh: () => T, r: Record<string, unknown>): void => {
      let d = into.get(key)
      if (!d) { d = fresh(); into.set(key, d) }
      d.inTok += Number(r.inTok) || 0
      d.outTok += Number(r.outTok) || 0
      d.cacheReadTok += Number(r.cacheReadTok) || 0
      d.cacheCreateTok += Number(r.cacheCreateTok) || 0
      d.msgCount += 1
    }
    for (const r of rows) {
      const base = { model: String(r.model), priceModel: String(r.priceModel), provider: String(r.provider), configId: String(r.configId ?? ''), inTok: 0, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, msgCount: 0 }
      const day = (r.day as string | null) || dayOf(r.ts as number)
      const bucket = bucketOf(r.ts as number)
      const sep = String.fromCharCode(0)
      add(daily, [day, base.model, base.provider, base.configId].join(sep), () => ({ ...base, day }), r)
      add(heat, [String(bucket), base.model, base.provider, base.configId].join(sep), () => ({ ...base, bucket }), r)
    }
    let whole = true
    for (const d of daily.values()) {
      if (dailyTake.run(d).changes === 0) { whole = false; continue }
      dailyPrune.run(d)
      dailyGive.run({ ...d, accountKey })
    }
    for (const h of heat.values()) {
      const { msgCount: _m, ...tokens } = h
      if (heatTake.run(tokens).changes === 0) { whole = false; continue }
      heatPrune.run(tokens)
      heatGive.run({ ...tokens, accountKey })
    }
    if (!whole) leaveDirty()
    return { recorded: true, stamped: rows.length }
  })

  return {
    raw: sqlite,
    getMeta: (key) => (getMetaStmt.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (key, value) => { setMetaStmt.run(key, value) },
    getFileCursor: (path) => (getCursorStmt.get(path) as TkFileCursor | undefined) ?? null,
    setFileCursor: (c) => { setCursorStmt.run(cursorRow(c)) },
    insertEventsWithCursor: (events, cursor) => insertEventsWithCursorTxn(events as any, cursor),
    eventCount: () => (countStmt.get() as { n: number }).n,
    insertEvents: (events) => insertEventsTxn(events as any),
    upsertConfigs: (configs) => { const txn = sqlite.transaction((cs: any[]) => { for (const c of cs) upConfig.run(c) }); txn(configs) },
    getSessionCwd: (sessionId) => { const r = getCwd.get(sessionId) as { projectDir: string } | undefined; return r?.projectDir || null },
    querySummary(pricing, filter = {}, nowMs) {
      const now = nowMs ?? Date.now()
      const { cte, binds: pb } = pricingCte(pricing)
      const cfg = filter.configId   // undefined=all, null=External(''), string=that id
      const cfgVal = cfg === undefined ? undefined : (cfg === null ? '' : cfg)

      // Build a WHERE fragment for a given table alias.
      // modelCol differs per table; withRange (day) only valid on tk_daily.
      const frag = (alias: string, modelCol: string, withRange: boolean): string => {
        let s = ''
        if (cfg !== undefined) s += ` AND ${alias}.configId = @cfg`
        if (filter.model !== undefined) s += ` AND ${alias}.${modelCol} = @model`
        // MP9: one provider's, or one account's, usage.
        if (filter.provider !== undefined) s += ` AND ${alias}.provider = @provider`
        if (filter.accountKey !== undefined) s += ` AND ${alias}.accountKey = @accountKey`
        if (withRange && filter.from !== undefined) s += ` AND ${alias}.day >= @fromDay`
        if (withRange && filter.to !== undefined) s += ` AND ${alias}.day <= @toDay`
        return s
      }

      const last7Cut = dayOf(now - 7 * 86_400_000)
      const prev7Cut = dayOf(now - 14 * 86_400_000)
      const binds: Record<string, unknown> = {
        ...pb,
        ...(cfgVal !== undefined ? { cfg: cfgVal } : {}),
        ...(filter.model !== undefined ? { model: filter.model } : {}),
        ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
        ...(filter.accountKey !== undefined ? { accountKey: filter.accountKey } : {}),
        ...(filter.from !== undefined ? { fromDay: dayOf(filter.from) } : {}),
        ...(filter.to !== undefined ? { toDay: dayOf(filter.to) } : {}),
        last7Cut, prev7Cut,
      }

      const dailyJoin = `${DAILY} d LEFT JOIN pricing p ON d.priceModel = p.pm`

      // KPIs: config+model scope, NO range (life-to-date / cache are all-time).
      // MP11: per provider, and in all; costs of priced models only.
      const life = sqlite.prepare(`WITH ${cte} SELECT d.provider AS provider,
          COALESCE(SUM(${COST('d')}),0) AS cost,
          COALESCE(SUM(d.cacheReadTok),0) AS cr,
          COALESCE(SUM(d.inTok),0) AS inp,
          COALESCE(SUM(d.cacheReadTok*(COALESCE(p.pin,0)-COALESCE(p.pcr,0))/1000000.0),0) AS savings
        FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',false)} GROUP BY d.provider`).all(binds) as any[]
      const l7 = sqlite.prepare(`WITH ${cte} SELECT d.provider AS provider, COALESCE(SUM(${COST('d')}),0) AS c FROM ${dailyJoin} WHERE d.day > @last7Cut ${frag('d','model',false)} GROUP BY d.provider`).all(binds) as any[]
      const p7 = sqlite.prepare(`WITH ${cte} SELECT d.provider AS provider, COALESCE(SUM(${COST('d')}),0) AS c FROM ${dailyJoin} WHERE d.day > @prev7Cut AND d.day <= @last7Cut ${frag('d','model',false)} GROUP BY d.provider`).all(binds) as any[]
      const kpisOf = (keep: (provider: string) => boolean): TkKpis => {
        const sum = (rows: any[], k: string): number => rows.filter((r) => keep(String(r.provider))).reduce((a, r) => a + (Number(r[k]) || 0), 0)
        const cr = sum(life, 'cr'), inp = sum(life, 'inp')
        return {
          lifeToDateCostUsd: sum(life, 'cost'),
          last7dCostUsd: sum(l7, 'c'),
          prev7dCostUsd: sum(p7, 'c'),
          cacheEfficiencyPct: (cr + inp) > 0 ? (cr / (cr + inp)) * 100 : 0,
          cacheSavingsUsd: sum(life, 'savings'),
        }
      }

      // Charts: config+model+range scope. MP11: the daily series per provider.
      const dailyRows = sqlite.prepare(`WITH ${cte} SELECT d.day AS day, d.provider AS provider, SUM(${COST('d')}) AS costUsd FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',true)} GROUP BY d.day, d.provider ORDER BY d.day`).all(binds) as any[]
      const daily: TkSummary['dailySeries'] = []
      for (const r of dailyRows) {
        let day = daily[daily.length - 1]
        if (!day || day.day !== r.day) { day = { day: r.day, costUsd: 0, byProvider: { claude: 0, codex: 0 } }; daily.push(day) }
        const c = Number(r.costUsd) || 0
        day.costUsd += c
        if ((PROVIDERS as readonly string[]).includes(r.provider)) day.byProvider[r.provider as TkProvider] += c
      }
      // MP11: the models in these figures with no price, and their tokens
      // (the life-to-date scope, which every figure falls within).
      const unpriced = sqlite.prepare(`WITH ${cte} SELECT d.model AS model, d.provider AS provider, SUM(d.inTok+d.outTok+d.cacheReadTok+d.cacheCreateTok) AS tokens FROM ${dailyJoin} WHERE p.pm IS NULL ${frag('d','model',false)} GROUP BY d.model, d.provider ORDER BY tokens DESC, d.model`).all(binds) as any[]
      const models = sqlite.prepare(`WITH ${cte} SELECT d.model AS model, SUM(${COST('d')}) AS costUsd, SUM(d.inTok+d.outTok+d.cacheReadTok+d.cacheCreateTok) AS tokens FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',true)} GROUP BY d.model ORDER BY costUsd DESC`).all(binds) as any[]
      const cache = sqlite.prepare(`WITH ${cte} SELECT
          COALESCE(SUM(d.inTok*COALESCE(p.pin,0)/1000000.0),0) AS inputUsd,
          COALESCE(SUM(d.outTok*COALESCE(p.pout,0)/1000000.0),0) AS outputUsd,
          COALESCE(SUM(d.cacheReadTok*COALESCE(p.pcr,0)/1000000.0),0) AS cacheReadUsd,
          COALESCE(SUM(d.cacheCreateTok*COALESCE(p.pcw,0)/1000000.0),0) AS cacheCreateUsd
        FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',true)}`).get(binds) as any
      const cbcRaw = sqlite.prepare(`WITH ${cte} SELECT d.configId AS configId, SUM(${COST('d')}) AS costUsd FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',true)} GROUP BY d.configId`).all(binds) as any[]

      // Sessions count per config (config+model scope only; lastModel is the model col)
      const sessCounts = sqlite.prepare(`SELECT configId, COUNT(*) AS sessions FROM tk_sessions s WHERE 1=1 ${frag('s','lastModel',false)} GROUP BY configId`).all(binds) as any[]

      // Heatmap (config+model scope; no range — heatmap has no day col)
      const heat = sqlite.prepare(`SELECT bucket, SUM(inTok+outTok+cacheReadTok+cacheCreateTok) AS tokens FROM ${HEAT} h WHERE 1=1 ${frag('h','model',false)} GROUP BY bucket`).all(binds) as any[]

      const cfgRows = sqlite.prepare(`SELECT configId, label FROM tk_configs`).all() as any[]
      const labelOf = new Map(cfgRows.map((r: any) => [r.configId, r.label]))
      const sessByCfg = new Map(sessCounts.map((r: any) => [r.configId, r.sessions]))

      const costByConfig = cbcRaw.map((r: any) => ({
        configId: r.configId === '' ? null : r.configId,
        label: (r.configId === '' ? '' : (labelOf.get(r.configId) || '')) || 'External / no config',
        costUsd: r.costUsd ?? 0,
        sessions: sessByCfg.get(r.configId) ?? 0,
      })).sort((a: any, b: any) => b.costUsd - a.costUsd)

      return {
        kpis: kpisOf(() => true),
        kpisByProvider: { claude: kpisOf((p) => p === 'claude'), codex: kpisOf((p) => p === 'codex') },
        dailySeries: daily,
        // A model with no price has no cost (null), never $0.
        modelSplit: models.map((m: any) => ({ model: m.model, costUsd: m.costUsd ?? null, tokens: m.tokens ?? 0 })),
        unpriced: unpriced.map((u: any) => ({ model: String(u.model), provider: u.provider as TkProvider, tokens: Number(u.tokens) || 0 })),
        cacheSplit: { inputUsd: cache.inputUsd ?? 0, outputUsd: cache.outputUsd ?? 0, cacheReadUsd: cache.cacheReadUsd ?? 0, cacheCreateUsd: cache.cacheCreateUsd ?? 0 },
        costByConfig,
        heatmap: heat.map((h: any) => ({ bucket: h.bucket, tokens: h.tokens ?? 0 })),
      }
    },
    querySessions(pricing, query = {}) {
      const { cte, binds: pb } = pricingCte(pricing)
      const cfg = query.configId
      const cfgVal = cfg === undefined ? undefined : (cfg === null ? '' : cfg)
      let where = ''
      const fb: Record<string, unknown> = {}
      if (cfg !== undefined) { where += ` AND s.configId = @cfg`; fb.cfg = cfgVal }
      if (query.from !== undefined) { where += ` AND s.lastTs >= @from`; fb.from = query.from }
      if (query.to !== undefined) { where += ` AND s.lastTs <= @to`; fb.to = query.to }
      if (query.model !== undefined) { where += ` AND s.lastModel = @model`; fb.model = query.model }
      if (query.provider !== undefined) { where += ` AND s.provider = @provider`; fb.provider = query.provider }
      if (query.accountKey !== undefined) { where += ` AND s.accountKey = @accountKey`; fb.accountKey = query.accountKey }
      if (query.search) { where += ` AND s.sessionId LIKE @search`; fb.search = `%${query.search}%` }
      if (query.cursor) { where += ` AND (s.lastTs < @ct OR (s.lastTs = @ct AND s.sessionId < @cs))`; fb.ct = query.cursor.lastTs; fb.cs = query.cursor.sessionId }
      const lim = Math.min(Math.max(query.limit ?? 50, 1), 200)
      const binds = { ...pb, ...fb, lim: lim + 1 }

      const sql = `WITH ${cte},
        page AS (
          SELECT s.* FROM tk_sessions s WHERE 1=1 ${where}
          ORDER BY s.lastTs DESC, s.sessionId DESC LIMIT @lim
        )
        SELECT page.sessionId AS sessionId, page.provider AS provider, page.configId AS configId,
          page.lastModel AS model, page.inTok AS inTok, page.outTok AS outTok,
          page.cacheReadTok AS cacheReadTok, page.cacheCreateTok AS cacheCreateTok,
          page.msgCount AS msgCount, page.lastTs AS lastTs, page.accountKey AS accountKey,
          (SELECT SUM(${COST('sm')}) FROM tk_session_models sm LEFT JOIN pricing p ON sm.priceModel=p.pm WHERE sm.sessionId = page.sessionId) AS costUsd,
          (SELECT COALESCE(SUM(sm.inTok+sm.outTok+sm.cacheReadTok+sm.cacheCreateTok), 0) FROM tk_session_models sm LEFT JOIN pricing p ON sm.priceModel=p.pm WHERE sm.sessionId = page.sessionId AND p.pm IS NULL) AS unpricedTokens,
          c.label AS cfgLabel
        FROM page LEFT JOIN tk_configs c ON page.configId = c.configId
        ORDER BY page.lastTs DESC, page.sessionId DESC`
      const raw = sqlite.prepare(sql).all(binds) as any[]
      const hasMore = raw.length > lim
      const pageRows = hasMore ? raw.slice(0, lim) : raw
      const rows = pageRows.map((r: any) => ({
        sessionId: r.sessionId as string,
        provider: r.provider as TkProvider,
        configId: (r.configId === '' ? null : r.configId) as string | null,
        configLabel: (r.cfgLabel && r.cfgLabel !== '') ? r.cfgLabel as string : 'External / no config',
        model: r.model as string,
        // MP11: null when none of its models has a price.
        costUsd: (r.costUsd ?? null) as number | null,
        unpricedTokens: Number(r.unpricedTokens) || 0,
        inTok: r.inTok as number,
        outTok: r.outTok as number,
        cacheReadTok: r.cacheReadTok as number,
        cacheCreateTok: r.cacheCreateTok as number,
        msgCount: r.msgCount as number,
        lastTs: r.lastTs as number,
        accountKey: (r.accountKey as string | null) ?? '',
      }))
      const nextCursor = hasMore
        ? { lastTs: pageRows[lim - 1].lastTs as number, sessionId: pageRows[lim - 1].sessionId as string }
        : null
      return { rows, nextCursor }
    },

    querySessionDetail(pricing, sessionId) {
      const { cte, binds: pb } = pricingCte(pricing)
      const s = sqlite.prepare(
        `SELECT s.*, c.label AS cfgLabel FROM tk_sessions s LEFT JOIN tk_configs c ON s.configId=c.configId WHERE s.sessionId=@sid`
      ).get({ sid: sessionId }) as any
      if (!s) return null
      const byModel = sqlite.prepare(
        `WITH ${cte} SELECT sm.model AS model, ${COST('sm')} AS costUsd,
          sm.inTok AS inTok, sm.outTok AS outTok, sm.cacheReadTok AS cacheReadTok,
          sm.cacheCreateTok AS cacheCreateTok, sm.msgCount AS msgCount
        FROM tk_session_models sm LEFT JOIN pricing p ON sm.priceModel=p.pm
        WHERE sm.sessionId=@sid ORDER BY costUsd DESC`
      ).all({ ...pb, sid: sessionId }) as any[]
      // MP11: the priced models' cost; none when no model has a price.
      const priced = byModel.filter((m: any) => m.costUsd !== null && m.costUsd !== undefined)
      const costUsd = priced.length ? priced.reduce((a: number, m: any) => a + (m.costUsd as number), 0) : null
      const unpricedTokens = byModel.filter((m: any) => m.costUsd === null || m.costUsd === undefined)
        .reduce((a: number, m: any) => a + (m.inTok as number) + (m.outTok as number) + (m.cacheReadTok as number) + (m.cacheCreateTok as number), 0)
      return {
        sessionId: s.sessionId as string,
        provider: s.provider as TkProvider,
        configId: (s.configId === '' ? null : s.configId) as string | null,
        configLabel: (s.cfgLabel && s.cfgLabel !== '') ? s.cfgLabel as string : 'External / no config',
        model: s.lastModel as string,
        costUsd,
        unpricedTokens,
        inTok: s.inTok as number,
        outTok: s.outTok as number,
        cacheReadTok: s.cacheReadTok as number,
        cacheCreateTok: s.cacheCreateTok as number,
        msgCount: s.msgCount as number,
        lastTs: s.lastTs as number,
        accountKey: (s.accountKey as string | null) ?? '',
        firstTs: s.firstTs as number,
        projectDir: s.projectDir as string,
        byModel: byModel.map((m: any) => ({
          model: m.model as string,
          costUsd: (m.costUsd ?? null) as number | null,
          inTok: m.inTok as number,
          outTok: m.outTok as number,
          cacheReadTok: m.cacheReadTok as number,
          cacheCreateTok: m.cacheCreateTok as number,
          msgCount: m.msgCount as number,
        })),
      }
    },

    setSessionAccount: (sessionId, accountKey, now) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || !tkClaudeAccountKeyOk(accountKey)) return { recorded: false, stamped: 0 }
      return setSessionAccountTxn(sessionId, accountKey, now)
    },
    queryAccounts() {
      const rows = sqlite.prepare(`SELECT provider, accountKey FROM ${DAILY} GROUP BY provider, accountKey ORDER BY provider, accountKey`).all() as Array<{ provider: TkProvider; accountKey: string }>
      return rows.map((r) => ({ provider: r.provider, accountKey: r.accountKey ?? '' }))
    },
    accountRereadPending: () => (getMetaStmt.get('accountReread') as { value?: string } | undefined)?.value === 'pending',
    finishAccountReread: () => {
      sqlite.transaction(() => {
        // A file still waiting was not reached by a sweep that read all it
        // could: it is gone (a pruned rollout). Its stored rows stay, not
        // recorded.
        sqlite.exec('UPDATE tk_files SET accountReread = 2 WHERE accountReread = 1')
        setMetaStmt.run('accountReread', 'done')
      })()
    },
    rollupsDirty: () => (getMetaStmt.get('rollupsDirty') as { value?: string } | undefined)?.value === '1',
    beginRollupRebuild: () => { beginRebuild() },
    stepRollupRebuild: (maxRows = TK_REBUILD_PAGE) => stepRebuildTxn(Math.max(1, Math.floor(maxRows))),
    checkpoint: () => { sqlite.pragma('wal_checkpoint(TRUNCATE)') },
    close: () => { sqlite.close() },
  }
}
