import { describe, it, expect } from 'vitest'
import { deriveOnboarding, shouldReonboardForVersion, type OnboardingMetaView } from '../../../src/renderer/onboarding/gate'
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


describe('shouldReonboardForVersion', () => {
  const done = (appVersion?: string): OnboardingMetaView => ({
    onboardingCompletedVersion: ONBOARDING_VERSION,
    ...(appVersion ? { onboardingAppVersion: appVersion } : {}),
  })

  it('re-fires on the beta channel for any version change', () => {
    expect(shouldReonboardForVersion(done('2.1.0-beta.13'), '2.1.0-beta.14', 'beta')).toBe(true)
  })

  it('re-fires on a crossed release line even on stable', () => {
    // The owner's ask: a 2.0 user walks the tour again when they land on 2.1.
    expect(shouldReonboardForVersion(done('2.0.4'), '2.1.0', 'stable')).toBe(true)
  })

  it('does NOT re-fire within a stable line', () => {
    expect(shouldReonboardForVersion(done('2.1.0'), '2.1.1', 'stable')).toBe(false)
    expect(shouldReonboardForVersion(done('2.1.0'), '2.1.9', undefined)).toBe(false)
  })

  it('does not re-fire for the version it was already finished at', () => {
    expect(shouldReonboardForVersion(done('2.1.0'), '2.1.0', 'beta')).toBe(false)
  })

  it('leaves someone who never finished the tour to deriveOnboarding', () => {
    expect(shouldReonboardForVersion({}, '2.1.0', 'beta')).toBe(false)
    expect(shouldReonboardForVersion({ completedSteps: { welcome: '2.0.0' } }, '2.1.0', 'stable')).toBe(false)
  })

  it('re-fires when ONBOARDING_VERSION has been bumped, for anyone who ever finished', () => {
    // The constant's contract - "bump ONLY to force every user through the full
    // flow again" - and it was never implemented: deriveOnboarding cannot see a
    // bump when every step is already in completedSteps. Discovered on the
    // first bump ever ('2' -> '3').
    const finishedAtOldConstant: OnboardingMetaView = {
      onboardingCompletedVersion: String(Number(ONBOARDING_VERSION) - 1),
      onboardingAppVersion: '2.1.0',
      completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, '2.1.0'])),
    }
    // Same app version, stable channel, same line: nothing else would fire.
    expect(shouldReonboardForVersion(finishedAtOldConstant, '2.1.0', 'stable')).toBe(true)
    // And deriveOnboarding alone confirms the gap it closes.
    expect(deriveOnboarding(finishedAtOldConstant, {}).due).toBe(false)
  })

  it('re-fires once for someone onboarded before the field existed', () => {
    // onboardingAppVersion undefined reads as an unknown origin, which counts
    // as a crossing; the finish step then stamps it and it settles.
    expect(shouldReonboardForVersion(done(undefined), '2.1.0', 'stable')).toBe(true)
  })
})
