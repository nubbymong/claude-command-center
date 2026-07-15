/**
 * Boot-gate sequencing.
 *
 * First-launch gates each have an independent trigger (wipe detection IPC,
 * version compare, settings flags, staggered boot timers), so left alone they
 * mount simultaneously and stack — DOM order, not intent, decided who painted
 * on top. pickBootGate is the single priority chain: exactly one gate may
 * render at a time.
 *
 * Priority (highest first):
 *   1. logsWipe          — blocking + destructive decision; nothing shows
 *                          until detection has resolved AND any wipe is done.
 *   1.5 onboarding       — forced first-run harness (deriveOnboarding). Timer-free
 *                          pure appMeta predicate, so it sits above whatsNew and
 *                          needs no entry in the *Due short-circuit below.
 *   2. whatsNew          — release notes.
 *   3. training          — first-run / what's-new tour (chained from whatsNew
 *                          close; also the user-invoked help tour).
 *   4. githubOnboarding  — opened by its own effect 120ms after the gates
 *                          above clear.
 *   5. machineName       — 800ms boot timer.
 *   6. loggingConsent    — one-time notice; lowest priority. Also waits on the
 *                          *due* predicates so it doesn't flash for the few
 *                          hundred ms before a higher gate's timer fires and
 *                          then get swapped out from under the user.
 */

export type BootGate =
  | 'logsWipe'
  | 'onboarding'
  | 'whatsNew'
  | 'training'
  | 'githubOnboarding'
  | 'machineName'
  | 'loggingConsent'

export interface BootGateState {
  configLoaded: boolean
  /** null = wipe detection still running, 0 = nothing to wipe, >0 = wipe pending. */
  logsWipeBytes: number | null
  /** deriveOnboarding(...).due — the forced first-run harness. Optional: absent === false. */
  onboardingDue?: boolean
  showWhatsNew: boolean
  showTraining: boolean
  showTrainingAll: boolean
  showGitHubOnboarding: boolean
  showMachineNamePrompt: boolean
  loggingConsentSeen: boolean
  /** shouldShowWhatsNew() — true before the 500ms boot timer flips showWhatsNew. */
  whatsNewDue: boolean
  /** shouldShowTraining() || isFirstInstall() — true before the tour opens. */
  trainingDue: boolean
  /** isGitHubOnboardingDue() — true before the onboarding effect's 120ms timer fires. */
  githubOnboardingDue: boolean
}

export function pickBootGate(s: BootGateState): BootGate | null {
  if (!s.configLoaded) return null
  if (s.logsWipeBytes === null) return null
  if (s.logsWipeBytes > 0) return 'logsWipe'
  if (s.onboardingDue) return 'onboarding'
  if (s.showWhatsNew) return 'whatsNew'
  if (s.showTraining || s.showTrainingAll) return 'training'
  if (s.showGitHubOnboarding) return 'githubOnboarding'
  if (s.showMachineNamePrompt) return 'machineName'
  if (s.whatsNewDue || s.trainingDue || s.githubOnboardingDue) return null
  if (!s.loggingConsentSeen) return 'loggingConsent'
  return null
}
