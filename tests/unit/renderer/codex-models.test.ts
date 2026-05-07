import { describe, it, expect } from 'vitest'
import { CODEX_MODELS } from '../../../src/renderer/codex-models'

describe('CODEX_MODELS', () => {
  it('exports the canonical six-model array in display order', () => {
    expect(CODEX_MODELS).toEqual([
      'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2',
    ])
  })

  it('readonly tuple type narrows correctly', () => {
    const m: typeof CODEX_MODELS[number] = 'gpt-5.5'
    expect(m).toBe('gpt-5.5')
  })
})
