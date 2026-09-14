import { describe, it, expect } from 'vitest'
import { pickBootGate } from '../../../src/renderer/utils/bootGates'
import type { BootGateState } from '../../../src/renderer/utils/bootGates'

const base: BootGateState = {
  configLoaded: true,
  logsWipeBytes: 0,
  showTraining: false,
  showTrainingAll: false,
  showGitHubOnboarding: false,
  showMachineNamePrompt: false,
  loggingConsentSeen: true,
  resumePending: false,
  whatsNewDue: false,
  trainingDue: false,
  githubOnboardingDue: false,
}

describe('pickBootGate — onboarding', () => {
  it('returns onboarding when onboardingDue, above training', () => {
    expect(pickBootGate({ ...base, onboardingDue: true, showTraining: true })).toBe('onboarding')
  })

  it('logsWipe still outranks onboarding', () => {
    expect(pickBootGate({ ...base, onboardingDue: true, logsWipeBytes: 500 })).toBe('logsWipe')
  })

  it('waits on config + wipe detection before onboarding', () => {
    expect(pickBootGate({ ...base, onboardingDue: true, configLoaded: false })).toBe(null)
    expect(pickBootGate({ ...base, onboardingDue: true, logsWipeBytes: null })).toBe(null)
  })

  it('onboardingDue false -> the next gate down takes its turn', () => {
    expect(pickBootGate({ ...base, onboardingDue: false, showTraining: true })).toBe('training')
  })

  it('onboardingDue omitted (optional) -> falsy, unchanged', () => {
    expect(pickBootGate({ ...base, showTraining: true })).toBe('training')
  })
})
