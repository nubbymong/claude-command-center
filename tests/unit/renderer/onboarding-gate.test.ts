import { describe, it, expect } from 'vitest'
import { deriveOnboarding, type OnboardingMetaView } from '../../../src/renderer/onboarding/gate'
import { STEPS, ONBOARDING_VERSION } from '../../../src/renderer/onboarding/steps'
import type { OnboardingStep } from '../../../src/renderer/onboarding/steps'

const ALL_IDS = STEPS.map((s) => s.id)
/** Stamp every step done except those listed (value is irrelevant — presence is what counts). */
const stampedExcept = (skip: string[] = []): Record<string, string> =>
  Object.fromEntries(ALL_IDS.filter((id) => !skip.includes(id)).map((id) => [id, '2.0.0']))

describe('deriveOnboarding', () => {
  it('fresh install -> full flow; codexSignIn excluded while codex is off', () => {
    const { due, steps } = deriveOnboarding({}, {})
    expect(due).toBe(true)
    expect(steps.map((s) => s.id)).toEqual(ALL_IDS.filter((id) => id !== 'codexSignIn'))
  })

  it('v1->v2 updater (populated legacy meta, no onboarding fields) -> full flow', () => {
    // A real v1 AppMeta carries setupVersion/lastSeenVersion/commandsSeeded but NO completedSteps/
    // onboardingCompletedVersion; deriveOnboarding must ignore the legacy fields and run the full flow.
    const legacy = { setupVersion: '1.5.45', lastSeenVersion: '1.5.39', commandsSeeded: true } as unknown as OnboardingMetaView
    const { due, steps } = deriveOnboarding(legacy, {})
    expect(due).toBe(true)
    expect(steps.length).toBe(ALL_IDS.length - 1)
  })

  it('codex ON -> codexSignIn is included', () => {
    const { steps } = deriveOnboarding({}, { codexEnabled: true })
    expect(steps.map((s) => s.id)).toContain('codexSignIn')
    expect(steps.length).toBe(ALL_IDS.length)
  })

  it('crash mid-flow -> resumes with the remaining undone steps', () => {
    const meta = { completedSteps: { whatsNewV2: '2.0.0', welcome: '2.0.0', findClaude: '2.0.0' } }
    const { due, steps } = deriveOnboarding(meta, {})
    expect(due).toBe(true)
    expect(steps.map((s) => s.id)).toEqual(
      ALL_IDS.filter((id) => !['whatsNewV2', 'welcome', 'findClaude', 'codexSignIn'].includes(id)),
    )
  })

  it('completed full flow (codex on) -> no harness', () => {
    const meta = { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: stampedExcept([]) }
    const { due, steps } = deriveOnboarding(meta, { codexEnabled: true })
    expect(due).toBe(false)
    expect(steps).toEqual([])
  })

  it('BLOCKER FIX: codex off leaves codexSignIn undone but when-false -> NOT due, never a zero-step harness', () => {
    const meta = { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: stampedExcept(['codexSignIn']) }
    const { due, steps } = deriveOnboarding(meta, { codexEnabled: false })
    expect(due).toBe(false)
    expect(steps).toEqual([])
    expect(due && steps.length === 0).toBe(false) // the invariant
  })

  it('v2.1 adds a requiresSetup step -> re-surfaces with just that step', () => {
    const extra: OnboardingStep = { id: 'newFeature', sinceVersion: '2.1.0', requiresSetup: true }
    const meta = { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: stampedExcept(['codexSignIn']) }
    const { due, steps } = deriveOnboarding(meta, { codexEnabled: false }, [...STEPS, extra])
    expect(due).toBe(true)
    expect(steps.map((s) => s.id)).toEqual(['newFeature'])
  })

  it('v2.1 adds only an info step -> not due (Whats-New handles it)', () => {
    const extra: OnboardingStep = { id: 'newInfo', sinceVersion: '2.1.0', requiresSetup: false }
    const meta = { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: stampedExcept(['codexSignIn']) }
    const { due } = deriveOnboarding(meta, { codexEnabled: false }, [...STEPS, extra])
    expect(due).toBe(false)
  })

  it('plain patch / re-run after completion (no new steps) -> not due', () => {
    const meta = { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: stampedExcept(['codexSignIn']) }
    expect(deriveOnboarding(meta, { codexEnabled: false }).due).toBe(false)
  })

  it('INVARIANT: across every scenario, due:true always implies at least one step to show', () => {
    const scenarios: Array<[OnboardingMetaView, { codexEnabled?: boolean }, OnboardingStep[]?]> = [
      [{}, {}],                                                                  // fresh (due)
      [{}, { codexEnabled: true }],                                             // fresh, codex on (due)
      [{ completedSteps: { whatsNewV2: '2.0.0' } }, {}],                        // crash-resume (due)
      [{ onboardingCompletedVersion: '2', completedSteps: stampedExcept([]) }, { codexEnabled: true }],            // completed, codex on (not due)
      [{ onboardingCompletedVersion: '2', completedSteps: stampedExcept(['codexSignIn']) }, { codexEnabled: false }], // completed, codex off — the danger case (not due)
      [{ onboardingCompletedVersion: '2', completedSteps: stampedExcept(['codexSignIn']) }, { codexEnabled: false },
        [...STEPS, { id: 'newFeature', sinceVersion: '2.1.0', requiresSetup: true }]],                              // re-surface (due)
    ]
    for (const [meta, settings, steps] of scenarios) {
      const { due, steps: shown } = deriveOnboarding(meta, settings, steps)
      if (due) expect(shown.length).toBeGreaterThan(0)      // due ⇒ non-empty
      expect(due && shown.length === 0).toBe(false)         // never a zero-step forced harness
    }
  })
})
