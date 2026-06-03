import { describe, it, expect } from 'vitest'
import { getMergedDiagnostics } from '../../../src/main/ipc/service-health-handlers'
import type { DiagnosticsSnapshot, PtyIntegritySnapshot, ServiceLogEntry } from '../../../src/shared/service-health'

const supSnap: DiagnosticsSnapshot = {
  capturedAt: 10,
  services: [{ id: 'hooks', label: 'Hooks gateway', host: 'utility-process', state: 'listening',
    port: 1, pid: 2, startedAt: 0, inFlight: 0, eventsTotal: 0, dropsTotal: 0, throughputPerSec: 0,
    restartCount: 0, lastError: null, mainLoopStallsLastMin: 0, childLoopStallsLastMin: 0, lastHeartbeatAt: 0 }],
  log: [{ ts: 5, serviceId: 'hooks', level: 'info', code: 'bound', message: 'bound' }],
}
const ptySnap: PtyIntegritySnapshot = { sessions: [], totals: { activeSessions: 0, bytesFromPty: 0, resizes: 0, desyncs: 0 }, recentEvents: [] }
const ptyLogs: ServiceLogEntry[] = [{ ts: 7, serviceId: 'pty', level: 'warn', code: 'pty-width-desync', message: 'x' }]

describe('getMergedDiagnostics', () => {
  it('attaches the pty block and merges logs sorted by ts', () => {
    const out = getMergedDiagnostics(() => ({ getDiagnosticsSnapshot: () => supSnap, manualRestart: () => ({ ok: true }) }) as any, () => ({ snapshot: ptySnap, logs: ptyLogs }))
    expect(out.pty).toBe(ptySnap)
    expect(out.log.map(l => l.serviceId)).toEqual(['hooks', 'pty']) // ts 5 then 7
    expect(out.services[0].id).toBe('hooks')
  })

  it('serves a synthetic hooks-off base but still attaches pty', () => {
    const out = getMergedDiagnostics(() => null, () => ({ snapshot: ptySnap, logs: [] }))
    expect(out.services[0].state).toBe('stopped')
    expect(out.pty).toBe(ptySnap)
  })

  it('returns the plain base when there is no pty provider data', () => {
    const out = getMergedDiagnostics(() => ({ getDiagnosticsSnapshot: () => supSnap, manualRestart: () => ({ ok: true }) }) as any, () => null)
    expect(out.pty).toBeUndefined()
    expect(out.log).toHaveLength(1)
  })

  it('caps the merged log at 200, keeping the newest by ts', () => {
    // 150 hooks logs (ts 0..149) + 150 pty logs (ts 1000..1149) = 300 -> capped to 200.
    const hooksLog: ServiceLogEntry[] = Array.from({ length: 150 }, (_, i) => ({ ts: i, serviceId: 'hooks', level: 'info', code: 'h', message: `h${i}` }))
    const ptyLog: ServiceLogEntry[] = Array.from({ length: 150 }, (_, i) => ({ ts: 1000 + i, serviceId: 'pty', level: 'info', code: 'p', message: `p${i}` }))
    const bigSup: DiagnosticsSnapshot = { ...supSnap, log: hooksLog }
    const out = getMergedDiagnostics(() => ({ getDiagnosticsSnapshot: () => bigSup, manualRestart: () => ({ ok: true }) }) as any, () => ({ snapshot: ptySnap, logs: ptyLog }))
    expect(out.log).toHaveLength(200)
    // Newest 200 kept (oldest 100 hooks entries dropped): first survivor is hooks ts=100, last is pty ts=1149.
    expect(out.log[0].ts).toBe(100)
    expect(out.log[out.log.length - 1].ts).toBe(1149)
  })
})
