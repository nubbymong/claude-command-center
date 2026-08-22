/**
 * What a launch should SHOW the user, decided once, from two facts: the version
 * they last saw and the version they are now running.
 *
 * The rule this replaces was `lastSeen !== changelog[0].version`. It could not
 * tell a fresh install from an upgrade (both "show it"), it fired on every beta
 * bump with equal weight, and — because it only ever looked at `changelog[0]` —
 * someone upgrading from 2.0.0 straight to 2.1.0 was shown the newest entry
 * only, as though the fourteen releases in between had not happened.
 *
 * Three outcomes, and which one you get depends on how far you moved:
 *
 *   fresh install      no stored version   → the tour, and no "what's new",
 *                                            because nothing is new to you
 *   crossed a line     2.0.x → 2.1.x       → what's new since 2.0, AND the tour
 *                                            again: a new line is worth walking
 *   moved within one   2.1.0-b13 → -b14    → what's new only
 *
 * Everything here is pure so the decision can be tested directly rather than by
 * driving the app. The caller supplies the changelog, so a test can construct a
 * version history without depending on the real one.
 */

import { compareVersions, crossedReleaseLine } from '../../shared/version-order'

export interface VersionedEntry {
  version: string
}

export interface UpgradeFlowInput {
  /** `lastSeenVersion` from app meta. Absent on a first install. */
  lastSeenVersion?: string
  /**
   * The version that last actually RAN on this machine — `lastRunVersionOf(meta)`.
   * The witness against a "seen" stamp that the build it names never wrote
   * (#369): a stamp NEWER than any build that has run cannot mean the user saw
   * those notes, so it does not count as seen. Absent means no record, and the
   * stamp is trusted as it always was.
   */
  lastRunVersion?: string
  /** The version now running (`__APP_VERSION__`, i.e. this build). */
  currentVersion: string
  /** 'beta' testers re-walk the tour on every version; see `showTour`. */
  channel?: string
}

/**
 * The last build that actually ran, as well as the stored meta can say.
 *
 * `lastRunVersion` is stamped with `__APP_VERSION__` at every boot (App.tsx,
 * after the launch decision has read the previous value). It did not exist
 * before the #369 fix, so a meta written by an older build falls back to
 * `setupVersion`, which every build since 1.x has stamped with its own version
 * on its first launch — the only pre-existing record of a build having run,
 * and never ahead, because it too is keyed on `__APP_VERSION__`.
 */
export function lastRunVersionOf(meta: { lastRunVersion?: string; setupVersion?: string }): string | undefined {
  return meta.lastRunVersion ?? meta.setupVersion
}

/**
 * The version the user can actually have SEEN the notes for: the stamp,
 * clamped to the last build that ran.
 *
 * This is the #369 repair in one line. Until beta.16 the dismissal stamped the
 * changelog HEAD, which on any build between two releases is one release ahead
 * of the build running — so the owner's machine reached the real beta.16
 * already holding `lastSeenVersion = beta.16`, written by a beta.15 build, and
 * the gate read "same version" and showed nothing. No build of beta.16 had run
 * (`setupVersion` still said beta.15), so the stamp could not be true; a stamp
 * newer than the last run is read as the last run instead.
 *
 * Anything that asks "what has this user seen?" — the launch decision, and the
 * harness working out which pages are new since — goes through this, so the
 * two never disagree.
 */
export function seenVersionFor(input: { lastSeenVersion?: string; lastRunVersion?: string }): string | undefined {
  const { lastSeenVersion, lastRunVersion } = input
  if (!lastSeenVersion || !lastRunVersion) return lastSeenVersion
  return compareVersions(lastSeenVersion, lastRunVersion) > 0 ? lastRunVersion : lastSeenVersion
}

export interface UpgradeFlowDecision {
  kind: 'first-install' | 'upgrade' | 'nothing'
  /** Show the What's New surface. Never true on a first install. */
  showWhatsNew: boolean
  /** Run the full-screen tour. True on a first install, on a crossed release
   *  line, and for beta testers on any version change. */
  showTour: boolean
  /** Why, in a word — for logging and for tests that assert the REASON rather
   *  than just the outcome, so a right answer for a wrong reason still fails. */
  reason: 'no-stored-version' | 'same-version' | 'stamped-ahead' | 'crossed-line' | 'beta-channel' | 'within-line'
}

