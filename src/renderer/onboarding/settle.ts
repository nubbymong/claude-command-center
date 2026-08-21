import { useAppMetaStore } from '../stores/appMetaStore'
import { useGitHubStore } from '../stores/githubStore'
import { STEPS, ONBOARDING_VERSION } from './steps'
import { markWhatsNewSeen } from './whats-new-gate'
import { currentTrainingVersion } from '../training-steps'

declare const __APP_VERSION__: string

// Atomic finish: mark the whole flow complete AND retire every legacy first-run
// popup in one pass. After this, deriveOnboarding returns due:false (every step
// is in completedSteps and onboardingCompletedVersion matches), and the legacy
// what's-new / tour / GitHub-onboarding gates are all pre-satisfied so none of
// them fire this release — the onboarding flow is their single replacement.
export function settleOnboardingFinish(): void {
  const appVersion = __APP_VERSION__
  const completedSteps: Record<string, string> = {}
  for (const s of STEPS) completedSteps[s.id] = appVersion
  useAppMetaStore.getState().update({
    completedSteps,
    onboardingCompletedVersion: ONBOARDING_VERSION,
    // App version at completion: on the beta line the tour re-fires whenever this
    // no longer matches __APP_VERSION__ (see shouldReonboardForVersion).
    onboardingAppVersion: appVersion,
    // Stamp the tour + what's-new as already seen so their auto-triggers stay
    // dormant (the flow covered v2; the tour is still reachable via the Feature
    // Guide button on demand).
    lastTrainingVersion: currentTrainingVersion(),
  })
  markWhatsNewSeen()
  // Retire the legacy GitHub onboarding modal (same field its own dismiss uses).
  void useGitHubStore.getState().updateConfig({ seenOnboardingVersion: appVersion }).catch(() => {})
}

/**
 * Finish for the WHAT'S-NEW-ONLY run: the harness opened purely to deliver the
 * release notes to someone who has already completed the flow.
 *
 * Deliberately narrower than `settleOnboardingFinish`. That one stamps EVERY
 * step in `STEPS` as complete, which is correct after a full walk and wrong
 * here: a user who skipped Codex sign-in has still not done it, and marking it
 * done because they read the release notes would silently retire a setup step
 * they never saw.
 *
 * `lastTrainingVersion` IS stamped, for the same reason the full finish stamps
 * it: the legacy guided tour's auto-trigger has to be retired by whichever
 * surface delivered this release, or it stays armed forever. That matters more
 * than it looks — `trainingDue` holds the boot chain open (bootGates), so an
 * un-retired trigger with nothing left to auto-open it would sit above the
 * resume prompt and stop it from ever appearing. The tour itself stays
 * available on demand from the Feature Guide.
 */
export function settleWhatsNewOnly(): void {
  useAppMetaStore.getState().update({
    onboardingAppVersion: __APP_VERSION__,
    lastTrainingVersion: currentTrainingVersion(),
  })
  markWhatsNewSeen()
}
