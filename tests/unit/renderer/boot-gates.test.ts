/**
 * Boot-gate sequencing unit tests.
 *
 * First-launch gates (LogsWipe, the onboarding harness, training tour, GitHub
 * onboarding, machine-name prompt, logging consent, resume) each have an
 * independent trigger, so without a shared priority they mount simultaneously
 * and stack (VM finding #1, 2026-06-13: consent dialog painted on top of the
 * What's New modal; and 2026-08-21: release notes, the resume prompt and the
 * Sentinel panel all at once).
 *
 * pickBootGate is the single priority chain: it returns the one gate allowed
 * to render right now, or null when none should.
 *
 * The `whatsNew` gate is GONE as of 2026-08-21 — the harness is the only
 * release-notes surface, so a notes launch arrives here as `onboardingDue`.
 */
import { describe, it, expect } from 'vitest'
import { pickBootGate, type BootGateState } from '../../../src/renderer/utils/bootGates'

function makeState(overrides: Partial<BootGateState> = {}): BootGateState {
  return {
    configLoaded: true,
    logsWipeBytes: 0,
    onboardingDue: false,
    showTraining: false,
    showTrainingAll: false,
    tourActive: false,
    showGuidedConfig: false,
    showGitHubOnboarding: false,
    showMachineNamePrompt: false,
    loggingConsentSeen: true,
    resumePending: false,
    whatsNewDue: false,
    trainingDue: false,
    githubOnboardingDue: false,
    ...overrides,
  }
}

// #609: a gate this returns MUST render. The resume prompt kept the
// `!tourActive` condition it needed back when it rendered OUTSIDE the chain,
// while GuidedTour required `bootGate === null` -- so a boot with saved sessions
// AND a chained tour selected 'resume', rendered neither surface, and stranded
// pendingRestore along with every gate below it.
describe('pickBootGate — the tour and the first-config dialog own turns (#609)', () => {
  it('a chained tour outranks the resume prompt instead of deadlocking with it', () => {
    expect(pickBootGate(makeState({ tourActive: true, resumePending: true }))).toBe('guidedTour')
  })

  it('the resume prompt follows as soon as the tour closes', () => {
    expect(pickBootGate(makeState({ tourActive: false, resumePending: true }))).toBe('resume')
  })

  it('the first-config dialog outranks resume too, rather than suppressing it', () => {
    expect(pickBootGate(makeState({ showGuidedConfig: true, resumePending: true }))).toBe('guidedConfig')
  })

  it('the tour outranks the dialog it can open', () => {
    expect(pickBootGate(makeState({ tourActive: true, showGuidedConfig: true }))).toBe('guidedTour')
  })

  it('both wait behind the release-notes harness', () => {
    expect(pickBootGate(makeState({ tourActive: true, onboardingDue: true }))).toBe('onboarding')
    expect(pickBootGate(makeState({ showGuidedConfig: true, onboardingDue: true }))).toBe('onboarding')
  })

  it('neither is starved by a pending boot timer', () => {
    // They are opened by a user action that has ALREADY happened, so unlike the
    // one-time notices they must not wait on the *Due short-circuit.
    expect(pickBootGate(makeState({ tourActive: true, whatsNewDue: true, trainingDue: true }))).toBe('guidedTour')
    expect(pickBootGate(makeState({ showGuidedConfig: true, githubOnboardingDue: true }))).toBe('guidedConfig')
  })

  it('both are absent === false, like the other optional gates', () => {
    const { tourActive, showGuidedConfig, ...without } = makeState({ tourActive: true, showGuidedConfig: true })
    expect(tourActive && showGuidedConfig).toBe(true)
    expect(pickBootGate(without as BootGateState)).toBeNull()
  })

  it('NO input combination selects a gate that has no turn — exhaustive sweep', () => {
    // The deadlock was one selected-but-unrendered gate. Sweep every boolean
    // combination and assert the result is always a real gate or null; a new
    // input that can produce an unknown value fails here.
    const known = new Set([
      'logsWipe', 'onboarding', 'training', 'guidedTour', 'guidedConfig',
      'githubOnboarding', 'machineName', 'loggingConsent', 'resume', 'multiSpawnIntro',
    ])
    const flags = [
      'onboardingDue', 'showTraining', 'showTrainingAll', 'tourActive', 'showGuidedConfig',
      'showGitHubOnboarding', 'showMachineNamePrompt', 'loggingConsentSeen', 'resumePending',
      'multiSpawnIntroDue', 'whatsNewDue', 'trainingDue', 'githubOnboardingDue',
    ] as const
    for (let mask = 0; mask < (1 << flags.length); mask++) {
      const over: Record<string, boolean> = {}
      flags.forEach((f, i) => { over[f] = Boolean(mask & (1 << i)) })
      const gate = pickBootGate(makeState(over as Partial<BootGateState>))
      expect(gate === null || known.has(gate), `mask ${mask} -> ${gate}`).toBe(true)
    }
  })
})

