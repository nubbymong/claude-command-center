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
  /** The version now running (changelog head, i.e. this build). */
  currentVersion: string
  /** 'beta' testers re-walk the tour on every version; see `showTour`. */
  channel?: string
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
  reason: 'no-stored-version' | 'same-version' | 'crossed-line' | 'beta-channel' | 'within-line'
}

export function decideUpgradeFlow(input: UpgradeFlowInput): UpgradeFlowDecision {
  const { lastSeenVersion, currentVersion, channel } = input

  if (!lastSeenVersion) {
    // Nothing is "new" to someone who has never run it. They get the tour.
    return { kind: 'first-install', showWhatsNew: false, showTour: true, reason: 'no-stored-version' }
  }

  // Equality by COMPARISON, not by string: `2.1.0` and `v2.1.0` are the same
  // release, and a stored version that differs only in formatting must not
  // re-fire the modal on every launch.
  if (compareVersions(lastSeenVersion, currentVersion) === 0) {
    return { kind: 'nothing', showWhatsNew: false, showTour: false, reason: 'same-version' }
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
