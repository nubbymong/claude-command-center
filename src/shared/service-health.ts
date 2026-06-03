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
}

export interface ServiceLogEntry {
  ts: number
  serviceId: string
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
}

export interface DiagnosticsSnapshot {
  capturedAt: number
  services: ServiceHealth[]
  log: ServiceLogEntry[]
  pty?: PtyIntegritySnapshot
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
