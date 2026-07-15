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

describe('getModelShort: versioned registry labels (user report 2026-06-12)', () => {
  // Per-model labels, NOT the family chartLabel: the split rows are per model
  // id, so the family label rendered several categories all named "opus".
  it.each([
    ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'],
    ['claude-haiku-4-5', 'Haiku 4.5'], ['claude-fable-5', 'Fable 5'],
    // Mixed case misses the case-sensitive exact/prefix tiers and lands on the
    // fuzzy pattern tier -> family label (never a wrongly-claimed version).
    ['Claude-Opus-4-8', 'opus'],
    ['gpt-5.5', '5.5'],
    ['o3-codex', 'o3-codex'],
    ['mystery-model', 'mystery-model'],
    // CLI-fabricated transcript messages (errors, interruptions) carry the
    // literal model id "<synthetic>" — never show that raw to users.
    ['<synthetic>', 'System'],
  ])('%s -> %s', (m, s) => expect(getModelShort(m, reg)).toBe(s))

  it('distinct opus versions get DISTINCT labels', () => {
    const labels = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'].map((m) => getModelShort(m, reg))
    expect(new Set(labels).size).toBe(3)
  })
})
