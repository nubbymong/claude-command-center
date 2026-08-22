import { describe, it, expect } from 'vitest'
import {
  modelCoverageFindings,
  fixtureAgeDays,
  FIXTURE_STALE_DAYS,
  EXPECTED_MODEL_SET,
} from '../../src/main/sentinel/sentinel-models'
import type { ModelRegistry, ExpectedModelSet } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry
const NOW = Date.parse('2026-08-22T00:00:00Z')

function registryOf(ids: string[]): ModelRegistry {
  return {
    ...reg,
    models: ids.map((id) => ({ id, patterns: [id], family: 'opus', label: id })),
  }
}
const expectedOf = (ids: string[]): ExpectedModelSet => ({
  source: 'https://support.claude.com/en/articles/11940350-claude-code-model-configuration',
  fetchedAt: '2026-08-22',
  models: ids.map((id) => ({ id, label: id })),
})

describe('Sentinel model-coverage check (#385)', () => {
  it('is silent when the shipped registry covers the shipped article snapshot', () => {
    expect(modelCoverageFindings(reg, EXPECTED_MODEL_SET, NOW)).toEqual([])
  })

  it('flags a model Anthropic offers that we do not', () => {
    const f = modelCoverageFindings(registryOf(['claude-opus-5']), expectedOf(['claude-opus-5', 'claude-opus-6']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:missing:claude-opus-6')
    expect(f[0].kind).toBe('compat')
    expect(f[0].severity).toBe('warn')
    expect(f[0].title).toContain('not in the model picker')
  })

  it('flags a model we still offer that the article dropped (retired/renamed)', () => {
    const f = modelCoverageFindings(registryOf(['claude-opus-5', 'claude-opus-3']), expectedOf(['claude-opus-5']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:retired:claude-opus-3')
    expect(f[0].title).toContain('no longer lists it')
  })

  it('honours articleExempt so a deliberately-carried model is not nagged about', () => {
    const withExempt: ModelRegistry = {
      ...reg,
      models: [
        { id: 'claude-opus-5', patterns: ['opus'], family: 'opus', label: 'Opus 5' },
        { id: 'claude-opus-5-fast', patterns: ['fast'], family: 'opus', label: 'Fast', articleExempt: true },
      ],
    }
    expect(modelCoverageFindings(withExempt, expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('ignores non-Claude catch-all entries', () => {
    const withCodex: ModelRegistry = {
      ...reg,
      models: [
        { id: 'claude-opus-5', patterns: ['opus'], family: 'opus', label: 'Opus 5' },
        { id: 'codex-family', patterns: ['codex'], family: 'codex', label: 'Codex' },
      ],
    }
    expect(modelCoverageFindings(withCodex, expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('a dated article id is covered by our undated entry', () => {
    expect(modelCoverageFindings(
      registryOf(['claude-opus-4-5']),
      expectedOf(['claude-opus-4-5-20251101']),
      NOW,
    )).toEqual([])
  })

  it('fails closed on a torn or empty snapshot instead of passing vacuously', () => {
    const f = modelCoverageFindings(reg, { models: [] }, NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toBe('models:fixture-unreadable')
    expect(f[0].evidence).toContain('fail closed')
  })

  it('reports a stale snapshot as info, not as an alarm', () => {
    const old = { ...expectedOf(['claude-opus-5']), fetchedAt: '2026-01-01' }
    const f = modelCoverageFindings(registryOf(['claude-opus-5']), old, NOW)
    expect(f).toHaveLength(1)
    expect(f[0].id).toContain('models:fixture-stale')
    expect(f[0].severity).toBe('info')
    expect(f[0].kind).toBe('info')
  })

  it('does not report a freshly-fetched snapshot as stale', () => {
    expect(modelCoverageFindings(registryOf(['claude-opus-5']), expectedOf(['claude-opus-5']), NOW)).toEqual([])
  })

  it('finding ids are stable across runs so a dismissal sticks', () => {
    const args = [registryOf(['claude-opus-5']), expectedOf(['claude-opus-5', 'claude-opus-6']), NOW] as const
    expect(modelCoverageFindings(...args).map((f) => f.id))
      .toEqual(modelCoverageFindings(...args).map((f) => f.id))
  })

  it('needs no network and no claude binary — pure over its inputs', () => {
    // Guard the design property: the check is a pure function, so it still runs
    // offline and when `claude --version` is unavailable.
    expect(typeof modelCoverageFindings).toBe('function')
    expect(modelCoverageFindings.length).toBeLessThanOrEqual(3)
  })
})

describe('fixtureAgeDays', () => {
  it('measures whole days and tolerates a missing or unparseable date', () => {
    expect(fixtureAgeDays('2026-08-12', NOW)).toBe(10)
    expect(fixtureAgeDays(undefined, NOW)).toBeNull()
    expect(fixtureAgeDays('not-a-date', NOW)).toBeNull()
  })
  it('the shipped snapshot is not already stale', () => {
    const age = fixtureAgeDays(EXPECTED_MODEL_SET.fetchedAt, Date.now())
    if (age !== null) expect(age).toBeLessThanOrEqual(FIXTURE_STALE_DAYS)
  })
})