describe('pickBootGate', () => {
  it('shows nothing before config loads', () => {
    expect(pickBootGate(makeState({ configLoaded: false, onboardingDue: true, loggingConsentSeen: false }))).toBeNull()
  })

  it('shows nothing while logs-wipe detection is unresolved', () => {
    expect(pickBootGate(makeState({ logsWipeBytes: null, onboardingDue: true, loggingConsentSeen: false }))).toBeNull()
  })

  it('logs wipe outranks every other pending gate', () => {
    const state = makeState({
      logsWipeBytes: 12345,
      onboardingDue: true,
      showTraining: true,
      showGitHubOnboarding: true,
      showMachineNamePrompt: true,
      loggingConsentSeen: false,
      resumePending: true,
    })
    expect(pickBootGate(state)).toBe('logsWipe')
  })

  it('shows only the harness when it stacks with pending consent (VM finding #1)', () => {
    expect(pickBootGate(makeState({ onboardingDue: true, loggingConsentSeen: false }))).toBe('onboarding')
  })

  it('the harness outranks training, GitHub onboarding, machine name and resume', () => {
    const state = makeState({
      onboardingDue: true,
      showTraining: true,
      showGitHubOnboarding: true,
      showMachineNamePrompt: true,
      resumePending: true,
    })
    expect(pickBootGate(state)).toBe('onboarding')
  })

  it('the resume prompt never paints alongside the release notes (2026-08-21)', () => {
    // The reported defect: a launch showed the full-screen notes, the resume
    // prompt and the Sentinel panel at once. Resume was outside the chain
    // entirely, gated only on "not the onboarding harness" — and the notes
    // were their own separate gate, so that guard did not cover them. Now the
    // notes ARE the harness, and resume is a gate below it.
    expect(pickBootGate(makeState({ onboardingDue: true, resumePending: true }))).toBe('onboarding')
  })

  it('resume shows once every gate above it is resolved', () => {
    expect(pickBootGate(makeState({ resumePending: true }))).toBe('resume')
  })

  it('resume waits behind a one-time surface that has not opened yet', () => {
    // Same flash guard the consent notice gets: a due-but-not-yet-armed
    // surface must not let resume paint for the few hundred ms before it opens
    // and then get swapped out from under the user mid-decision.
    expect(pickBootGate(makeState({ resumePending: true, whatsNewDue: true }))).toBeNull()
    expect(pickBootGate(makeState({ resumePending: true, trainingDue: true }))).toBeNull()
    expect(pickBootGate(makeState({ resumePending: true, githubOnboardingDue: true }))).toBeNull()
  })

  it('the one-time consent notice goes before the every-boot resume prompt', () => {
    expect(pickBootGate(makeState({ resumePending: true, loggingConsentSeen: false }))).toBe('loggingConsent')
  })

  it('training outranks onboarding and machine name', () => {
    expect(pickBootGate(makeState({ showTraining: true, showGitHubOnboarding: true, showMachineNamePrompt: true }))).toBe('training')
  })

  it('help-mode tour (showTrainingAll) counts as the training gate', () => {
    expect(pickBootGate(makeState({ showTraining: true, showTrainingAll: true }))).toBe('training')
  })

  it('GitHub onboarding outranks the machine-name prompt', () => {
    expect(pickBootGate(makeState({ showGitHubOnboarding: true, showMachineNamePrompt: true }))).toBe('githubOnboarding')
  })

  it('machine-name prompt shows when nothing above it is pending', () => {
    expect(pickBootGate(makeState({ showMachineNamePrompt: true, loggingConsentSeen: false }))).toBe('machineName')
  })

  it('logging consent shows only when every other gate is resolved', () => {
    expect(pickBootGate(makeState({ loggingConsentSeen: false }))).toBe('loggingConsent')
  })

  it('logging consent waits while What\'s New is due but its 500ms boot timer has not fired yet', () => {
    expect(pickBootGate(makeState({ loggingConsentSeen: false, whatsNewDue: true }))).toBeNull()
  })

  it('logging consent waits while the training tour is due but not yet open', () => {
    expect(pickBootGate(makeState({ loggingConsentSeen: false, trainingDue: true }))).toBeNull()
  })

  it('logging consent waits while GitHub onboarding is due but its 120ms timer has not fired yet', () => {
    expect(pickBootGate(makeState({ loggingConsentSeen: false, githubOnboardingDue: true }))).toBeNull()
  })

  it('returns null when every gate is seen or resolved', () => {
    expect(pickBootGate(makeState())).toBeNull()
  })
})

/**
 * The Allow Multi Spawn startup page (phase 5) is the LAST gate, and the two
 * things it waits for are the two halves of its own correctness: it is the
 * second page of one upgrade story (release notes first), and its per-row copy
 * counts are read from the sessions the resume prompt has just brought back.
 */
describe('pickBootGate — the Multi Spawn startup page', () => {
  it('waits while the release notes are still due (not yet armed)', () => {
    // whatsNewDue stays true until the harness stamps on close. The page must
    // not paint in the gap between the launch decision and the harness opening.
    expect(pickBootGate(makeState({ multiSpawnIntroDue: true, whatsNewDue: true }))).toBeNull()
  })

  it('waits while the release-notes harness is actually on screen', () => {
    expect(pickBootGate(makeState({ multiSpawnIntroDue: true, onboardingDue: true, whatsNewDue: true }))).toBe('onboarding')
  })

  it('shows on the SAME start, the moment the notes are dismissed', () => {
    // Dismissal stamps lastSeenVersion (whatsNewDue -> false) and clears the
    // notes-only arm (onboardingDue -> false). Nothing else has to happen: the
    // page is due on this launch, not the next one.
    expect(pickBootGate(makeState({ multiSpawnIntroDue: true }))).toBe('multiSpawnIntro')
  })

  it('waits behind the resume prompt — its counts come from what resumes', () => {
    expect(pickBootGate(makeState({ multiSpawnIntroDue: true, resumePending: true }))).toBe('resume')
  })

  it('waits behind the one-time consent notice too', () => {
    expect(pickBootGate(makeState({ multiSpawnIntroDue: true, loggingConsentSeen: false }))).toBe('loggingConsent')
  })

  it('is absent === false, like the other optional gates', () => {
    const { multiSpawnIntroDue, ...withoutIt } = makeState({ multiSpawnIntroDue: true })
    expect(multiSpawnIntroDue).toBe(true)
    expect(pickBootGate(withoutIt as BootGateState)).toBeNull()
  })
})
