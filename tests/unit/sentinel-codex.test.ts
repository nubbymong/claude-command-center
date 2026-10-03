// P3.9 (row 42): Sentinel's Codex version drift finding and the choice of the
// provider its analysis runs on. Pure.
import { describe, it, expect } from 'vitest'
import { codexVersionFindings } from '../../src/main/sentinel/sentinel-codex'
import { askConductorProviderChoice, sentinelAnalysisProvider, ASK_CONDUCTOR_PROVIDER_SETTING } from '../../src/shared/ask-conductor-provider'
import { findingReachesUser } from '../../src/shared/sentinel-reachability'

const RANGE = { minimum: '0.153.4', maximumTested: '0.156.1' }
const NOW = 1_700_000_000_000

describe('Codex version drift against the supported range', () => {
  it('a version inside the range says nothing', () => {
    for (const v of ['0.153.4', '0.155.1', '0.156.1']) {
      expect(codexVersionFindings({ discoveryState: 'found', version: v, compatibility: 'supported' }, RANGE, NOW)).toEqual([])
    }
  })

  it('too old is a severe break: Codex sessions will not start with it', () => {
    const f = codexVersionFindings({ discoveryState: 'found', version: '0.150.0', compatibility: 'too-old' }, RANGE, NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      id: 'codex-version:too-old:0.150.0', kind: 'compat', severity: 'high', surface: 1, provider: 'codex',
      affectedFeature: 'sessions', status: 'open', createdAt: NOW,
      title: 'Codex 0.150.0 is older than AI Code Conductor supports',
      badgeText: 'Needs Codex 0.153.4 or newer, currently 0.150.0',
    })
    expect(f[0].evidence).toContain('AI Code Conductor supports Codex 0.153.4 to 0.156.1.')
    expect(findingReachesUser(f[0])).toBe(true)
  })

  it('newer than tested is a notice the panel shows (warned and allowed, never silently compatible)', () => {
    const f = codexVersionFindings({ discoveryState: 'found', version: '0.157.1', compatibility: 'too-new' }, RANGE, NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      id: 'codex-version:too-new:0.157.1', kind: 'compat', severity: 'warn', provider: 'codex',
      title: 'Codex 0.157.1 is newer than AI Code Conductor was tested with',
      badgeText: 'Tested up to Codex 0.156.1, currently 0.157.1',
    })
    expect(f[0].evidence).toContain('tested with Codex up to 0.156.1')
    expect(findingReachesUser(f[0])).toBe(true)
  })

  it('each version is its own finding (a dismissed one stays dismissed for that version only)', () => {
    const a = codexVersionFindings({ discoveryState: 'found', version: '0.157.1', compatibility: 'too-new' }, RANGE, NOW)[0].id
    const b = codexVersionFindings({ discoveryState: 'found', version: '0.158.0', compatibility: 'too-new' }, RANGE, NOW)[0].id
    expect(a).not.toBe(b)
  })

  it('not found, not read, or not a plain version: nothing (the Accounts row says those)', () => {
    expect(codexVersionFindings(null, RANGE, NOW)).toEqual([])
    expect(codexVersionFindings(undefined, RANGE, NOW)).toEqual([])
    for (const discoveryState of ['missing', 'invalid', 'error', 'unchecked'] as const) {
      expect(codexVersionFindings({ discoveryState, version: '0.150.0', compatibility: 'too-old' }, RANGE, NOW)).toEqual([])
    }
    expect(codexVersionFindings({ discoveryState: 'found', compatibility: 'too-old' }, RANGE, NOW)).toEqual([])
    expect(codexVersionFindings({ discoveryState: 'found', version: '0.150.0 <b>', compatibility: 'too-old' }, RANGE, NOW)).toEqual([])
    expect(codexVersionFindings({ discoveryState: 'found', version: '0.150.0', compatibility: 'unknown' }, RANGE, NOW)).toEqual([])
  })

  it('without a stated range the finding still says what is wrong, without numbers it does not have', () => {
    const old = codexVersionFindings({ discoveryState: 'found', version: '0.150.0', compatibility: 'too-old' }, null, NOW)[0]
    expect(old.badgeText).toBe('Codex 0.150.0 is too old')
    expect(old.evidence).not.toContain('supports Codex')
    const young = codexVersionFindings({ discoveryState: 'found', version: '0.157.1', compatibility: 'too-new' }, { minimum: 'x', maximumTested: 'y' }, NOW)[0]
    expect(young.badgeText).toBe('Codex 0.157.1 is untested')
  })
})

describe("which assistant runs Sentinel's analysis (OD27 M4)", () => {
  it('the one that is on; with both on, the Ask Conductor choice, Claude Code by default', () => {
    expect(sentinelAnalysisProvider(true, false, null)).toBe('claude')
    expect(sentinelAnalysisProvider(false, true, null)).toBe('codex')
    expect(sentinelAnalysisProvider(false, true, { [ASK_CONDUCTOR_PROVIDER_SETTING]: 'claude' })).toBe('codex')
    expect(sentinelAnalysisProvider(true, false, { [ASK_CONDUCTOR_PROVIDER_SETTING]: 'codex' })).toBe('claude')
    expect(sentinelAnalysisProvider(true, true, null)).toBe('claude')
    expect(sentinelAnalysisProvider(true, true, {})).toBe('claude')
    expect(sentinelAnalysisProvider(true, true, { [ASK_CONDUCTOR_PROVIDER_SETTING]: 'codex' })).toBe('codex')
    expect(sentinelAnalysisProvider(false, false, { [ASK_CONDUCTOR_PROVIDER_SETTING]: 'codex' })).toBeNull()
  })

  it('reads the saved choice strictly: only exactly "codex" is Codex', () => {
    expect(ASK_CONDUCTOR_PROVIDER_SETTING).toBe('askConductorProvider')
    for (const v of [undefined, null, '', 'Codex', 'CODEX', 'claude', 1, true, ['codex'], { codex: true }]) {
      expect(askConductorProviderChoice({ askConductorProvider: v }), String(v)).toBe('claude')
    }
    expect(askConductorProviderChoice({ askConductorProvider: 'codex' })).toBe('codex')
    expect(askConductorProviderChoice(null)).toBe('claude')
    expect(askConductorProviderChoice('codex')).toBe('claude')
    // An inherited key is not a saved choice.
    expect(askConductorProviderChoice(Object.create({ askConductorProvider: 'codex' }))).toBe('claude')
  })
})
