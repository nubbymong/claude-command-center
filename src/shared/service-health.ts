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
