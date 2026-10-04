import { describe, it, expect } from 'vitest'
import { deriveDotState, dotTooltip } from '../../src/renderer/components/sentinel/SentinelDot'

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

// PR 4 (owner answers review, E-S3): after an analysis that did not complete,
// the title-bar chip says so instead of "no issues found". [host]
describe('a failed analysis on the title-bar chip', () => {
  const failed = { ...base, lastAnalysisFailed: true, lastAnalysisError: 'AI analysis could not reach its service: Connection error. Check the network, a proxy or a firewall, then use Re-run. The deterministic checks still ran.' }
  it('no finding reaching the setup -> incomplete, and the tooltip says the analysis did not complete [host]', () => {
    expect(deriveDotState(true, failed as never)).toBe('incomplete')
    expect(dotTooltip('incomplete', failed as never)).toBe('Sentinel: the last analysis did not complete. Open for details.')
    expect(dotTooltip('incomplete', failed as never)).not.toMatch(/no issues found/)
  })
  it('open findings that reach nothing do not claim a review the analysis did not finish [host]', () =>
    expect(deriveDotState(true, { ...failed, findings: [f({ severity: 'info' })] } as never)).toBe('incomplete'))
  it('a finding that reaches the setup still raises its colour; analyzing still wins [host]', () => {
    expect(deriveDotState(true, { ...failed, findings: [f({ severity: 'high' })] } as never)).toBe('high')
    expect(deriveDotState(true, { ...failed, findings: [f({})] } as never)).toBe('findings')
    expect(deriveDotState(true, { ...failed, analyzing: true } as never)).toBe('analyzing')
  })
  it('a completed analysis with nothing found still says no issues found [host]', () =>
    expect(dotTooltip('ok', base as never)).toBe('Sentinel: no issues found'))
  // Owner answers review (E-S6): lastAnalysisError also carries messages that are not a
  // failed analysis; only a failed one makes the chip say "did not complete".
  it('a message that is not a failed analysis (unmatched findings, a refusal, a carried problem) leaves the chip as it was [host]', () => {
    for (const msg of [
      'One finding from the analysis of Claude Code 2.1.300 could not be matched to its changelog, so it is not shown and the update will be analysed again at the next check.',
      'Claude Code is off. Turn it on in Settings, Accounts.',
      'claude --version unavailable',
    ]) {
      expect(deriveDotState(true, { ...base, lastAnalysisError: msg } as never), msg).toBe('ok')
      expect(deriveDotState(true, { ...base, lastAnalysisError: msg, lastAnalysisFailed: false, findings: [f({ severity: 'info' })] } as never), msg).toBe('reviewed')
    }
  })
})
