import { useAppMetaStore } from '../stores/appMetaStore'
import { useGitHubStore } from '../stores/githubStore'
import { STEPS, ONBOARDING_VERSION } from './steps'
import { markWhatsNewSeen } from '../components/WhatsNewModal'
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
    // Stamp the tour + what's-new as already seen so their auto-triggers stay
    // dormant (the flow covered v2; the tour is still reachable via the Feature
    // Guide button on demand).
    lastTrainingVersion: currentTrainingVersion(),
  })
  markWhatsNewSeen()
  // Retire the legacy GitHub onboarding modal (same field its own dismiss uses).
  void useGitHubStore.getState().updateConfig({ seenOnboardingVersion: appVersion }).catch(() => {})
}
