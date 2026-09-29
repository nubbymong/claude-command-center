/**
 * #385 -- the model-coverage comparison exists TWICE and must not drift.
 *
 * The release gate (scripts/release-gate.mjs) is dependency-free ESM that runs
 * on a bare CI runner before `npm ci`, so it cannot import the app's TypeScript;
 * it carries its own copy of the comparison. The Sentinel check uses the shared
 * TS implementation. Two copies of a safety rule is how one of them quietly
 * stops matching the other, so this file runs BOTH over the same inputs and
 * requires identical verdicts.
 */
import { describe, it, expect } from 'vitest'
import { evaluateModels as gateEvaluate, evaluateCodexModels as gateEvaluateCodex } from '../../scripts/release-gate.mjs'
import { evaluateModelCoverage, evaluateCodexModelCoverage, type ModelRegistry, type ExpectedModelSet } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'
import expectedJson from '../../resources/claude-code-model-configuration.json'
import codexCatalogueJson from '../../resources/codex-model-catalogue.json'

const shippedRegistry = baselineJson as unknown as ModelRegistry
const shippedExpected = expectedJson as unknown as ExpectedModelSet

const mk = (ids: string[], extra: Partial<ModelRegistry> = {}): ModelRegistry => ({
  models: ids.map((id) => ({ id, patterns: [id], family: 'opus', label: id })),
  families: {}, effortLevels: [], dropdown: [], ...extra,
})
const exp = (ids: string[]): ExpectedModelSet => ({ models: ids.map((id) => ({ id, label: id })) })

const CASES: { name: string; registry: ModelRegistry; expected: ExpectedModelSet }[] = [
  { name: 'the shipped pair', registry: shippedRegistry, expected: shippedExpected },
  { name: 'exact cover', registry: mk(['claude-opus-5']), expected: exp(['claude-opus-5']) },
  { name: 'a missing model', registry: mk(['claude-opus-5']), expected: exp(['claude-opus-5', 'claude-opus-6']) },
  { name: 'an extra model', registry: mk(['claude-opus-5', 'claude-opus-3']), expected: exp(['claude-opus-5']) },
  { name: 'dated article id vs undated entry', registry: mk(['claude-opus-4-5']), expected: exp(['claude-opus-4-5-20251101']) },
  { name: 'a non-claude entry is not the article\'s business', registry: mk(['claude-opus-5', 'codex-family']), expected: exp(['claude-opus-5']) },
  { name: 'empty expected set (fails closed)', registry: mk(['claude-opus-5']), expected: exp([]) },
  { name: 'everything missing', registry: mk([]), expected: exp(['claude-opus-5', 'claude-sonnet-5']) },
  {
    name: 'articleExempt suppresses the extra',
    registry: { ...mk(['claude-opus-5']), models: [
      { id: 'claude-opus-5', patterns: ['a'], family: 'opus', label: 'Opus 5' },
      { id: 'claude-opus-5-fast', patterns: ['b'], family: 'opus', label: 'Fast', articleExempt: true },
    ] },
    expected: exp(['claude-opus-5']),
  },
]

describe('release gate and shared model-coverage agree (#385)', () => {
  for (const c of CASES) {
    it(`identical verdict: ${c.name}`, () => {
      const gate = gateEvaluate({ registry: c.registry, expected: c.expected })
      const shared = evaluateModelCoverage(c.registry, c.expected)
      expect(shared.ok).toBe(gate.ok)
      expect(shared.missing.map((m) => m.id)).toEqual(gate.missing.map((m: { id: string }) => m.id))
      expect(shared.extra.map((m) => m.id)).toEqual(gate.extra.map((m: { id: string }) => m.id))
      expect(shared.covered.map((m) => `${m.id}<-${m.by}`))
        .toEqual(gate.covered.map((m: { id: string; by: string }) => `${m.id}<-${m.by}`))
      expect(shared.reason).toBe(gate.reason)
    })
  }

  it('the shipped registry satisfies the shipped article snapshot', () => {
    // This is the state the release gate requires before a beta/rc can be cut.
    const shared = evaluateModelCoverage(shippedRegistry, shippedExpected)
    expect(shared.missing).toEqual([])
    expect(shared.extra).toEqual([])
    expect(shared.ok).toBe(true)
    expect(shared.covered).toHaveLength(shippedExpected.models.length)
  })

  it('every article model is selectable in the picker, not merely present', () => {
    // Coverage in `models` is what the gate checks; the point of #385 is that
    // it also reaches the UI.
    const rows = new Set(
      shippedRegistry.models.filter((m) => m.pickable !== false).map((m) => m.id),
    )
    for (const m of shippedExpected.models) {
      const covered = [...rows].some((id) => m.id === id || m.id.startsWith(`${id}-`))
      expect(covered, `${m.id} is not offered by the picker`).toBe(true)
    }
  })
})

// P3.8 round 1 (G1): the Codex half. The gate carries its own copy of
// evaluateCodexModelCoverage (the registry's pickable codex-family models
// against resources/codex-model-catalogue.json, exact ids, overlay entries
// never "extra", fail closed on an empty list); the same rule: identical
// verdicts over the same inputs.
const shippedCodexList = codexCatalogueJson as unknown as ExpectedModelSet
const cx = (ids: string[], over: Record<string, unknown> = {}) =>
  ids.map((id) => ({ id, patterns: [id], family: 'codex', label: id.toUpperCase(), ...over }))
