import { describe, it, expect } from 'vitest'
import { deriveDotState } from '../../src/renderer/components/sentinel/SentinelDot'

const base = { lastSeenCcVersion: '2.0.13', analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [] }
const f = (over: object) => ({ id: 'x', kind: 'compat', severity: 'warn', title: 't', evidence: 'e', status: 'open', createdAt: 1, ...over })

describe('deriveDotState', () => {
  it('disabled -> hidden', () => expect(deriveDotState(false, base as never)).toBe('hidden'))
  it('no snap (sentinel off / not initialized) -> hidden', () => expect(deriveDotState(true, null)).toBe('hidden'))
  it('clear -> ok', () => expect(deriveDotState(true, base as never)).toBe('ok'))
  it('analyzing wins', () => expect(deriveDotState(true, { ...base, analyzing: true } as never)).toBe('analyzing'))
  it('open high compat -> high', () =>
    expect(deriveDotState(true, { ...base, findings: [f({ severity: 'high' })] } as never)).toBe('high'))
  it('open non-high -> findings', () =>
    expect(deriveDotState(true, { ...base, findings: [f({})] } as never)).toBe('findings'))
  it('muted/dismissed/applied findings do not count', () =>
    expect(deriveDotState(true, { ...base, findings: [f({ status: 'muted' }), f({ id: 'y', status: 'dismissed' })] } as never)).toBe('ok'))
})
