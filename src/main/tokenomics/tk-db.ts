import Database from 'better-sqlite3'
import type { TkEvent, TkPricing, TkSummary, TkSummaryFilter, TkSessionsQuery, TkSessionsPage, TkSessionDetail } from './tk-types'

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
const COST = (a: string) => `((${a}.inTok*COALESCE(p.pin,0)+${a}.outTok*COALESCE(p.pout,0)+${a}.cacheReadTok*COALESCE(p.pcr,0)+${a}.cacheCreateTok*COALESCE(p.pcw,0))/1000000.0)`

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
  querySummary(pricing: Record<string, TkPricing>, filter?: TkSummaryFilter, nowMs?: number): TkSummary
  querySessions(pricing: Record<string, TkPricing>, query?: TkSessionsQuery): TkSessionsPage
  querySessionDetail(pricing: Record<string, TkPricing>, sessionId: string): TkSessionDetail | null
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
        ...(filter.from !== undefined ? { fromDay: dayOf(filter.from) } : {}),
        ...(filter.to !== undefined ? { toDay: dayOf(filter.to) } : {}),
        last7Cut, prev7Cut,
      }

      const dailyJoin = `tk_daily d LEFT JOIN pricing p ON d.priceModel = p.pm`

      // KPIs: config+model scope, NO range (life-to-date / cache are all-time)
      const life = sqlite.prepare(`WITH ${cte} SELECT
          COALESCE(SUM(${COST('d')}),0) AS cost,
          COALESCE(SUM(d.cacheReadTok),0) AS cr,
          COALESCE(SUM(d.inTok),0) AS inp,
          COALESCE(SUM(d.cacheReadTok*(COALESCE(p.pin,0)-COALESCE(p.pcr,0))/1000000.0),0) AS savings
        FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',false)}`).get(binds) as any

      const l7 = (sqlite.prepare(`WITH ${cte} SELECT COALESCE(SUM(${COST('d')}),0) AS c FROM ${dailyJoin} WHERE d.day > @last7Cut ${frag('d','model',false)}`).get(binds) as any).c
      const p7 = (sqlite.prepare(`WITH ${cte} SELECT COALESCE(SUM(${COST('d')}),0) AS c FROM ${dailyJoin} WHERE d.day > @prev7Cut AND d.day <= @last7Cut ${frag('d','model',false)}`).get(binds) as any).c

      // Charts: config+model+range scope
      const daily = sqlite.prepare(`WITH ${cte} SELECT d.day AS day, SUM(${COST('d')}) AS costUsd FROM ${dailyJoin} WHERE 1=1 ${frag('d','model',true)} GROUP BY d.day ORDER BY d.day`).all(binds) as any[]
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
      const heat = sqlite.prepare(`SELECT bucket, SUM(inTok+outTok+cacheReadTok+cacheCreateTok) AS tokens FROM tk_heatmap h WHERE 1=1 ${frag('h','model',false)} GROUP BY bucket`).all(binds) as any[]

      const cfgRows = sqlite.prepare(`SELECT configId, label FROM tk_configs`).all() as any[]
      const labelOf = new Map(cfgRows.map((r: any) => [r.configId, r.label]))
      const sessByCfg = new Map(sessCounts.map((r: any) => [r.configId, r.sessions]))

      const costByConfig = cbcRaw.map((r: any) => ({
        configId: r.configId === '' ? null : r.configId,
        label: (r.configId === '' ? '' : (labelOf.get(r.configId) || '')) || 'External / no config',
        costUsd: r.costUsd ?? 0,
        sessions: sessByCfg.get(r.configId) ?? 0,
      })).sort((a: any, b: any) => b.costUsd - a.costUsd)

      const cr = life.cr ?? 0, inp = life.inp ?? 0
      return {
        kpis: {
          lifeToDateCostUsd: life.cost ?? 0,
          last7dCostUsd: l7 ?? 0,
          prev7dCostUsd: p7 ?? 0,
          cacheEfficiencyPct: (cr + inp) > 0 ? (cr / (cr + inp)) * 100 : 0,
          cacheSavingsUsd: life.savings ?? 0,
        },
        dailySeries: daily.map((d: any) => ({ day: d.day, costUsd: d.costUsd ?? 0 })),
        modelSplit: models.map((m: any) => ({ model: m.model, costUsd: m.costUsd ?? 0, tokens: m.tokens ?? 0 })),
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
          page.msgCount AS msgCount, page.lastTs AS lastTs,
          COALESCE((SELECT SUM(${COST('sm')}) FROM tk_session_models sm LEFT JOIN pricing p ON sm.priceModel=p.pm WHERE sm.sessionId = page.sessionId), 0) AS costUsd,
          c.label AS cfgLabel
        FROM page LEFT JOIN tk_configs c ON page.configId = c.configId
        ORDER BY page.lastTs DESC, page.sessionId DESC`
      const raw = sqlite.prepare(sql).all(binds) as any[]
      const hasMore = raw.length > lim
      const pageRows = hasMore ? raw.slice(0, lim) : raw
      const rows = pageRows.map((r: any) => ({
        sessionId: r.sessionId as string,
        provider: r.provider as string,
        configId: (r.configId === '' ? null : r.configId) as string | null,
        configLabel: (r.cfgLabel && r.cfgLabel !== '') ? r.cfgLabel as string : 'External / no config',
        model: r.model as string,
        costUsd: (r.costUsd ?? 0) as number,
        inTok: r.inTok as number,
        outTok: r.outTok as number,
        cacheReadTok: r.cacheReadTok as number,
        cacheCreateTok: r.cacheCreateTok as number,
        msgCount: r.msgCount as number,
        lastTs: r.lastTs as number,
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
      const costUsd = byModel.reduce((a: number, m: any) => a + ((m.costUsd as number) ?? 0), 0)
      return {
        sessionId: s.sessionId as string,
        provider: s.provider as string,
        configId: (s.configId === '' ? null : s.configId) as string | null,
        configLabel: (s.cfgLabel && s.cfgLabel !== '') ? s.cfgLabel as string : 'External / no config',
        model: s.lastModel as string,
        costUsd,
        inTok: s.inTok as number,
        outTok: s.outTok as number,
        cacheReadTok: s.cacheReadTok as number,
        cacheCreateTok: s.cacheCreateTok as number,
        msgCount: s.msgCount as number,
        lastTs: s.lastTs as number,
        firstTs: s.firstTs as number,
        projectDir: s.projectDir as string,
        byModel: byModel.map((m: any) => ({
          model: m.model as string,
          costUsd: (m.costUsd ?? 0) as number,
          inTok: m.inTok as number,
          outTok: m.outTok as number,
          cacheReadTok: m.cacheReadTok as number,
          cacheCreateTok: m.cacheCreateTok as number,
          msgCount: m.msgCount as number,
        })),
      }
    },

    checkpoint: () => { sqlite.pragma('wal_checkpoint(TRUNCATE)') },
    close: () => { sqlite.close() },
  }
}
