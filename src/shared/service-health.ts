export type ServiceState =
  | 'starting' | 'listening' | 'degraded' | 'restarting' | 'crashed' | 'stopped'
export type ServiceHost = 'utility-process' | 'in-process-fallback'

export interface ServiceHealth {
  id: string
  label: string
  host: ServiceHost
  state: ServiceState
  port: number | null
  pid: number | null
  startedAt: number | null
  inFlight: number
  eventsTotal: number
  dropsTotal: number
  throughputPerSec: number
  restartCount: number
  lastError: { message: string; ts: number } | null
  mainLoopStallsLastMin: number
  childLoopStallsLastMin: number
  lastHeartbeatAt: number
  // Logging-service-specific, OPTIONAL so the hooks service + createInitialHealth
  // are unaffected. dbBytes = on-disk size of the log DB; lastFlushAt = ts of the
  // last worker health beat (the worker is synchronous, so a beat == a flush point).
  dbBytes?: number
  lastFlushAt?: number
}

export interface ServiceLogEntry {
  ts: number
  serviceId: string
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
}

/** Per-session watchdog monitor state surfaced to the services view (#235). */
export interface WatchdogSessionMonitor {
  sessionId: string
  status: string
  gaveUp: boolean
  waitUntil: number | null
  /** True when no PTY output has arrived for the silence window. */
  silent: boolean
  /** ms since the last PTY chunk for this session. */
  idleMs: number
}

/** Snapshot of the whole watchdog subsystem for the services view (#235). */
export interface WatchdogMonitorSnapshot {
  activeSessions: number
  waitingSessions: number
  silentSessions: number
  throttle: { stallsLastMin: number; tickMs: number }
  sessions: WatchdogSessionMonitor[]
}

export interface DiagnosticsSnapshot {
  capturedAt: number
  services: ServiceHealth[]
  log: ServiceLogEntry[]
  pty?: PtyIntegritySnapshot
  watchdog?: WatchdogMonitorSnapshot
}

export interface PtyIntegrityEvent {
  ts: number
  kind: 'resize' | 'desync' | 'byte-gap' | 'end'
  sessionId: string
  detail: string
}

export interface PtySessionIntegrity {
  sessionId: string
  bytesFromPty: number       // bytes main read from node-pty and sent
  bytesReceived: number      // bytes the renderer received over IPC
  bytesWritten: number       // bytes the renderer wrote to xterm
  strippedBytes: number      // bytes stripCursorSequences removed
  byteGap: number            // bytesFromPty - bytesReceived (loss signal; 0 until renderer reports)
  chunksFromPty: number
  appliedCols: number | null // last cols main applied to the PTY
  rendererCols: number | null// last cols the renderer reported
  resizeCount: number
  widthDesyncCount: number
}

export interface PtyIntegritySnapshot {
  sessions: PtySessionIntegrity[]
  totals: { activeSessions: number; bytesFromPty: number; resizes: number; desyncs: number }
  recentEvents: PtyIntegrityEvent[]
}

/** Renderer -> main per-session integrity report (throttled). */
export interface PtyIntegrityReport {
  sessionId: string
  bytesReceived: number
  bytesWritten: number
  strippedBytes: number
  cols: number
  rows: number
  resizeCount: number
}

export function createInitialHealth(id: string, label: string): ServiceHealth {
  return {
    id, label, host: 'in-process-fallback', state: 'starting',
    port: null, pid: null, startedAt: null,
    inFlight: 0, eventsTotal: 0, dropsTotal: 0, throughputPerSec: 0,
    restartCount: 0, lastError: null,
    mainLoopStallsLastMin: 0, childLoopStallsLastMin: 0, lastHeartbeatAt: 0,
  }
}

/** A single throughput sample: the cumulative event counter at a wall-clock ts.
 *  Each supervisor keeps the LAST sample it computed throughput against. */
export interface ThroughputSample {
  eventsTotal: number
  ts: number
}

/**
 * Pure: events/sec between two successive counter samples, rounded to 1 decimal.
 *
 * Returns 0 when there is no prior sample (first beat — we cannot know a rate
 * yet), when no measurable time has elapsed (ts non-increasing — avoids div-by-0
 * and bogus spikes from same-tick beats), or when the counter went backwards
 * (a restart reset eventsTotal — clamp to 0 rather than report a negative rate).
 * An idle service whose counter does not move honestly reports 0.
 *
 * Kept PURE (no module state, no clock) so it is trivially table-tested and so
 * no main-process import leaks into this shared module.
 */
export function computeThroughput(prev: ThroughputSample | null, next: ThroughputSample): number {
  if (!prev) return 0
  const dtMs = next.ts - prev.ts
  if (dtMs <= 0) return 0
  const dEvents = next.eventsTotal - prev.eventsTotal
  if (dEvents <= 0) return 0
  const perSec = (dEvents / dtMs) * 1000
  return Math.round(perSec * 10) / 10
}
