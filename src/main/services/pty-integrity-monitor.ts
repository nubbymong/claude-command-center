import type {
  PtyIntegritySnapshot, PtySessionIntegrity, PtyIntegrityEvent, PtyIntegrityReport, ServiceLogEntry,
} from '../../shared/service-health'

interface SessionRec {
  sessionId: string
  bytesFromPty: number
  chunksFromPty: number
  resizeCount: number
  lastAppliedCols: number | null
  lastAppliedRows: number | null
  bytesReceived: number
  bytesWritten: number
  strippedBytes: number
  lastRendererCols: number | null
  lastRendererRows: number | null
  rendererResizeCount: number
  widthDesyncCount: number
  byteGapFlagged: boolean
  desyncFlagged: boolean
  /** The renderer mount (PtyIntegrityReport.generation) whose counts the
   *  record holds: null until a report names one, and again after a reset. */
  mountGeneration: string | null
}

function freshRec(sessionId: string): SessionRec {
  return {
    sessionId, bytesFromPty: 0, chunksFromPty: 0, resizeCount: 0,
    lastAppliedCols: null, lastAppliedRows: null,
    bytesReceived: 0, bytesWritten: 0, strippedBytes: 0,
    lastRendererCols: null, lastRendererRows: null, rendererResizeCount: 0,
    widthDesyncCount: 0, byteGapFlagged: false, desyncFlagged: false,
    mountGeneration: null,
  }
}

// A renderer mount's generation as main takes it from a report: 1 to 64 of
// [A-Za-z0-9_-] (TerminalView sends a randomId). Any other value is no
// generation: the report counts against the mount the record already has.
const GENERATION_MAX = 64
const GENERATION_RE = /^[A-Za-z0-9_-]+$/
function mountGenerationOf(v: unknown): string | null {
  return typeof v === 'string' && v.length <= GENERATION_MAX && GENERATION_RE.test(v) ? v : null
}

/** A byte count main takes from a report: a non-negative safe integer. */
function isByteCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

export interface PtyIntegrityMonitorOptions {
  emit: () => void              // push a merged diagnostics snapshot to the renderer
  now?: () => number
  eventCap?: number             // recent-events ring (default 100)
  logCap?: number               // notable-log ring (default 50)
  emitDebounceMs?: number       // default 250
  byteGapThreshold?: number     // default 4096
}

const LOG_SERVICE = 'pty'

