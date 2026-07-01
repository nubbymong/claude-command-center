import { describe, it, expect } from 'vitest'
import { STEPS } from '../../../src/renderer/onboarding/steps'

describe('onboarding registry', () => {
  it('has 12 steps in the locked order', () => {
    // github precedes statusline (user call 2026-07-01): the status-line
    // page's Copilot preview element only exists once the meter is enabled.
    expect(STEPS.map((s) => s.id)).toEqual([
      'whatsNewV2', 'welcome', 'findClaude', 'compatibility', 'accounts',
      'github', 'statusline', 'builtinTools', 'codex', 'codexSignIn',
      'transparency', 'finish',
    ])
  })

  it('has unique ids', () => {
    const ids = STEPS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every step has a valid sinceVersion', () => {
    for (const s of STEPS) expect(s.sinceVersion).toMatch(/^\d+\.\d+/)
  })

  it('finish is not a setup step', () => {
    expect(STEPS.find((s) => s.id === 'finish')?.requiresSetup).toBe(false)
  })

  it('only codexSignIn is conditional (has a when predicate)', () => {
    expect(STEPS.filter((s) => s.when).map((s) => s.id)).toEqual(['codexSignIn'])
  })

  it('codexSignIn.when is true only when codexEnabled is true', () => {
    const codexSignIn = STEPS.find((s) => s.id === 'codexSignIn')!
    expect(codexSignIn.when!({ codexEnabled: true })).toBe(true)
    expect(codexSignIn.when!({ codexEnabled: false })).toBe(false)
    expect(codexSignIn.when!({})).toBe(false)
  })
})
