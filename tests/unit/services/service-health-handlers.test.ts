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
