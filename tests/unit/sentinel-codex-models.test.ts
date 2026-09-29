// P3.8 (row 39): Sentinel's model coverage check covers Codex's catalogue too,
// as it covers Claude's (#385). Its reference is the list of models the
// supported Codex CLI itself offers (resources/codex-model-catalogue.json),
// shipped with the build: a model that list names and the registry lacks, a
// Codex model the registry still offers that the list dropped, an unreadable
// list and a stale one are each reported, and nothing else.
import { describe, it, expect } from 'vitest'
import {
  codexModelCoverageFindings,
  CODEX_EXPECTED_MODEL_SET,
  FIXTURE_STALE_DAYS,
} from '../../src/main/sentinel/sentinel-models'
import { mergeRegistry, type ModelRegistry, type ExpectedModelSet } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry
const NOW = Date.parse('2026-10-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const listOf = (ids: string[], fetchedAt = '2026-09-29'): ExpectedModelSet & { cliVersions: string[] } => ({
  source: 'the model catalogue bundled with the Codex CLI', cliVersions: ['0.153.4'], fetchedAt,
  models: ids.map((id) => ({ id, label: id.toUpperCase() })),
})
const CODEX_IDS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']

describe('Sentinel Codex model coverage (row 39)', () => {
  it('is silent when the shipped registry covers the shipped Codex list', () => {
    expect(codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW)).toEqual([])
    expect(CODEX_EXPECTED_MODEL_SET.models.map((m) => m.id)).toEqual(CODEX_IDS)
  })

  it('reports a model the Codex CLI lists that the picker does not offer', () => {
    const f = codexModelCoverageFindings(reg, listOf([...CODEX_IDS, 'gpt-6-nova']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'models:codex-missing:gpt-6-nova', kind: 'compat', severity: 'warn', affectedFeature: 'sessions', status: 'open', createdAt: NOW })
    expect(f[0].title).toBe('Codex offers GPT-6-NOVA, but it is not in the model picker')
    expect(f[0].evidence).toContain('the Codex model list shipped with this build (Codex 0.153.4, 2026-09-29)')
  })

  it('reports a Codex model the picker still offers that the list no longer names', () => {
    const f = codexModelCoverageFindings(reg, listOf(CODEX_IDS.filter((id) => id !== 'gpt-5.2')), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'models:codex-retired:gpt-5.2', kind: 'compat', severity: 'warn', affectedFeature: 'sessions' })
    expect(f[0].title).toBe('GPT-5.2 is still selectable but Codex no longer lists it')
  })

  it('never reports a Codex model an overlay added, or any Claude model', () => {
    const merged = mergeRegistry(reg, { models: [{ id: 'gpt-6-nova', patterns: [], family: 'codex', label: 'GPT-6-Nova', provenance: { addedBy: 'user', date: '2026-09-29' } }] })
    expect(codexModelCoverageFindings(merged, CODEX_EXPECTED_MODEL_SET, NOW)).toEqual([])
    expect(codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW).some((x) => x.id.includes('claude-'))).toBe(false)
  })

  // P3.8 round 2 (GS): an id the registry lists twice is reported as such
  // (the pickers would disagree about it), not as "could not be verified".
  it('reports a Codex id the registry lists more than once', () => {
    const dup = { ...reg, models: [{ id: 'gpt-5.5', patterns: [], family: 'opus', label: 'GPT-5.5 (Claude row)' }, ...reg.models] } as unknown as ModelRegistry
    const f = codexModelCoverageFindings(dup, CODEX_EXPECTED_MODEL_SET, NOW)
    expect(f.map((x) => x.id)).toContain('models:codex-duplicate:gpt-5.5')
    expect(f.map((x) => x.id)).not.toContain('models:codex-list-unreadable')
    expect(f.map((x) => x.id)).not.toContain('models:codex-missing:gpt-5.5')
    // A duplicated Codex id the list does not name: still its own finding, not "could not be verified".
    const unlisted = { ...reg, models: [...reg.models, { id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7' }, { id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7' }] } as unknown as ModelRegistry
    const g = codexModelCoverageFindings(unlisted, CODEX_EXPECTED_MODEL_SET, NOW).map((x) => x.id)
    expect(g).toContain('models:codex-duplicate:gpt-7')
    expect(g).not.toContain('models:codex-list-unreadable')
    expect(f.find((x) => x.id === 'models:codex-duplicate:gpt-5.5')!.title).toBe('gpt-5.5 is in the model registry more than once')
  })

  it('an empty or missing list is one "could not be verified" finding, not a wall of retired models (fail closed)', () => {
    for (const expected of [null, undefined, listOf([])]) {
      const f = codexModelCoverageFindings(reg, expected, NOW)
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ id: 'models:codex-list-unreadable', kind: 'compat', severity: 'warn', title: 'The Codex model list could not be verified' })
    }
  })

  it('says when the shipped list is older than the stale limit, and only then', () => {
    const at = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10)
    expect(codexModelCoverageFindings(reg, listOf(CODEX_IDS, at(FIXTURE_STALE_DAYS)), NOW)).toEqual([])
    const f = codexModelCoverageFindings(reg, listOf(CODEX_IDS, at(FIXTURE_STALE_DAYS + 1)), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: `models:codex-list-stale:${at(FIXTURE_STALE_DAYS + 1)}`, kind: 'info', severity: 'info' })
    expect(f[0].title).toBe('The Codex model list has not been re-checked in a while')
  })
})
