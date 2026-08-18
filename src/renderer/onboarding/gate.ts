import { STEPS, ONBOARDING_VERSION } from './steps'
import type { OnboardingStep, OnboardingSettingsView } from './steps'
import { crossedReleaseLine } from '../../shared/version-order'

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
 * Should the full-screen tour run again because of the version the user has
 * moved TO? The whole rule.
 *
 * Two things trigger it, and both are a different question from
 * `deriveOnboarding` (which asks "are there steps left to do"):
 *
 *   - **beta channel, any version change** — testers should see the current
 *     flow on every build. Pre-existing behaviour, unchanged.
 *   - **a crossed release line, on any channel** — 2.0.x → 2.1.x is a big
 *     enough change to walk someone through again, and this is what makes the
 *     tour re-run for 2.0 users arriving at 2.1. Moving within a line
 *     (2.1.0 → 2.1.1) does not.
 *
 * Keyed on `onboardingAppVersion` — the version at which the tour was last
 * FINISHED — rather than `lastSeenVersion`, which the What's New modal stamps
 * at a different moment for a different reason. Anyone who has never finished
 * the tour is left to `deriveOnboarding`, which already has them.
 *
 * `onboardingAppVersion` is undefined for anyone who onboarded before that
 * field existed; `crossedReleaseLine` treats an unreadable origin as a
 * crossing, so they get the tour once and then settle, which is the safe
 * direction to be wrong in.
 */
export function shouldReonboardForVersion(
  meta: OnboardingMetaView,
  appVersion: string,
  channel: string | undefined,
): boolean {
  if (meta.onboardingCompletedVersion == null) return false
  // An ONBOARDING_VERSION bump means "everyone walks it again", full stop —
  // and this is the only place that makes the constant's contract true.
  // deriveOnboarding alone cannot: with every step already in completedSteps
  // its applicable set is empty, so a bumped constant with no new pages was a
  // no-op for anyone who had ever finished. First discovered on the first bump.
  if (meta.onboardingCompletedVersion !== ONBOARDING_VERSION) return true
  if (meta.onboardingAppVersion === appVersion) return false
  if (channel === 'beta') return true
  return crossedReleaseLine(meta.onboardingAppVersion ?? '', appVersion)
}
