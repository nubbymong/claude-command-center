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
import { evaluateModels as gateEvaluate } from '../../scripts/release-gate.mjs'
import { evaluateModelCoverage, type ModelRegistry, type ExpectedModelSet } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'
import expectedJson from '../../resources/claude-code-model-configuration.json'

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
