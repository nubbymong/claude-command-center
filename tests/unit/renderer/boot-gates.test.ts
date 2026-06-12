/**
 * Boot-gate sequencing unit tests.
 *
 * First-launch gates (LogsWipe, What's New, training tour, GitHub onboarding,
 * machine-name prompt, logging consent) each have an independent trigger, so
 * without a shared priority they mount simultaneously and stack (VM finding #1,
 * 2026-06-13: consent dialog painted on top of the What's New modal).
 *
 * pickBootGate is the single priority chain: it returns the one gate allowed
 * to render right now, or null when none should.
 */
import { describe, it, expect } from 'vitest'
import { pickBootGate, type BootGateState } from '../../../src/renderer/utils/bootGates'

function makeState(overrides: Partial<BootGateState> = {}): BootGateState {
  return {
    configLoaded: true,
    logsWipeBytes: 0,
    showWhatsNew: false,
    showTraining: false,
    showTrainingAll: false,
    showGitHubOnboarding: false,
    showMachineNamePrompt: false,
    loggingConsentSeen: true,
    whatsNewDue: false,
    trainingDue: false,
    githubOnboardingDue: false,
    ...overrides,
  }
}

describe('pickBootGate', () => {
  it('shows nothing before config loads', () => {
    expect(pickBootGate(makeState({ configLoaded: false, showWhatsNew: true, loggingConsentSeen: false }))).toBeNull()
  })

  it('shows nothing while logs-wipe detection is unresolved', () => {
    expect(pickBootGate(makeState({ logsWipeBytes: null, showWhatsNew: true, loggingConsentSeen: false }))).toBeNull()
  })

  it('logs wipe outranks every other pending gate', () => {
    const state = makeState({
      logsWipeBytes: 12345,
      showWhatsNew: true,
      showTraining: true,
      showGitHubOnboarding: true,
      showMachineNamePrompt: true,
      loggingConsentSeen: false,
    })
    expect(pickBootGate(state)).toBe('logsWipe')
  })

  it('shows only What\'s New when it stacks with pending consent (VM finding #1)', () => {
    expect(pickBootGate(makeState({ showWhatsNew: true, loggingConsentSeen: false }))).toBe('whatsNew')
  })

  it('What\'s New outranks training, onboarding and machine name', () => {
    const state = makeState({
      showWhatsNew: true,
      showTraining: true,
      showGitHubOnboarding: true,
      showMachineNamePrompt: true,
    })
    expect(pickBootGate(state)).toBe('whatsNew')
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
