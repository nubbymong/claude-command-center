import { describe, it, expect } from 'vitest'
import { STEPS } from '../../../src/renderer/onboarding/steps'

describe('onboarding registry', () => {
  it('has 12 steps in the locked order', () => {
    // github precedes statusline (user call 2026-07-01): the status-line
    // page's Copilot preview element only exists once the meter is enabled.
    // codex precedes builtinTools (2026-07-02): the answer drives the Code
    // review card's disabled state and the codex_review tool gate.
    expect(STEPS.map((s) => s.id)).toEqual([
      'whatsNewV2', 'welcome', 'findClaude', 'compatibility', 'accounts',
      'github', 'statusline', 'codex', 'codexSignIn', 'builtinTools',
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

  it('pins every step to the release it was introduced in', () => {
    // FROZEN ON PURPOSE. `sinceVersion` decides who is shown a page after an
    // upgrade: an existing user gets the What's New page plus only the steps
    // newer than the build they last ran (stepsNewSince). Nothing else reads
    // this field, and nothing else can tell you that you got it wrong.
    //
    // The failure mode this catches: adding a step by copying the line above
    // it, inheriting `2.0.0`, and shipping a page that is new to NOBODY who
    // has already onboarded — invisible to every existing user, silently.
    //
    // ADDING A STEP: stamp it with the version it ships in (e.g. '2.2.0'), add
    // it here, and leave ONBOARDING_VERSION alone. Bump that constant only if
    // everyone should re-walk the entire flow. See steps.ts.
    expect(Object.fromEntries(STEPS.map((s) => [s.id, s.sinceVersion]))).toEqual({
      whatsNewV2: '2.0.0',
      welcome: '2.0.0',
      findClaude: '2.0.0',
      compatibility: '2.0.0',
      accounts: '2.0.0',
      github: '2.0.0',
      statusline: '2.0.0',
      codex: '2.0.0',
      codexSignIn: '2.0.0',
      builtinTools: '2.0.0',
      transparency: '2.0.0',
      finish: '2.0.0',
    })
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
