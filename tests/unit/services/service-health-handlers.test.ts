import { describe, it, expect } from 'vitest'
import { getMergedDiagnostics, buildRestart } from '../../../src/main/ipc/service-health-handlers'
import { createInitialHealth } from '../../../src/shared/service-health'

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
})