const reg = (models: unknown[]): ModelRegistry => ({ models, families: {}, effortLevels: [], dropdown: [] } as unknown as ModelRegistry)

const CODEX_CASES: { name: string; registry: ModelRegistry; expected: ExpectedModelSet }[] = [
  { name: 'the shipped pair', registry: shippedRegistry, expected: shippedCodexList },
  { name: 'exact cover', registry: reg(cx(['gpt-5.5'])), expected: exp(['gpt-5.5']) },
  { name: 'a missing model', registry: reg(cx(['gpt-5.5'])), expected: exp(['gpt-5.5', 'gpt-6-astra']) },
  { name: 'an extra model', registry: reg(cx(['gpt-5.5', 'gpt-5.2'])), expected: exp(['gpt-5.5']) },
  { name: 'no date-suffix cover for Codex ids', registry: reg(cx(['gpt-5.5'])), expected: exp(['gpt-5.5-20260101']) },
  { name: 'a Claude-family entry with the id does not cover it', registry: reg([{ id: 'gpt-5.5', patterns: ['x'], family: 'opus', label: 'x' }]), expected: exp(['gpt-5.5']) },
  { name: 'a non-pickable Codex entry neither covers nor is extra', registry: reg([...cx(['gpt-5.5']), ...cx(['codex-family'], { pickable: false })]), expected: exp(['gpt-5.5', 'codex-family']) },
  { name: 'an overlay Codex entry covers but is never extra', registry: reg([...cx(['gpt-5.5']), ...cx(['gpt-7'], { provenance: { source: 'user', addedAt: '2026-09-29' } })]), expected: exp(['gpt-5.5']) },
  { name: 'unusable registry entries are skipped', registry: reg([null, { family: 'codex' }, { id: '', family: 'codex' }, ...cx(['gpt-5.5'])]), expected: exp(['gpt-5.5']) },
  { name: 'unusable list entries are skipped', registry: reg(cx(['gpt-5.5'])), expected: { models: [null, { id: '' }, { label: 'x' }, { id: 'gpt-5.5', label: 'GPT-5.5' }] } as unknown as ExpectedModelSet },
  { name: 'empty list (fails closed)', registry: reg(cx(['gpt-5.5'])), expected: exp([]) },
  { name: 'a list of only unusable entries (fails closed)', registry: reg(cx(['gpt-5.5'])), expected: { models: [{ id: '' }] } as unknown as ExpectedModelSet },
  { name: 'everything missing', registry: reg([]), expected: exp(['gpt-5.5', 'gpt-6-astra']) },
]

describe('release gate and shared Codex model coverage agree (P3.8 G1)', () => {
  for (const c of CODEX_CASES) {
    it(`identical verdict: ${c.name}`, () => {
      const gate = gateEvaluateCodex({ registry: c.registry, expected: c.expected })
      const shared = evaluateCodexModelCoverage(c.registry, c.expected)
      expect(shared.ok).toBe(gate.ok)
      expect(shared.missing.map((m) => m.id)).toEqual(gate.missing.map((m: { id: string }) => m.id))
      expect(shared.extra.map((m) => m.id)).toEqual(gate.extra.map((m: { id: string }) => m.id))
      expect(shared.covered.map((m) => `${m.id}<-${m.by}`))
        .toEqual(gate.covered.map((m: { id: string; by: string }) => `${m.id}<-${m.by}`))
      expect(shared.reason).toBe(gate.reason)
    })
  }

  it('the verdicts are the expected ones, not merely equal', () => {
    const v = (c: string) => gateEvaluateCodex(CODEX_CASES.find((x) => x.name === c)!)
    expect(v('exact cover').ok).toBe(true)
    expect(v('a missing model').missing.map((m: { id: string }) => m.id)).toEqual(['gpt-6-astra'])
    expect(v('an extra model').extra.map((m: { id: string }) => m.id)).toEqual(['gpt-5.2'])
    expect(v('an extra model').ok).toBe(true)
    expect(v('no date-suffix cover for Codex ids').ok).toBe(false)
    expect(v('a Claude-family entry with the id does not cover it').ok).toBe(false)
    expect(v('a non-pickable Codex entry neither covers nor is extra').missing.map((m: { id: string }) => m.id)).toEqual(['codex-family'])
    expect(v('an overlay Codex entry covers but is never extra').extra).toEqual([])
    expect(v('unusable list entries are skipped').ok).toBe(true)
    expect(v('empty list (fails closed)').ok).toBe(false)
    expect(v('a list of only unusable entries (fails closed)').ok).toBe(false)
  })

  it('the shipped registry satisfies the shipped Codex list', () => {
    const gate = gateEvaluateCodex({ registry: shippedRegistry, expected: shippedCodexList })
    expect(gate.missing).toEqual([])
    expect(gate.extra).toEqual([])
    expect(gate.ok).toBe(true)
    expect(gate.covered).toHaveLength(shippedCodexList.models.length)
  })
})
