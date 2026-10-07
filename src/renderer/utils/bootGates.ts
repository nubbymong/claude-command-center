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
 *   3. training          — the live-app guided walkthrough (chained from the
 *                          harness finish; also the user-invoked help tour).
 *   4. guidedTour        — the GuidedTour overlay, armed by the harness
 *                          finishing with startTour.
 *   5. guidedConfig      — the first-config SessionDialog, opened from the
 *                          tour, the sidebar FirstRunCard or the empty state.
 *                          It launches a session, so a due loggingConsent
 *                          notice (8) is shown before it.
 *   6. githubOnboarding  — opened by its own effect 120ms after the gates
 *                          above clear.
 *   7. codexReconfirm    — "Do you use Codex?", asked once of everyone who
 *                          updates (owner decision 2026-09-26; see
 *                          onboarding/codex-reconfirm-gate.ts). After the
 *                          release notes and the upgrade harness (the `*Due`
 *                          short-circuit below holds it until they are done),
 *                          and before everything that uses the app: the resume
 *                          prompt restores sessions, and a Codex one would only
 *                          be refused while the question is unanswered. A Yes
 *                          hands the user to the Codex setup page, which is the
 *                          harness again (the `onboarding` gate above).
 *   8. loggingConsent    — one-time notice. Waits on the *due* predicates so it
 *                          doesn't flash for the few hundred ms before a higher
 *                          gate's timer fires and then get swapped out from
 *                          under the user.
 *   9. resume            — "restore your sessions?". Every boot, so it sits
 *                          below the one-time surfaces above.
 *  10. multiSpawnIntro   — the Allow Multi Spawn startup page (phase 5). LAST,
 *                          and both halves of that are deliberate. It must come
 *                          after the release notes, because it is the second
 *                          page of one upgrade story — and the `*Due`
 *                          short-circuit below is what makes it wait, since
 *                          `whatsNewDue` stays true until the harness stamps.
 *                          It must also come after `resume`, because its per-row
 *                          copy counts are read from the sessions this start
 *                          brought back; shown first it would count zero and
 *                          claim nothing was resumable.
 *  11. helloCodex       — the one-time Codex introduction (WP2 commit 6f),
 *                          outside onboarding. After everything above,
 *                          including the `*Due` short-circuit: it must never
 *                          cover a running setup. bootChain below asks this
 *                          chain whether it would be next; only then does
 *                          HelloCodexHost latch it open, and only once it is
 *                          open is it an input here.
 *
 * `resume` joined the chain on 2026-08-21. It and the Sentinel panel were the
 * two boot surfaces still OUTSIDE it, each with its own render condition — the
 * resume prompt gated only on `bootGate !== 'onboarding'`, Sentinel on nothing
 * at all — which is why a launch could paint release notes, a resume prompt and
 * a findings panel on top of one another. Sentinel is not a gate (it owns no
 * turn in the sequence); it is simply suppressed while any gate is up, as is the
 * new-account prompt, and the pre-spawn account picker (#607) and launch
 * confirm are while any gate but the resume offer is (launchDialogsSuppressed).
 *
 * THE INVARIANT (#609): a gate this returns MUST render. Splitting the decision
 * — selecting a gate here while its render site ALSO tests something else — can
 * pick a surface that then paints nothing, and a chain that stops at a surface
 * nobody can answer never advances. That is exactly what happened: `resume` kept
 * the `!tourActive` condition it needed back when it rendered outside the chain,
 * while GuidedTour required `bootGate === null`, so a boot with saved sessions
 * AND a chained tour rendered neither and stranded `pendingRestore` — taking
 * every gate below it down too. The fix is the rule this module already states:
 * one authority. `tourActive` and `showGuidedConfig` are inputs now, not extra
 * conditions bolted onto a render site.
 */

export type BootGate =
  | 'logsWipe'
  | 'onboarding'
  | 'training'
  | 'guidedTour'
  | 'guidedConfig'
  | 'githubOnboarding'
  | 'codexReconfirm'
  | 'loggingConsent'
  | 'resume'
  | 'multiSpawnIntro'
  | 'helloCodex'

export interface BootGateState {
  configLoaded: boolean
  /** null = wipe detection still running, 0 = nothing to wipe, >0 = wipe pending. */
  logsWipeBytes: number | null
  /** The harness is due: deriveOnboarding(...).due, a forced re-onboard, OR a
   *  release-notes-only run. Optional: absent === false. */
  onboardingDue?: boolean
  showTraining: boolean
  showTrainingAll: boolean
  /** The GuidedTour overlay is up. Optional: absent === false. */
  tourActive?: boolean
  /** The first-config SessionDialog is up. Optional: absent === false. */
  showGuidedConfig?: boolean
  showGitHubOnboarding: boolean
  loggingConsentSeen: boolean
  /** The one-time "Do you use Codex?" page is due (codexReconfirmDue in
   *  onboarding/codex-reconfirm-gate.ts). Optional: absent === false. */
  codexReconfirmDue?: boolean
  /** Saved sessions are waiting on a restore decision. Optional: absent === false. */
  resumePending?: boolean
  /** The Allow Multi Spawn startup page is due this launch — decided once at
   *  boot (decideMultiSpawnIntro) from meta read before anything stamped.
   *  Optional: absent === false. */
  multiSpawnIntroDue?: boolean
  /** The Codex introduction's one-time takeover is open (latched by App once
   *  it was due and nothing was in its way). Optional: absent === false. */
  helloCodexOpen?: boolean
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
  // Above the *Due short-circuit below: both are opened by a user action that
  // has already happened, so they must never be starved by a pending timer.
  if (s.tourActive) return 'guidedTour'
  // P3.12 round 2 (W9): the first-config dialog launches a session, so a
  // conversation indexing notice that is due comes first.
  if (s.showGuidedConfig) return s.loggingConsentSeen ? 'guidedConfig' : 'loggingConsent'
  if (s.showGitHubOnboarding) return 'githubOnboarding'
  if (s.whatsNewDue || s.trainingDue || s.githubOnboardingDue) return null
  if (s.codexReconfirmDue) return 'codexReconfirm'
  if (!s.loggingConsentSeen) return 'loggingConsent'
  if (s.resumePending) return 'resume'
  if (s.multiSpawnIntroDue) return 'multiSpawnIntro'
  if (s.helloCodexOpen) return 'helloCodex'
  return null
}

/**
 * App's whole boot-chain decision, in one place so it can be tested as App
 * uses it: the gate that renders now, and the two answers the Codex
 * introduction's host needs. `helloCodexGatesClear`: every gate above the
 * takeover has had its turn, the *Due waits included (would the takeover be
 * next if it were open?). `helloCodexTurn`: the takeover is open and it is
 * its turn, so it renders.
 */
export function bootChain(s: BootGateState): { gate: BootGate | null; helloCodexGatesClear: boolean; helloCodexTurn: boolean } {
  const gate = pickBootGate(s)
  return {
    gate,
    helloCodexGatesClear: pickBootGate({ ...s, helloCodexOpen: true }) === 'helloCodex',
    helloCodexTurn: gate === 'helloCodex',
  }
}

/**
 * Whether the dialogs a launch can need before it starts -- the account
 * choice (AccountLaunchGate) and the confirm for an unverified sign-in
 * (LaunchAckConfirm) -- are held back by the gate on screen. They own no
 * turn in the chain, so a gate holds them back (their queue waits, nothing
 * is answered) and they surface once it clears: a restore starts its
 * sessions the moment the resume offer is answered, and their dialogs must
 * not paint over the page after it (the Multi Spawn startup page, #607).
 * The resume offer itself does not hold them back (P3.5 VM finding V1): it
 * is not modal, the user can launch a session while it is up, and no
 * restore has started before it is answered, so a dialog then is for a
 * launch the user just made; held back, that launch showed nothing and
 * started nothing until the offer was answered.
 */
export function launchDialogsSuppressed(gate: BootGate | null): boolean {
  return gate !== null && gate !== 'resume'
}
