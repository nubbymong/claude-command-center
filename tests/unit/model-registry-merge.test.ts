import { describe, it, expect } from 'vitest'
import {
  mergeRegistry, reconcileOverlay,
  type ModelRegistry, type RegistryOverlay, type OverlayModelEntry,
} from '../../src/shared/model-registry'

const baseline: ModelRegistry = {
  models: [
    { id: 'claude-opus-4-8', patterns: ['opus'], aliases: ['opus'], family: 'opus', label: 'Opus 4.8',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      fallbackPricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  ],
  families: { opus: { label: 'opus', color: 'var(--chart-opus)' } },
  effortLevels: [{ value: 'low', label: 'Low' }],
  dropdown: [{ value: 'opus', label: 'Opus', hint: 'Latest Opus (200k context)' }],
}

const sentinelEntry: OverlayModelEntry = {
  id: 'claude-fable-6', patterns: ['fable-6'], family: 'fable', label: 'Fable 6',
  provenance: { addedBy: 'sentinel', date: '2026-06-11', ccVersion: '2.1.0', cccVersion: '1.5.36' },
}
const userEntry: OverlayModelEntry = {
  ...sentinelEntry, id: 'claude-opus-4-8', label: 'My Opus',
  provenance: { addedBy: 'user', date: '2026-06-11' },
}

describe('mergeRegistry', () => {
  it('adds overlay models not in baseline', () => {
    const merged = mergeRegistry(baseline, { models: [sentinelEntry] })
    expect(merged.models.map((m) => m.id)).toContain('claude-fable-6')
  })
  it('overlay wins per id over baseline', () => {
    const merged = mergeRegistry(baseline, { models: [userEntry] })
    expect(merged.models.find((m) => m.id === 'claude-opus-4-8')!.label).toBe('My Opus')
    expect(merged.models.filter((m) => m.id === 'claude-opus-4-8')).toHaveLength(1)
  })
  it('merges overlay families, overlay wins', () => {
    const merged = mergeRegistry(baseline, { families: { fable: { label: 'fable', color: '#abc' } } })
    expect(merged.families.fable.color).toBe('#abc')
    expect(merged.families.opus.color).toBe('var(--chart-opus)')
  })
  it('null/empty overlay returns baseline equivalent', () => {
    expect(mergeRegistry(baseline, null).models).toHaveLength(1)
  })
})

describe('reconcileOverlay', () => {
  it('auto-retires sentinel entries whose id now exists in baseline', () => {
    const overlay: RegistryOverlay = { models: [{ ...sentinelEntry, id: 'claude-opus-4-8' }] }
    const r = reconcileOverlay(baseline, overlay)
    expect(r.autoRetired.map((m) => m.id)).toEqual(['claude-opus-4-8'])
    expect(r.overlay.models ?? []).toHaveLength(0)
  })
  it('never auto-retires user entries — proposes instead', () => {
    const r = reconcileOverlay(baseline, { models: [userEntry] })
    expect(r.autoRetired).toHaveLength(0)
    expect(r.retireProposals.map((m) => m.id)).toEqual(['claude-opus-4-8'])
    expect(r.overlay.models).toHaveLength(1)
  })
  it('keeps sentinel entries baseline does not cover', () => {
    const r = reconcileOverlay(baseline, { models: [sentinelEntry] })
    expect(r.autoRetired).toHaveLength(0)
    expect(r.overlay.models).toHaveLength(1)
  })
})
