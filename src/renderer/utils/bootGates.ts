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
 *   2. onboarding        — the full-screen harness, and since 2026-08-21 the
 *                          ONLY release-notes surface too (the `whatsNew`
 *                          modal gate is gone; a notes-only launch opens the
 *                          harness in its what's-new-only mode). Timer-free
 *                          pure appMeta predicate, so it needs no entry in the
 *                          *Due short-circuit below.
 *   3. training          — the live-app guided tour (chained from the harness
 *                          finish; also the user-invoked help tour).
 *   4. githubOnboarding  — opened by its own effect 120ms after the gates
 *                          above clear.
 *   5. machineName       — 800ms boot timer.
 *   6. loggingConsent    — one-time notice. Waits on the *due* predicates so it
 *                          doesn't flash for the few hundred ms before a higher
 *                          gate's timer fires and then get swapped out from
 *                          under the user.
 *   7. resume            — "restore your sessions?". Every boot, so it sits
 *                          below the one-time surfaces above.
 *   8. multiSpawnIntro   — the Allow Multi Spawn startup page (phase 5). LAST,
 *                          and both halves of that are deliberate. It must come
 *                          after the release notes, because it is the second
 *                          page of one upgrade story — and the `*Due`
 *                          short-circuit below is what makes it wait, since
 *                          `whatsNewDue` stays true until the harness stamps.
 *                          It must also come after `resume`, because its per-row
 *                          copy counts are read from the sessions this start
 *                          brought back; shown first it would count zero and
 *                          claim nothing was resumable.
 *
 * `resume` joined the chain on 2026-08-21. It and the Sentinel panel were the
 * two boot surfaces still OUTSIDE it, each with its own render condition — the
 * resume prompt gated only on `bootGate !== 'onboarding'`, Sentinel on nothing
 * at all — which is why a launch could paint release notes, a resume prompt and
 * a findings panel on top of one another. Sentinel is not a gate (it owns no
 * turn in the sequence); it is simply suppressed while any gate is up.
 */

export type BootGate =
  | 'logsWipe'
  | 'onboarding'
  | 'training'
  | 'githubOnboarding'
  | 'machineName'
  | 'loggingConsent'
  | 'resume'
  | 'multiSpawnIntro'

export interface BootGateState {
  configLoaded: boolean
  /** null = wipe detection still running, 0 = nothing to wipe, >0 = wipe pending. */
  logsWipeBytes: number | null
  /** The harness is due: deriveOnboarding(...).due, a forced re-onboard, OR a
   *  release-notes-only run. Optional: absent === false. */
  onboardingDue?: boolean
  showTraining: boolean
  showTrainingAll: boolean
  showGitHubOnboarding: boolean
  showMachineNamePrompt: boolean
  loggingConsentSeen: boolean
  /** Saved sessions are waiting on a restore decision. Optional: absent === false. */
  resumePending?: boolean
  /** The Allow Multi Spawn startup page is due this launch — decided once at
   *  boot (decideMultiSpawnIntro) from meta read before anything stamped.
   *  Optional: absent === false. */
  multiSpawnIntroDue?: boolean
  /** shouldShowWhatsNew() — true before postConfigInit has armed the harness. */
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
  if (s.showTraining || s.showTrainingAll) return 'training'
  if (s.showGitHubOnboarding) return 'githubOnboarding'
  if (s.showMachineNamePrompt) return 'machineName'
  if (s.whatsNewDue || s.trainingDue || s.githubOnboardingDue) return null
  if (!s.loggingConsentSeen) return 'loggingConsent'
  if (s.resumePending) return 'resume'
  if (s.multiSpawnIntroDue) return 'multiSpawnIntro'
  return null
}
