import { STEPS, ONBOARDING_VERSION } from './steps'
import type { OnboardingStep, OnboardingSettingsView } from './steps'
import { compareVersions, crossedReleaseLine } from '../../shared/version-order'

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
 * Should the user walk the WHOLE flow again because of the version they have
 * moved TO? The whole rule.
 *
 * Note what this is not: it is not "should the harness open". Since 2026-08-21
 * the harness is also the release-notes surface, and an ordinary upgrade opens
 * it in what's-new-only mode without re-walking anything (see
 * `bootWhatsNewSurface` and `stepsNewSince`). This function answers the rarer
 * question of a genuine re-onboard, and only two things trigger it:
 *
 *   - **an ONBOARDING_VERSION bump** — "everyone walks it again", full stop.
 *   - **a crossed release line, on any channel** — 2.0.x → 2.1.x is a big
 *     enough change to walk someone through again, and this is what makes the
 *     flow re-run for 2.0 users arriving at 2.1. Moving within a line
 *     (2.1.0 → 2.1.1) does not.
 *
 * The **beta channel** used to be a third trigger: any version change re-walked
 * the entire flow, so that testers saw the current pages on every build. That
 * is now the wrong shape — it re-walked twelve pages to deliver what is usually
 * one page of notes, which is precisely the "wall" the user rejected. Beta
 * builds take the same route as everyone else: notes, plus whatever pages are
 * genuinely NEW in the build (`stepsNewSince`). A tester who wants the whole
 * flow can still re-run it from the Feature Guide.
 *
 * Keyed on `onboardingAppVersion` — the version at which the flow was last
 * FINISHED — rather than `lastSeenVersion`, which is stamped at a different
 * moment for a different reason. Anyone who has never finished is left to
 * `deriveOnboarding`, which already has them.
 *
 * `onboardingAppVersion` is undefined for anyone who onboarded before that
 * field existed; `crossedReleaseLine` treats an unreadable origin as a
 * crossing, so they get the flow once and then settle, which is the safe
 * direction to be wrong in.
 */
export function shouldReonboardForVersion(
  meta: OnboardingMetaView,
  appVersion: string,
  _channel?: string | undefined,
): boolean {
  if (meta.onboardingCompletedVersion == null) return false
  // An ONBOARDING_VERSION bump means "everyone walks it again", full stop —
  // and this is the only place that makes the constant's contract true.
  // deriveOnboarding alone cannot: with every step already in completedSteps
  // its applicable set is empty, so a bumped constant with no new pages was a
  // no-op for anyone who had ever finished. First discovered on the first bump.
  if (meta.onboardingCompletedVersion !== ONBOARDING_VERSION) return true
  if (meta.onboardingAppVersion === appVersion) return false
  return crossedReleaseLine(meta.onboardingAppVersion ?? '', appVersion)
}

/**
 * The pages that are NEW to someone arriving at this build — the "any settings
 * from the first-run tour that are released in this version" half of the
 * upgrade surface (user call 2026-08-21).
 *
 * Compares each step's `sinceVersion` against the version the user last ran.
 * The field has existed on every step since the registry was written and has
 * never been read at runtime; this is what it was for. A step whose CONTENT
 * materially changes bumps its own `sinceVersion` and re-surfaces by the same
 * rule — one field, both cases.
 *
 * `whatsNewV2` is excluded: it is the notes page itself, not a setting, and the
 * harness places it first on its own.
 *
 * With no `lastSeenVersion` this returns nothing. A fresh install has no delta
 * — it gets every page, via `deriveOnboarding`.
 */
export function stepsNewSince(
  lastSeenVersion: string | undefined,
  settings: OnboardingSettingsView,
  steps: OnboardingStep[] = STEPS,
): OnboardingStep[] {
  if (!lastSeenVersion) return []
  return steps.filter(
    (s) =>
      s.id !== 'whatsNewV2' &&
      (s.when ? s.when(settings) : true) &&
      compareVersions(s.sinceVersion, lastSeenVersion) > 0,
  )
}
