import Database from 'better-sqlite3'
import type { TkEvent } from './tk-types'

function dayOf(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function bucketOf(ts: number): number {
  const d = new Date(ts)
  return d.getDay() * 24 + d.getHours()
}

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO tk_meta(key, value) VALUES ('schemaVersion', '1');

CREATE TABLE IF NOT EXISTS tk_files (
  path           TEXT PRIMARY KEY,
  size           INTEGER NOT NULL,
  mtime          INTEGER NOT NULL,
  lastOffset     INTEGER NOT NULL DEFAULT 0,
  lastIngestedAt INTEGER NOT NULL DEFAULT 0
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
  cacheCreateTok INTEGER NOT NULL
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
  msgCount       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_lastts ON tk_sessions(lastTs DESC, sessionId DESC);
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

CREATE TABLE IF NOT EXISTS tk_daily (
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
);

CREATE TABLE IF NOT EXISTS tk_heatmap (
  bucket         INTEGER NOT NULL,
  model          TEXT NOT NULL,
  priceModel     TEXT NOT NULL,
  configId       TEXT,
  inTok          INTEGER NOT NULL DEFAULT 0,
  outTok         INTEGER NOT NULL DEFAULT 0,
  cacheReadTok   INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, model, configId)
);

CREATE TABLE IF NOT EXISTS tk_configs (
  configId        TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  workingDirectory TEXT NOT NULL DEFAULT ''
);
`

export interface TkFileCursor { path: string; size: number; mtime: number; lastOffset: number; lastIngestedAt: number }

export interface TkDb {
  raw: Database.Database
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  getFileCursor(path: string): TkFileCursor | null
  setFileCursor(c: TkFileCursor): void
  eventCount(): number
  insertEvents(events: TkEvent[]): number
  upsertConfigs(configs: Array<{ configId: string; label: string; workingDirectory: string }>): void
  getSessionCwd(sessionId: string): string | null
  checkpoint(): void
  close(): void
}

export function openTkDb(dbPath: string): TkDb {
  const sqlite = new Database(dbPath)
  sqlite.exec(DDL)

  const getMetaStmt = sqlite.prepare('SELECT value FROM tk_meta WHERE key = ?')
  const setMetaStmt = sqlite.prepare('INSERT INTO tk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  const getCursorStmt = sqlite.prepare('SELECT path,size,mtime,lastOffset,lastIngestedAt FROM tk_files WHERE path = ?')
  const setCursorStmt = sqlite.prepare(`INSERT INTO tk_files(path,size,mtime,lastOffset,lastIngestedAt) VALUES(@path,@size,@mtime,@lastOffset,@lastIngestedAt)
    ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,lastOffset=excluded.lastOffset,lastIngestedAt=excluded.lastIngestedAt`)
  const countStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM tk_events')

  const insEvent = sqlite.prepare(`INSERT OR IGNORE INTO tk_events
    (dedupKey,sessionId,provider,model,priceModel,ts,day,configId,projectDir,inTok,outTok,cacheReadTok,cacheCreateTok)
    VALUES (@dedupKey,@sessionId,@provider,@model,@priceModel,@ts,@day,@configId,@projectDir,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)`)

  const upDaily = sqlite.prepare(`INSERT INTO tk_daily(day,model,priceModel,provider,configId,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@day,@model,@priceModel,@provider,@configId,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(day,model,provider,configId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1`)

  const upSessionModel = sqlite.prepare(`INSERT INTO tk_session_models(sessionId,model,priceModel,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@sessionId,@model,@priceModel,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(sessionId,model) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1`)

  const upHeat = sqlite.prepare(`INSERT INTO tk_heatmap(bucket,model,priceModel,configId,inTok,outTok,cacheReadTok,cacheCreateTok)
    VALUES(@bucket,@model,@priceModel,@configId,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)
    ON CONFLICT(bucket,model,configId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok`)

  const upSession = sqlite.prepare(`INSERT INTO tk_sessions(sessionId,provider,configId,projectDir,firstTs,lastTs,lastModel,inTok,outTok,cacheReadTok,cacheCreateTok,msgCount)
    VALUES(@sessionId,@provider,@configId,@projectDir,@ts,@ts,@model,@inTok,@outTok,@cacheReadTok,@cacheCreateTok,1)
    ON CONFLICT(sessionId) DO UPDATE SET
      inTok=inTok+excluded.inTok, outTok=outTok+excluded.outTok,
      cacheReadTok=cacheReadTok+excluded.cacheReadTok, cacheCreateTok=cacheCreateTok+excluded.cacheCreateTok,
      msgCount=msgCount+1,
      firstTs=MIN(firstTs, excluded.firstTs),
      lastTs=MAX(lastTs, excluded.lastTs),
      lastModel=CASE WHEN excluded.lastTs >= lastTs THEN excluded.lastModel ELSE lastModel END,
      configId=CASE WHEN tk_sessions.configId='' THEN excluded.configId ELSE tk_sessions.configId END,
      projectDir=CASE WHEN tk_sessions.projectDir='' THEN excluded.projectDir ELSE tk_sessions.projectDir END`)

  const upConfig = sqlite.prepare(`INSERT INTO tk_configs(configId,label,workingDirectory) VALUES(@configId,@label,@workingDirectory)
    ON CONFLICT(configId) DO UPDATE SET label=excluded.label, workingDirectory=excluded.workingDirectory`)
  const getCwd = sqlite.prepare('SELECT projectDir FROM tk_sessions WHERE sessionId = ?')

  const insertEventsTxn = sqlite.transaction((events: Array<TkEvent & { configId?: string | null }>) => {
    let inserted = 0
    for (const e of events) {
      // '' = no-config sentinel (see KEY DESIGN). MUST be non-NULL for rollup PK aggregation.
      const configId = e.configId ?? ''
      const day = dayOf(e.ts)
      const bucket = bucketOf(e.ts)
      const info = insEvent.run({ ...e, day, configId, projectDir: e.cwd })
      if (info.changes === 0) continue   // dedup hit -> do NOT touch rollups
      inserted++
      upSession.run({ ...e, configId, projectDir: e.cwd })
      upSessionModel.run(e)
      upDaily.run({ ...e, day, configId })
      upHeat.run({ ...e, bucket, configId })
    }
    return inserted
  })

  return {
    raw: sqlite,
    getMeta: (key) => (getMetaStmt.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (key, value) => { setMetaStmt.run(key, value) },
    getFileCursor: (path) => (getCursorStmt.get(path) as TkFileCursor | undefined) ?? null,
    setFileCursor: (c) => { setCursorStmt.run(c) },
    eventCount: () => (countStmt.get() as { n: number }).n,
    insertEvents: (events) => insertEventsTxn(events as any),
    upsertConfigs: (configs) => { const txn = sqlite.transaction((cs: any[]) => { for (const c of cs) upConfig.run(c) }); txn(configs) },
    getSessionCwd: (sessionId) => { const r = getCwd.get(sessionId) as { projectDir: string } | undefined; return r?.projectDir || null },
    checkpoint: () => { sqlite.pragma('wal_checkpoint(TRUNCATE)') },
    close: () => { sqlite.close() },
  }
}
