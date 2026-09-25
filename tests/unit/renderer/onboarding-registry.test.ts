import { describe, it, expect } from 'vitest'
import { STEPS } from '../../../src/renderer/onboarding/steps'

describe('onboarding registry', () => {
  it('has 14 steps in the locked order', () => {
    // github precedes statusline (user call 2026-07-01): the status-line
    // page's Copilot preview element only exists once the meter is enabled.
    // commandBar follows welcome (2026-08-22, #382): the one-row bar page,
    // new in 2.1.0-beta.17, sits with the other "what this is" pages.
    // WP2 (2.1.1): assistants follows welcome; codexSetup follows the Claude
    // account page and replaces the legacy codex and codexSignIn pages.
    // WP2 commit 6f: helloCodex, the Codex introduction, follows codexSetup.
    expect(STEPS.map((s) => s.id)).toEqual([
      'whatsNewV2', 'welcome', 'assistants', 'commandBar', 'findClaude', 'compatibility', 'accounts',
      'codexSetup', 'helloCodex', 'github', 'statusline', 'builtinTools',
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
      assistants: '2.1.1',
      commandBar: '2.1.0-beta.17',
      findClaude: '2.0.0',
      compatibility: '2.0.0',
      accounts: '2.0.0',
      codexSetup: '2.1.1',
      helloCodex: '2.1.1',
      github: '2.0.0',
      statusline: '2.0.0',
      builtinTools: '2.0.0',
      transparency: '2.0.0',
      finish: '2.0.0',
    })
  })

  it('finish is not a setup step', () => {
    expect(STEPS.find((s) => s.id === 'finish')?.requiresSetup).toBe(false)
  })

  it('the conditional steps are Claude Code\'s own pages, Codex setup and the Codex introduction', () => {
    expect(STEPS.filter((s) => s.when).map((s) => s.id)).toEqual(['findClaude', 'compatibility', 'accounts', 'codexSetup', 'helloCodex', 'statusline'])
  })

  it('Claude Code\'s pages follow claudeEnabled (absent = on); codexSetup and helloCodex only when codexEnabled is true', () => {
    for (const id of ['findClaude', 'compatibility', 'accounts', 'statusline']) {
      const step = STEPS.find((s) => s.id === id)!
      expect(step.when!({}), id).toBe(true)
      expect(step.when!({ claudeEnabled: true }), id).toBe(true)
      expect(step.when!({ claudeEnabled: false, codexEnabled: true }), id).toBe(false)
    }
    for (const id of ['codexSetup', 'helloCodex']) {
      const step = STEPS.find((s) => s.id === id)!
      expect(step.when!({ codexEnabled: true }), id).toBe(true)
      expect(step.when!({ codexEnabled: false }), id).toBe(false)
      expect(step.when!({}), id).toBe(false)
    }
  })

  it('only the assistants choice, Codex setup and the Codex introduction are fresh-install only, and none asks for setup', () => {
    // requiresSetup false: a completed upgrader, who lacks them in
    // completedSteps, must not be made due by them (deriveOnboarding). The
    // Codex introduction reaches upgraders as the one-time takeover instead.
    expect(STEPS.filter((s) => s.freshInstallOnly).map((s) => s.id)).toEqual(['assistants', 'codexSetup', 'helloCodex'])
    for (const s of STEPS.filter((x) => x.freshInstallOnly)) expect(s.requiresSetup, s.id).toBe(false)
  })

  it('the legacy Codex pages have left the flow', () => {
    const ids = STEPS.map((s) => s.id)
    expect(ids).not.toContain('codex')
    expect(ids).not.toContain('codexSignIn')
  })
})
