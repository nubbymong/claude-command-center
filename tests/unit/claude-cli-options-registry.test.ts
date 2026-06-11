import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import type { ModelRegistry } from '../../src/shared/model-registry'
import { modelsFromRegistry, effortsFromRegistry } from '../../src/renderer/lib/claude-cli-options'

const reg = baselineJson as unknown as ModelRegistry

describe('registry-derived option lists (parity with the old hardcoded arrays)', () => {
  it('models match the old MODELS rows in order', () => {
    expect(modelsFromRegistry(reg)).toEqual([
      { label: 'Opus', value: 'opus', hint: 'Latest Opus (200k context)' },
      { label: 'Opus 1M', value: 'opus[1m]', hint: 'Latest Opus (1M context)' },
      { label: 'Fable 5', value: 'fable', hint: 'Most capable · ~2x faster than Opus' },
      { label: 'Sonnet', value: 'sonnet', hint: 'Latest Sonnet' },
      { label: 'Haiku', value: 'haiku', hint: 'Latest Haiku' },
    ])
  })
  it('efforts match the old EFFORTS rows in order, hints included', () => {
    const efforts = effortsFromRegistry(reg)
    expect(efforts.map((e) => e.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(efforts.find((e) => e.value === 'ultracode')!.hint).toContain('dynamic workflows')
  })
})
