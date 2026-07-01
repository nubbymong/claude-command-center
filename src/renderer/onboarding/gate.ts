import { STEPS, ONBOARDING_VERSION } from './steps'
import type { OnboardingStep, OnboardingSettingsView } from './steps'

export interface OnboardingMetaView {
  completedSteps?: Record<string, string>
  onboardingCompletedVersion?: string
}

export interface DerivedOnboarding {
  due: boolean
  steps: OnboardingStep[]
}

/**
 * Pure onboarding decision. `due` and `steps` derive from the SAME `applicable`
 * set (undone ∩ when()), so a when()-filtered step can never yield a
 * due:true / steps:[] forced harness.
 */
export function deriveOnboarding(
  meta: OnboardingMetaView,
  settings: OnboardingSettingsView,
  steps: OnboardingStep[] = STEPS,
): DerivedOnboarding {
  const undone = steps.filter((s) => !(s.id in (meta.completedSteps ?? {}))) // presence, not truthiness (spec §3.1)
  const applicable = undone.filter((s) => (s.when ? s.when(settings) : true))
  const fullFlowPending = meta.onboardingCompletedVersion !== ONBOARDING_VERSION
  const due = fullFlowPending ? applicable.length > 0 : applicable.some((s) => s.requiresSetup)
  return { due, steps: applicable }
}
