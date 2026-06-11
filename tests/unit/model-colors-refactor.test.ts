import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import type { ModelRegistry } from '../../src/shared/model-registry'
import { getModelColor, getModelShort } from '../../src/renderer/components/tokenomics/modelColors'

const reg = baselineJson as unknown as ModelRegistry

describe('getModelColor parity (registry-backed)', () => {
  it.each([
    ['claude-fable-5', 'var(--chart-fable)'],
    ['claude-opus-4-8', 'var(--chart-opus)'],
    ['claude-sonnet-4-6', 'var(--chart-sonnet)'],
    ['gpt-5.5', 'var(--chart-codex)'],
    ['o3', 'var(--chart-codex)'],
    ['claude-haiku-4-5', 'var(--chart-other)'],
  ])('%s', (m, c) => expect(getModelColor(m, reg)).toBe(c))
  it('unknown model gets a deterministic hashed hex, not chart-other', () => {
    expect(getModelColor('zz-mystery-9', reg)).toMatch(/^#/)
    expect(getModelColor('zz-mystery-9', reg)).toBe(getModelColor('zz-mystery-9', reg))
  })
})

describe('getModelShort parity', () => {
  it.each([
    ['claude-sonnet-4-6', 'sonnet'], ['Claude-Opus-4-8', 'opus'],
    ['claude-haiku-4-5', 'haiku'], ['claude-fable-5', 'fable'],
    ['gpt-5.5', '5.5'],
    ['o3-codex', 'o3-codex'],
    ['mystery-model', 'mystery-model'],
  ])('%s -> %s', (m, s) => expect(getModelShort(m, reg)).toBe(s))
})