export function decideUpgradeFlow(input: UpgradeFlowInput): UpgradeFlowDecision {
  const { lastSeenVersion, currentVersion, channel } = input

  if (!lastSeenVersion) {
    // Nothing is "new" to someone who has never run it. They get the tour.
    // A record of an earlier RUN does not change that: no stamp means the tour
    // never finished, and the tour is what that user is owed.
    return { kind: 'first-install', showWhatsNew: false, showTour: true, reason: 'no-stored-version' }
  }

  // Equality by COMPARISON, not by string: `2.1.0` and `v2.1.0` are the same
  // release, and a stored version that differs only in formatting must not
  // re-fire the modal on every launch.
  if (compareVersions(lastSeenVersion, currentVersion) === 0) {
    // ...unless the stamp is newer than any build that has actually run. Then
    // it was written by an OLDER build naming a version it had not shipped —
    // the beta.15 → beta.16 incident behind #369 — and the user has not seen
    // these notes at all. Show them, once; the acknowledgement re-stamps from
    // the running build and the next launch reads `same-version` honestly.
    const seen = seenVersionFor(input)
    if (seen === lastSeenVersion) {
      return { kind: 'nothing', showWhatsNew: false, showTour: false, reason: 'same-version' }
    }
    return { kind: 'upgrade', showWhatsNew: true, showTour: false, reason: 'stamped-ahead' }
  }

  // Deliberately not gated on moving FORWARD. A downgrade — a tester dropping
  // back a build, an installer rollback — still changed what they are running,
  // and showing them the notes for it beats showing nothing.
  if (crossedReleaseLine(lastSeenVersion, currentVersion)) {
    return { kind: 'upgrade', showWhatsNew: true, showTour: true, reason: 'crossed-line' }
  }

  if (channel === 'beta') {
    return { kind: 'upgrade', showWhatsNew: true, showTour: true, reason: 'beta-channel' }
  }

  return { kind: 'upgrade', showWhatsNew: true, showTour: false, reason: 'within-line' }
}

/**
 * Which boot surface shows the release notes on THIS launch.
 *
 * ONE surface: the full-screen harness. There is no modal arm any more (user
 * call 2026-08-21 — "the full app window IS the delivery for what's new on
 * updated installs and for the first run tour"). The old `'modal'` arm was
 * what actually shipped: on any build whose changelog head sits ahead of its
 * own version — which is EVERY dev and preview build, because the pending
 * entry is written before the bump — the launch read as a within-line upgrade,
 * so `showTour` was false and the wall-of-text modal opened instead of the
 * page. Removing the arm removes the whole class.
 *
 * The two callers-supplied facts are unchanged: is the harness about to run
 * anyway (re-fired for this version, or deriveOnboarding says steps are due),
 * and would What's New show at all. Either one now opens the same surface —
 * whats-new-due ALONE runs the harness in its what's-new-only mode rather than
 * re-walking a flow the user has already completed.
 */
export function bootWhatsNewSurface(input: {
  tourWillRun: boolean
  whatsNewDue: boolean
}): 'tour' | 'none' {
  return input.tourWillRun || input.whatsNewDue ? 'tour' : 'none'
}

/**
 * The changelog entries a user has not seen: everything newer than
 * `lastSeenVersion`, up to and including `currentVersion`, newest first.
 *
 * FILTERED by comparison rather than sliced by index, and that is not a
 * stylistic choice. The changelog array is ordered by release DATE, and the two
 * orderings disagree: `2.0.0` shipped on 2 July and sits BELOW `2.0.0-beta.5`
 * (7 July) and `2.0.0-rc.2` (15 July) in the array, while semver puts it above
 * all three. Slicing `(indexOf(lastSeen), 0]` would hand a user on 2.0.0 stable
 * the release notes for its own prereleases.
 *
 * With no `lastSeenVersion` this returns nothing: a first install has no
 * backlog to catch up on.
 */
export function entriesSince<T extends VersionedEntry>(
  entries: readonly T[],
  lastSeenVersion: string | undefined,
  currentVersion: string,
): T[] {
  if (!lastSeenVersion) return []
  return entries
    .filter(
      (e) =>
        compareVersions(e.version, lastSeenVersion) > 0 && compareVersions(e.version, currentVersion) <= 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
}
