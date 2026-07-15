import { describe, it, expect } from 'vitest'
import { deriveDotState } from '../../src/renderer/components/sentinel/SentinelDot'

const base = { lastSeenCcVersion: '2.0.13', analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [] }
const f = (over: object) => ({ id: 'x', kind: 'compat', severity: 'warn', title: 't', evidence: 'e', status: 'open', createdAt: 1, ...over })

describe('deriveDotState', () => {
  it('disabled -> hidden', () => expect(deriveDotState(false, base as never)).toBe('hidden'))
  it('no snap (sentinel off / not initialized) -> hidden', () => expect(deriveDotState(true, null)).toBe('hidden'))
  it('clear -> ok', () => expect(deriveDotState(true, base as never)).toBe('ok'))
  it('analyzing wins', () => expect(deriveDotState(true, { ...base, analyzing: true } as never)).toBe('analyzing'))
  it('open high compat (reaching) -> high', () =>
    expect(deriveDotState(true, { ...base, findings: [f({ severity: 'high' })] } as never)).toBe('high'))
  it('open reaching warn -> findings', () =>
    expect(deriveDotState(true, { ...base, findings: [f({})] } as never)).toBe('findings'))
  it('muted/dismissed/applied findings do not count', () =>
    expect(deriveDotState(true, { ...base, findings: [f({ status: 'muted' }), f({ id: 'y', status: 'dismissed' })] } as never)).toBe('ok'))

  // ── Reachability calibration: orange must mean "this reaches YOUR setup" ──
  it('info-only findings -> reviewed (calm: open, but nothing actionable)', () =>
    expect(
      deriveDotState(true, {
        ...base,
        findings: [f({ severity: 'info' }), f({ id: 'y', kind: 'info', severity: 'warn' })],
      } as never),
    ).toBe('reviewed'))

  it('managed-only + unused-env warns -> reviewed (inert for a non-managed account)', () =>
    expect(
      deriveDotState(true, {
        ...base,
        findings: [
          f({ id: 'm', title: 'enforceAvailableModels', evidence: 'Added enforceAvailableModels managed setting' }),
          f({ id: 'e', title: 'env', evidence: 'redirected via ANTHROPIC_DEFAULT_*_MODEL environment variables' }),
        ],
      } as never),
    ).toBe('reviewed'))

  it('the real CC 2.1.177 report (2 inert warns + 3 info) -> reviewed (calm grey)', () =>
    expect(
      deriveDotState(true, {
        ...base,
        findings: [
          f({ id: '0', severity: 'warn', title: 'enforceAvailableModels constrains --model', evidence: 'Added enforceAvailableModels managed setting' }),
          f({ id: '1', severity: 'warn', title: 'env vars blocked', evidence: 'redirected via ANTHROPIC_DEFAULT_*_MODEL environment variables' }),
          f({ id: '2', kind: 'info', severity: 'info', title: 'Remote Control attach no longer mutates model' }),
          f({ id: '3', kind: 'info', severity: 'info', title: 'Background sessions isolate ANTHROPIC_* env' }),
          f({ id: '4', kind: 'info', severity: 'info', title: 'Fable 5 auto-mode may emit Opus 4.7 IDs' }),
        ],
      } as never),
    ).toBe('reviewed'))

  it('a reaching warn among inert findings -> findings (amber)', () =>
    expect(
      deriveDotState(true, {
        ...base,
        findings: [
          f({ id: 'inert', evidence: 'managed setting' }),
          f({ id: 'real', severity: 'warn', title: 'statusline schema changed', evidence: 'cost renamed to totalCostUsd' }),
        ],
      } as never),
    ).toBe('findings'))

  it('a reaching high among inert findings -> high (red)', () =>
    expect(
      deriveDotState(true, {
        ...base,
        findings: [
          f({ id: 'inert', kind: 'info', severity: 'info', title: 'fyi' }),
          f({ id: 'real', severity: 'high', title: 'statusline schema break', evidence: 'cost renamed' }),
        ],
      } as never),
    ).toBe('high'))
})
