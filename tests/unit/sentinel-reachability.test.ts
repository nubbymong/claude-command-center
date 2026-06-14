import { describe, it, expect } from 'vitest'
import { findingReachesUser } from '../../src/shared/sentinel-reachability'
import type { SentinelFinding } from '../../src/shared/sentinel-types'

const f = (over: Partial<SentinelFinding>): SentinelFinding => ({
  id: 'x',
  kind: 'compat',
  severity: 'warn',
  title: 't',
  evidence: 'e',
  status: 'open',
  createdAt: 1,
  ...over,
})

describe('findingReachesUser', () => {
  it('a generic compat warn/high reaches the user (default actionable)', () => {
    expect(findingReachesUser(f({ severity: 'warn' }))).toBe(true)
    expect(findingReachesUser(f({ severity: 'high' }))).toBe(true)
  })

  it('info severity is never alarming (FYI only)', () => {
    expect(findingReachesUser(f({ severity: 'info' }))).toBe(false)
  })

  it('info-kind and registry-proposal findings never alarm', () => {
    expect(findingReachesUser(f({ kind: 'info', severity: 'warn' }))).toBe(false)
    expect(findingReachesUser(f({ kind: 'registry-proposal', severity: 'warn' }))).toBe(false)
  })

  it('managed-settings-only changes do not reach a non-managed account', () => {
    const managed = f({
      title: 'enforceAvailableModels constrains --model flag resolution system-wide',
      evidence:
        'Added `enforceAvailableModels` managed setting — when enabled, the `availableModels` allowlist also constrains the Default model',
    })
    expect(findingReachesUser(managed)).toBe(false)
    // ...but DOES reach a managed account.
    expect(findingReachesUser(managed, { accountManaged: true })).toBe(true)
  })

  it('changes to model-redirect env vars CCC never sets do not reach it (literal glob in changelog)', () => {
    const envFinding = f({
      title: 'ANTHROPIC_DEFAULT_*_MODEL env vars blocked from redirecting model aliases',
      evidence:
        'alias model picks can no longer be redirected to a blocked model via `ANTHROPIC_DEFAULT_*_MODEL` environment variables',
    })
    // Even on a managed account it is inert — CCC simply never sets these.
    expect(findingReachesUser(envFinding)).toBe(false)
    expect(findingReachesUser(envFinding, { accountManaged: true })).toBe(false)
  })

  it('a real, reachable break is NOT downgraded (no inert markers)', () => {
    const realBreak = f({
      severity: 'high',
      title: 'statusline JSON schema changed: cost field renamed',
      evidence: 'The statusline payload now emits `totalCostUsd` instead of `cost`',
    })
    expect(findingReachesUser(realBreak)).toBe(true)
  })
})
