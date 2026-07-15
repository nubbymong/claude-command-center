import { STEPS, ONBOARDING_VERSION } from './steps'
import type { OnboardingStep, OnboardingSettingsView } from './steps'

export interface OnboardingMetaView {
  completedSteps?: Record<string, string>
  onboardingCompletedVersion?: string
  onboardingAppVersion?: string
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

/**
 * The 2.0 beta line re-fires the first-run tour on EVERY version so testers (and
 * early adopters) always see the latest flow. True only for someone who has
 * FINISHED the flow before (onboardingCompletedVersion set) on a DIFFERENT app
 * version -- so fresh installs and crash-resumes go through deriveOnboarding
 * untouched, and stable releases retrigger only through an ONBOARDING_VERSION
 * bump (a major feature). onboardingAppVersion is undefined for users who
 * onboarded before this field existed, which correctly counts as "a different
 * version" so the first post-upgrade beta re-fires too. The caller clears
 * completedSteps + onboardingCompletedVersion (flipping deriveOnboarding back to
 * due); settleOnboardingFinish then re-stamps onboardingAppVersion so it won't
 * re-fire again until the next version.
 */
export function shouldReonboardForBeta(
  meta: OnboardingMetaView,
  appVersion: string,
  channel: string | undefined,
): boolean {
  return channel === 'beta'
    && meta.onboardingCompletedVersion != null
    && meta.onboardingAppVersion !== appVersion
}
