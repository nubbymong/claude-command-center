import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getMergedDiagnostics, buildRestart } from '../../../src/main/ipc/service-health-handlers'
import { createInitialHealth } from '../../../src/shared/service-health'

// ---------------------------------------------------------------------------
// Mock the logging-service module so tests can control getLogSupervisor().
// ---------------------------------------------------------------------------
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: vi.fn(() => null),
}))

import { getLogSupervisor } from '../../../src/main/logging/logging-service'
const mockGetLogSupervisor = getLogSupervisor as ReturnType<typeof vi.fn>

beforeEach(() => {
  // Default: logging disabled / not initialised.
  mockGetLogSupervisor.mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('service-health-handlers', () => {
  it('GET returns the supervisor snapshot when present', () => {
    const snap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const s = getMergedDiagnostics(() => ({ getDiagnosticsSnapshot: () => snap } as never), () => null)
    expect(s.services[0].id).toBe('hooks')
  })
  it('GET returns a synthetic stopped snapshot when no supervisor', () => {
    const s = getMergedDiagnostics(() => null, () => null)
    expect(s.services[0].state).toBe('stopped')
    expect(s.services[0].id).toBe('hooks')
  })
  it('RESTART delegates to manualRestart', () => {
    const restart = buildRestart(() => ({ manualRestart: (id: string) => ({ ok: true, id }) } as never))
    expect(restart('hooks')).toEqual({ ok: true, id: 'hooks' })
  })
  it('RESTART returns ok:false when no supervisor', () => {
    const restart = buildRestart(() => null)
    expect(restart('hooks')).toEqual({ ok: false, reason: 'no-supervisor' })
  })
  it('RESTART routes a logging serviceId to the log supervisor (not the hooks one)', () => {
    mockGetLogSupervisor.mockReturnValue({ manualRestart: (id: string) => ({ ok: true, who: 'logging', id }) })
    const hooksGetter = vi.fn(() => ({ manualRestart: () => ({ ok: true, who: 'hooks' }) } as never))
    const restart = buildRestart(hooksGetter)
    expect(restart('logging')).toEqual({ ok: true, who: 'logging', id: 'logging' })
    expect(hooksGetter).not.toHaveBeenCalled()
  })
  it('RESTART returns no-supervisor for logging when the log supervisor is absent', () => {
    mockGetLogSupervisor.mockReturnValue(null)
    const restart = buildRestart(() => ({ manualRestart: () => ({ ok: true }) } as never))
    expect(restart('logging')).toEqual({ ok: false, reason: 'no-supervisor' })
  })

  // --- §14: logging service merging ---

  it('includes the logging service entry when getLogSupervisor() returns a fake supervisor', () => {
    const hooksSnap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const logHealth = { ...createInitialHealth('logging', 'Session logging'), state: 'listening' as const }
    const logSnap = {
      capturedAt: 1,
      services: [logHealth],
      log: [{ ts: 10, serviceId: 'logging', level: 'info' as const, code: 'ready', message: 'ok' }],
    }
    mockGetLogSupervisor.mockReturnValue({ getDiagnosticsSnapshot: () => logSnap })

    const s = getMergedDiagnostics(
      () => ({ getDiagnosticsSnapshot: () => hooksSnap } as never),
      () => null,
    )

    // Both services present.
    expect(s.services).toHaveLength(2)
    const ids = s.services.map((svc) => svc.id)
    expect(ids).toContain('hooks')
    expect(ids).toContain('logging')
    // Log entries merged.
    expect(s.log.some((e) => e.serviceId === 'logging')).toBe(true)
  })

  it('does NOT include a logging service entry when getLogSupervisor() returns null (disabled)', () => {
    mockGetLogSupervisor.mockReturnValue(null)
    const hooksSnap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const s = getMergedDiagnostics(
      () => ({ getDiagnosticsSnapshot: () => hooksSnap } as never),
      () => null,
    )
    expect(s.services).toHaveLength(1)
    expect(s.services[0].id).toBe('hooks')
  })

  it('folds the watchdog ServiceHealth + monitor snapshot when the manager is present', () => {
    const hooksSnap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const wdHealth = { ...createInitialHealth('watchdog', 'Watchdog'), state: 'listening' as const }
    const wdMon = {
      activeSessions: 2, waitingSessions: 1, silentSessions: 1,
      throttle: { stallsLastMin: 0, tickMs: 5000 },
      sessions: [{ sessionId: 's1', status: 'monitoring', gaveUp: false, waitUntil: null, silent: true, idleMs: 130000 }],
    }
    const s = getMergedDiagnostics(
      () => ({ getDiagnosticsSnapshot: () => hooksSnap } as never),
      () => null,
      () => ({
        getDiagnosticsSnapshot: () => ({ capturedAt: 1, services: [wdHealth], log: [] }),
        getMonitorSnapshot: () => wdMon,
      } as never),
    )
    expect(s.services.map((svc) => svc.id)).toContain('watchdog')
    expect(s.watchdog).toEqual(wdMon)
  })

  it('routes a watchdog restart to the watchdog manager', () => {
    const restart = buildRestart(
      () => ({ manualRestart: () => ({ ok: true, who: 'hooks' }) } as never),
      () => ({ manualRestart: (id: string) => ({ ok: true, who: 'watchdog', id }) } as never),
    )
    expect(restart('watchdog')).toEqual({ ok: true, who: 'watchdog', id: 'watchdog' })
  })

  it('omits the watchdog block when the manager is absent', () => {
    const hooksSnap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const s = getMergedDiagnostics(() => ({ getDiagnosticsSnapshot: () => hooksSnap } as never), () => null, () => null)
    expect(s.services.map((svc) => svc.id)).not.toContain('watchdog')
    expect(s.watchdog).toBeUndefined()
  })

  it('PTY block and logging block are both merged simultaneously', () => {
    const hooksSnap = { capturedAt: 1, services: [createInitialHealth('hooks', 'Hooks gateway')], log: [] }
    const logHealth = { ...createInitialHealth('logging', 'Session logging'), state: 'listening' as const }
    mockGetLogSupervisor.mockReturnValue({
      getDiagnosticsSnapshot: () => ({ capturedAt: 1, services: [logHealth], log: [] }),
    })
    const ptySnap = {
      sessions: [], totals: { activeSessions: 0, bytesFromPty: 0, resizes: 0, desyncs: 0 }, recentEvents: [],
    }
    const s = getMergedDiagnostics(
      () => ({ getDiagnosticsSnapshot: () => hooksSnap } as never),
      () => ({ snapshot: ptySnap, logs: [] }),
    )
    expect(s.services).toHaveLength(2)
    expect(s.pty).toBeDefined()
  })
})