export class PtyIntegrityMonitor {
  private sessions = new Map<string, SessionRec>()
  private events: PtyIntegrityEvent[] = []
  private logs: ServiceLogEntry[] = []
  private now: () => number
  private emitFn: () => void
  private eventCap: number
  private logCap: number
  private debounceMs: number
  private gapThreshold: number
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: PtyIntegrityMonitorOptions) {
    this.emitFn = opts.emit
    this.now = opts.now ?? (() => Date.now())
    this.eventCap = opts.eventCap ?? 100
    this.logCap = opts.logCap ?? 50
    this.debounceMs = opts.emitDebounceMs ?? 250
    this.gapThreshold = opts.byteGapThreshold ?? 4096
  }

  private rec(sessionId: string): SessionRec {
    let r = this.sessions.get(sessionId)
    if (!r) {
      r = freshRec(sessionId)
      this.sessions.set(sessionId, r)
    }
    return r
  }

  private pushEvent(kind: PtyIntegrityEvent['kind'], sessionId: string, detail: string): void {
    this.events.push({ ts: this.now(), kind, sessionId, detail })
    if (this.events.length > this.eventCap) this.events.splice(0, this.events.length - this.eventCap)
  }

  private pushLog(level: ServiceLogEntry['level'], code: string, message: string): void {
    this.logs.push({ ts: this.now(), serviceId: LOG_SERVICE, level, code, message })
    if (this.logs.length > this.logCap) this.logs.splice(0, this.logs.length - this.logCap)
  }

  private scheduleEmit(): void {
    if (this.debounceMs <= 0) { try { this.emitFn() } catch { /* window gone */ } ; return }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      try { this.emitFn() } catch { /* window gone */ }
    }, this.debounceMs)
  }

  recordPtyData(sessionId: string, byteLength: number): void {
    const r = this.rec(sessionId)
    r.bytesFromPty += byteLength
    r.chunksFromPty += 1
    this.scheduleEmit()
  }

  recordResizeApplied(sessionId: string, cols: number, rows: number): void {
    const r = this.rec(sessionId)
    r.resizeCount += 1
    r.lastAppliedCols = cols
    r.lastAppliedRows = rows
    this.pushEvent('resize', sessionId, `applied ${cols}x${rows}`)
    this.checkDesync(r)
    this.scheduleEmit()
  }

  recordRendererReport(report: PtyIntegrityReport): void {
    const r = this.rec(report.sessionId)
    this.noteMount(r, report)
    r.bytesReceived = report.bytesReceived
    r.bytesWritten = report.bytesWritten
    r.strippedBytes = report.strippedBytes
    r.lastRendererCols = report.cols
    r.lastRendererRows = report.rows
    r.rendererResizeCount = report.resizeCount
    this.checkDesync(r)
    this.checkByteGap(r)
    this.scheduleEmit()
  }

  /**
   * A report names the TerminalView mount its counts are from, and each mount
   * counts from 0. A change of mount while the PTY runs on (a re-key with no
   * respawn: a Restart pressed from the partner view re-keys the main view)
   * restarts main's count there: the bytes main read are set to the mount's
   * count, so the gap is measured from this report on, and checkByteGap then
   * finds none (it clears the flag). Quiet: no event, no log. Any change of
   * mount does this, a late report of an earlier mount too, so neither one
   * shows a gap. A record with no mount yet (a new one, or one reset: the next
   * process and its mount start from 0 together) takes the mount as it is. A
   * report without a valid generation or byte count changes nothing here.
   */
  private noteMount(r: SessionRec, report: PtyIntegrityReport): void {
    const generation = mountGenerationOf(report.generation)
    if (generation === null || generation === r.mountGeneration || !isByteCount(report.bytesReceived)) return
    if (r.mountGeneration !== null) r.bytesFromPty = report.bytesReceived
    r.mountGeneration = generation
  }

  /**
   * The session's PTY process ended and its id may spawn again (pty-manager's
   * per-spawn teardown, which a Restart and every respawn run). The record's
   * counts and mount start again from 0, quietly: the record stays, with no
   * event and no log. endSession is the session's end (its event, and the
   * record goes). A session with no record has nothing to reset.
   */
  resetSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.sessions.set(sessionId, freshRec(sessionId))
    this.scheduleEmit()
  }

  endSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.sessions.delete(sessionId)
    this.pushEvent('end', sessionId, 'session ended')
    this.scheduleEmit()
  }

  private checkDesync(r: SessionRec): void {
    // Hysteresis (mirrors checkByteGap): count + log ONE event per desync EPISODE
    // (a synced->desynced transition), not once per report tick. Persistent
    // mismatches would otherwise inflate widthDesyncCount and flood the rings,
    // evicting the genuinely-useful timeline.
    const isDesynced =
      r.lastAppliedCols != null && r.lastRendererCols != null && r.lastAppliedCols !== r.lastRendererCols
    if (isDesynced && !r.desyncFlagged) {
      r.desyncFlagged = true
      r.widthDesyncCount += 1
      this.pushEvent('desync', r.sessionId, `cols main=${r.lastAppliedCols} renderer=${r.lastRendererCols}`)
      this.pushLog('warn', 'pty-width-desync', `${r.sessionId}: cols main=${r.lastAppliedCols} renderer=${r.lastRendererCols}`)
    } else if (!isDesynced && r.desyncFlagged) {
      r.desyncFlagged = false
    }
  }

  private checkByteGap(r: SessionRec): void {
    const gap = r.bytesFromPty - r.bytesReceived
    if (gap > this.gapThreshold && !r.byteGapFlagged) {
      r.byteGapFlagged = true
      this.pushEvent('byte-gap', r.sessionId, `gap ${gap} bytes (sent ${r.bytesFromPty}, received ${r.bytesReceived})`)
      this.pushLog('warn', 'pty-byte-gap', `${r.sessionId}: ${gap} bytes unaccounted (sent ${r.bytesFromPty}, received ${r.bytesReceived})`)
    } else if (gap <= 0 && r.byteGapFlagged) {
      r.byteGapFlagged = false
    }
  }

  snapshot(): PtyIntegritySnapshot {
    const sessions: PtySessionIntegrity[] = [...this.sessions.values()].map((r) => ({
      sessionId: r.sessionId,
      bytesFromPty: r.bytesFromPty,
      bytesReceived: r.bytesReceived,
      bytesWritten: r.bytesWritten,
      strippedBytes: r.strippedBytes,
      byteGap: r.bytesReceived > 0 ? r.bytesFromPty - r.bytesReceived : 0,
      chunksFromPty: r.chunksFromPty,
      appliedCols: r.lastAppliedCols,
      rendererCols: r.lastRendererCols,
      resizeCount: r.resizeCount,
      widthDesyncCount: r.widthDesyncCount,
    }))
    return {
      sessions,
      totals: {
        activeSessions: sessions.length,
        bytesFromPty: sessions.reduce((a, s) => a + s.bytesFromPty, 0),
        resizes: sessions.reduce((a, s) => a + s.resizeCount, 0),
        desyncs: sessions.reduce((a, s) => a + s.widthDesyncCount, 0),
      },
      // Shallow array copies are safe: event/log entries are write-once (pushed,
      // never mutated), and the only consumer is IPC structured-clone. Matches the
      // ServiceSupervisor's own shallow `[...this.log]` pattern.
      recentEvents: [...this.events],
    }
  }

  /** Snapshot + the notable-log ring (serviceId 'pty'), for the diagnostics merge. */
  diagnostics(): { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } {
    return { snapshot: this.snapshot(), logs: [...this.logs] }
  }
}

// Module singleton so pty-manager (a separate module) can record without an
// import cycle through index.ts.
let _monitor: PtyIntegrityMonitor | null = null
export function setPtyIntegrityMonitor(m: PtyIntegrityMonitor | null): void { _monitor = m }
export function getPtyIntegrityMonitor(): PtyIntegrityMonitor | null { return _monitor }
