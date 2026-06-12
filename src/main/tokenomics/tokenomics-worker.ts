import * as nodeFs from 'fs'
import * as path from 'path'
import { openTkDb, type TkDb } from './tk-db'
import { parseClaudeUsageLine, extractCwdFromLine, codexEventsFromRollout } from './tk-parse'
import { findConfigForCwd, isJunkCwd } from './tk-config-match'
import type { TkConfigDim, TkEvent, TkPricing } from './tk-types'
import type { ToTkWorker, FromTkWorker, TkWorkerHostTransport } from './tk-worker-transport'

export interface TkWorkerDeps { fs?: typeof nodeFs; watchDebounceMs?: number; configs?: TkConfigDim[]; maxTickBytes?: number }
export interface TokenomicsWorker { tickNow(): void; healthNow(): void; stop(): void }

const READ_BUF = 256 * 1024
const MAX_TICK_BYTES = 16 * 1024 * 1024
const YIELD_EVERY = 16 // files between event-loop yields during a sweep

export function createTokenomicsWorker(host: TkWorkerHostTransport, deps: TkWorkerDeps = {}): TokenomicsWorker {
  const fs = deps.fs ?? nodeFs
  const maxTickBytes = deps.maxTickBytes ?? MAX_TICK_BYTES
  const watchDebounceMs = deps.watchDebounceMs ?? 750
  let db: TkDb | undefined
  let pricing: Record<string, TkPricing> = {}
  let priceKeys: string[] = []
  let configs: TkConfigDim[] = deps.configs ?? []
  let claudeDir = ''
  let codexDir = ''
  let sweeping = false
  let firstSweepDone = false
  let lastProgress = { filesDone: 0, filesTotal: 0, eventsIngested: 0 }
  const watchers: Array<{ close(): void }> = []
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  let tailTimer: ReturnType<typeof setInterval> | null = null

  const post = (m: FromTkWorker): void => host.post(m)
  const logw = (level: 'info' | 'warn' | 'error', message: string): void => post({ type: 'log', entry: { level, message } })
  const setPricing = (p: Record<string, TkPricing>): void => { pricing = p; priceKeys = Object.keys(p) }

  function enumerateClaude(): string[] {
    // Recurse the whole tree (spec: `~/.claude/projects/**`). Session transcripts
    // live one level deep (`<proj>/<sid>.jsonl`) but subagent/sidechain transcripts
    // are nested (`<proj>/<sid>/subagents/agent-*.jsonl`) and carry real billed
    // usage — a one-level scan silently undercounts cost. Skip symlinks/junctions
    // so account-isolation reparse points can't introduce traversal cycles.
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return
      let entries: nodeFs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
      }
    }
    try { if (fs.existsSync(claudeDir)) walk(claudeDir, 0) }
    catch (err) { logw('warn', `enumerateClaude failed: ${String(err)}`) }
    return out
  }

  function enumerateCodex(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      let entries: string[]
      try { entries = fs.readdirSync(dir) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e)
        let st: nodeFs.Stats
        try { st = fs.statSync(full) } catch { continue }
        if (st.isDirectory()) walk(full)
        else if (e.startsWith('rollout-') && e.endsWith('.jsonl') && st.size > 0) out.push(full)
      }
    }
    try { if (fs.existsSync(codexDir)) walk(codexDir) } catch (err) { logw('warn', `enumerateCodex failed: ${String(err)}`) }
    return out
  }

  function resolveConfigId(cwd: string): string | null {
    if (!cwd || isJunkCwd(cwd)) return null
    const c = findConfigForCwd(cwd, configs)
    return c ? c.configId : null
  }

  function ingestClaudeFile(file: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    let offset = cursor ? cursor.lastOffset : 0
    if (cursor && st.size < cursor.lastOffset) offset = 0 // truncated/rotated -> re-read
    if (cursor && st.size === cursor.size && st.mtimeMs === cursor.mtime && offset === cursor.lastOffset && offset >= st.size) return 0
    if (st.size <= offset) { db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: offset, lastIngestedAt: Date.now() }); return 0 }

    const end = Math.min(st.size, offset + maxTickBytes)
    const fd = fs.openSync(file, 'r')
    let inserted = 0
    let fileCwd = ''
    try {
      let pos = offset
      let carry = Buffer.alloc(0)
      const buf = Buffer.alloc(READ_BUF)
      let batch: Array<TkEvent & { configId?: string | null }> = []
      let consumed = offset
      const flush = (): void => { if (batch.length) { inserted += db!.insertEvents(batch); batch = [] } }
      while (pos < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(READ_BUF, end - pos), pos)
        if (n <= 0) break
        pos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
        let ls = 0
        for (;;) {
          const nl = chunk.indexOf(0x0a, ls)
          if (nl === -1) break
          let lb = chunk.subarray(ls, nl)
          if (lb.length && lb[lb.length - 1] === 0x0d) lb = lb.subarray(0, lb.length - 1)
          const line = lb.toString('utf8')
          consumed += nl - ls + 1
          ls = nl + 1
          if (!line) continue
          const lineCwd = extractCwdFromLine(line)
          if (lineCwd) fileCwd = lineCwd
          const ev = parseClaudeUsageLine(line, priceKeys)
          if (!ev) continue
          const cwd = ev.cwd || fileCwd || db!.getSessionCwd(ev.sessionId) || ''
          batch.push({ ...ev, cwd, configId: resolveConfigId(cwd) })
          if (batch.length >= 500) flush()
        }
        carry = Buffer.from(chunk.subarray(ls))
      }
      flush()
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now() })
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return inserted
  }

  function ingestCodexFile(file: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    if (cursor && st.size === cursor.size && st.mtimeMs === cursor.mtime) return 0
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { return 0 }
    const all = codexEventsFromRollout(text, priceKeys, 0)
    let inserted = 0
    if (all.length) {
      const sessionId = all[0].sessionId
      const existing = (db!.raw.prepare("SELECT COUNT(*) AS n FROM tk_events WHERE sessionId = ? AND provider = 'codex'").get(sessionId) as { n: number }).n
      const fresh = all.slice(existing).map((ev) => ({ ...ev, configId: resolveConfigId(ev.cwd) }))
      if (fresh.length) inserted = db!.insertEvents(fresh)
    }
    db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: st.size, lastIngestedAt: Date.now() })
    return inserted
  }

  async function ingestAll(phase: 'initial' | 'incremental'): Promise<void> {
    if (!db || sweeping) return
    sweeping = true
    try {
      const claude = enumerateClaude()
      const codex = enumerateCodex()
      const total = claude.length + codex.length
      let done = 0
      let events = 0
      // Yield to the worker event loop periodically so pending queries (summary /
      // index-status) are answered DURING a large first index instead of stalling
      // behind a synchronous multi-thousand-file sweep.
      const tick = (): void => {
        if (done % 50 === 0) { lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }; post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase }) }
      }
      // After each yield, bail if stop() closed the db while we were suspended
      // (the resumed continuation would otherwise deref a now-undefined db).
      for (const f of claude) { events += ingestClaudeFile(f); done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return } }
      for (const f of codex) { events += ingestCodexFile(f); done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return } }
      if (!db) return
      lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }
      post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase })
      db.setMeta('lastIndexAt', String(Date.now()))
      if (phase === 'initial' && !firstSweepDone) {
        firstSweepDone = true
        db.setMeta('firstIndexComplete', '1')
        post({ type: 'index-complete', firstIndex: true, eventsTotal: db.eventCount() })
      } else {
        post({ type: 'index-complete', firstIndex: false, eventsTotal: db.eventCount() })
      }
    } catch (err) { logw('error', `ingestAll failed: ${String(err)}`) }
    finally { sweeping = false }
  }

  function indexStatus(): unknown {
    const lastAt = db!.getMeta('lastIndexAt')
    return {
      firstIndexComplete: db!.getMeta('firstIndexComplete') === '1',
      indexing: sweeping,
      filesDone: lastProgress.filesDone,
      filesTotal: lastProgress.filesTotal,
      eventsTotal: db!.eventCount(),
      lastIndexAt: lastAt ? Number(lastAt) : null,
    }
  }

  function handleQuery(id: number, kind: string, args: Record<string, unknown>): void {
    try {
      let rows: unknown[]
      switch (kind) {
        case 'summary': rows = [db!.querySummary(pricing, args as any)]; break
        case 'sessions': rows = [db!.querySessions(pricing, args as any)]; break
        case 'session-detail': rows = [db!.querySessionDetail(pricing, String((args as any).sessionId))]; break
        case 'index-status': rows = [indexStatus()]; break
        default: post({ type: 'error', id, message: `unknown query kind: ${kind}` }); return
      }
      post({ type: 'query-result', id, rows })
    } catch (err) { post({ type: 'error', id, message: `query ${kind} failed: ${err instanceof Error ? err.message : String(err)}` }) }
  }

  function scheduleIncremental(): void {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = setTimeout(() => { watchTimer = null; void ingestAll('incremental') }, watchDebounceMs)
    ;(watchTimer as unknown as { unref?: () => void }).unref?.()
  }

  function startWatching(): void {
    for (const dir of [claudeDir, codexDir]) {
      try {
        if (!fs.existsSync(dir)) continue
        const wch = fs.watch(dir, { recursive: true }, () => scheduleIncremental())
        // An FSWatcher 'error' with no listener throws -> uncaughtException -> the
        // worker dies and burns a restart toward permanent degrade. Log + close the
        // broken watcher; the 5s tailTimer sweep below keeps indexing alive.
        ;(wch as { on?: (ev: string, cb: (e: unknown) => void) => void }).on?.('error', (err) => {
          logw('warn', `fs.watch error for ${dir}; relying on periodic sweep: ${String(err)}`)
          try { wch.close() } catch { /* already closed */ }
        })
        watchers.push(wch)
      } catch (err) { logw('warn', `fs.watch failed for ${dir}: ${String(err)}`) }
    }
    // Safety tail: recursive watch can miss newly-created nested session files on
    // some platforms; a slow periodic incremental sweep guarantees eventual pickup.
    tailTimer = setInterval(() => { if (!sweeping) void ingestAll('incremental') }, 5000)
    ;(tailTimer as unknown as { unref?: () => void }).unref?.()
  }

  function open(msg: Extract<ToTkWorker, { type: 'open' }>): void {
    db = openTkDb(msg.dbPath)
    setPricing(msg.pricing)
    configs = msg.configs
    if (configs.length) db.upsertConfigs(configs)
    claudeDir = msg.claudeProjectsDir
    codexDir = msg.codexSessionsDir
    firstSweepDone = db.getMeta('firstIndexComplete') === '1'
    post({ type: 'ready' }) // ready BEFORE the sweep so queries work during indexing
    setTimeout(() => { void ingestAll('initial') }, 0)
    startWatching()
  }

  function handle(msg: ToTkWorker): void {
    switch (msg.type) {
      case 'open': open(msg); return
      case 'shutdown': stop(); return
    }
    if (!db) { post({ type: 'error', id: msg.type === 'query' ? msg.id : undefined, message: `worker received ${msg.type} before open` }); return }
    switch (msg.type) {
      case 'set-pricing': setPricing(msg.pricing); return
      case 'set-configs': configs = msg.configs; db.upsertConfigs(configs); return
      case 'reindex': void ingestAll('incremental'); return
      case 'query': handleQuery(msg.id, msg.kind, msg.args); return
      default: { const _x: never = msg; void _x }
    }
  }

  host.onMessage((msg) => {
    const qid = msg?.type === 'query' ? msg.id : undefined
    try { handle(msg) } catch (err) {
      try { post({ type: 'error', id: qid, message: `worker handling failed: ${err instanceof Error ? err.message : String(err)}` }) } catch { /* ignore */ }
    }
  })

  function tickNow(): void { void ingestAll('incremental') }
  function healthNow(): void {
    if (!db) return
    const filesTracked = (db.raw.prepare('SELECT COUNT(*) AS n FROM tk_files').get() as { n: number }).n
    post({ type: 'health', eventsTotal: db.eventCount(), filesTracked, dbBytes: 0 })
  }
  function stop(): void {
    for (const wch of watchers) { try { wch.close() } catch { /* ignore */ } }
    watchers.length = 0
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null }
    try { db?.close() } catch { /* ignore */ }
    db = undefined
  }

  return { tickNow, healthNow, stop }
}

// utilityProcess bootstrap (only defined inside a forked utilityProcess; undefined in tests)
const parentPort = (process as unknown as { parentPort?: { on(ev: 'message', h: (e: { data: unknown }) => void): void; postMessage(m: FromTkWorker): void } }).parentPort
if (parentPort) {
  const host: TkWorkerHostTransport = {
    post: (m) => parentPort.postMessage(m),
    onMessage: (h) => parentPort.on('message', (e) => h(e.data as ToTkWorker)),
  }
  createTokenomicsWorker(host)
}
