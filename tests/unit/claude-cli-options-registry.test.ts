import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import type { ModelRegistry } from '../../src/shared/model-registry'
import {
  modelsFromRegistry,
  modelGroupsFromRegistry,
  effortsFromRegistry,
  effortsForModel,
} from '../../src/renderer/lib/claude-cli-options'

const reg = baselineJson as unknown as ModelRegistry

describe('registry-derived option lists', () => {
  it('opens with the alias rows, in the curated dropdown order', () => {
    // The alias rows are the old hardcoded MODELS array and still come first —
    // "Opus" always means the newest Opus.
    expect(modelsFromRegistry(reg).slice(0, 5)).toEqual([
      { label: 'Opus', value: 'opus', hint: 'Latest Opus (200k context)' },
      { label: 'Opus 1M', value: 'opus[1m]', hint: 'Latest Opus (1M context)' },
      { label: 'Fable 5', value: 'fable', hint: 'Most capable · ~2x faster than Opus' },
      { label: 'Sonnet', value: 'sonnet', hint: 'Latest Sonnet' },
      { label: 'Haiku', value: 'haiku', hint: 'Latest Haiku' },
    ])
  })

  it('offers the pinned versions after them — the #385 regression', () => {
    const values = modelsFromRegistry(reg).map((m) => m.value)
    // The reported symptom: Opus 4.6 could not be selected at all.
    expect(values).toContain('claude-opus-4-6')
    expect(values).toContain('claude-opus-4-8')
    expect(values).toContain('claude-sonnet-4-6')
    expect(values).toContain('claude-haiku-4-5')
    // Alias rows still lead.
    expect(values.indexOf('claude-opus-4-6')).toBeGreaterThan(values.indexOf('haiku'))
  })

  it('never offers a non-launchable catch-all id', () => {
    expect(modelsFromRegistry(reg).map((m) => m.value)).not.toContain('codex-family')
  })

  it('groups alias rows under "Latest" and pins under their family', () => {
    const groups = modelGroupsFromRegistry(reg)
    expect(groups[0].title).toBe('Latest')
    expect(groups[0].items).toHaveLength(5)
    const titles = groups.map((g) => g.title)
    expect(titles).toEqual(['Latest', 'Opus', 'Fable', 'Sonnet', 'Haiku'])
    const opus = groups.find((g) => g.title === 'Opus')!
    expect(opus.items.map((i) => i.value)).toEqual([
      'claude-opus-5', 'claude-opus-4-8-fast', 'claude-opus-4-8',
      'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
    ])
    expect(opus.items.find((i) => i.value === 'claude-opus-4-6')!.label).toBe('Opus 4.6')
  })

  it('efforts match the old EFFORTS rows in order, hints included', () => {
    const efforts = effortsFromRegistry(reg)
    expect(efforts.map((e) => e.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(efforts.find((e) => e.value === 'ultracode')!.hint).toContain('dynamic workflows')
  })

  it('disables effort levels a pinned model does not offer, and hides none', () => {
    // Haiku 4.5 carries efforts low/medium/high only.
    const haiku = effortsForModel(reg, 'claude-haiku-4-5')
    expect(haiku).toHaveLength(6)
    expect(haiku.filter((e) => !e.disabled).map((e) => e.value)).toEqual(['low', 'medium', 'high'])
    expect(haiku.find((e) => e.value === 'ultracode')!.disabled).toBe(true)
    // Opus 4.6 has no ultracode.
    expect(effortsForModel(reg, 'claude-opus-4-6').find((e) => e.value === 'ultracode')!.disabled).toBe(true)
    expect(effortsForModel(reg, 'claude-opus-4-6').find((e) => e.value === 'max')!.disabled).toBeUndefined()
  })

  it('enables everything when the model is unknown or only fuzzily matched', () => {
    // spec §3: unknown efforts = assume valid.
    for (const id of ['some-future-model', 'Opus 4.6', 'claude-opus-5', '']) {
      expect(effortsForModel(reg, id).every((e) => !e.disabled)).toBe(true)
    }
  })
})
