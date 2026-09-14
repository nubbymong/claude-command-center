/**
 * "Has this user been offered Multi Spawn for the build they are running?" —
 * the Allow Multi Spawn startup page's gate, built as a sibling of
 * `whats-new-gate.ts` and deliberately using the same mechanism.
 *
 * The marker is a VERSION STAMP, not a boolean, for the reason the What's New
 * stamp is one: a `seen: true` flag can only ever be turned on once, so the
 * surface can never be shown again, and a build that has to re-deliver
 * something has no way to say so. `multiSpawnIntroVersion` records the build
 * that showed the page; a later build has not shown it, so it shows it once.
 * Its own stamp is keyed on `__APP_VERSION__` — the version RUNNING, never
 * `changelog[0].version`, which on any build between two releases is a release
 * ahead of itself (#369).
 *
 * It is a SEPARATE stamp from `lastSeenVersion` rather than a second reader of
 * it. The two surfaces are dismissed independently — the release notes close,
 * then this page opens — so one stamp could not describe both, and a shared one
 * would mark this page seen the moment the notes were.
 *
 * Two launches never get the page:
 *   - a FRESH INSTALL. There is nothing to migrate (no configs, no sessions
 *     running from a build that had no such limit), and the feature is off by
 *     default, so the page would be a settings screen for a user who has not
 *     made a single config yet. `first-install` is asked of `decideUpgradeFlow`
 *     rather than re-derived here, so this and What's New can never disagree
 *     about which launch is somebody's first.
 *   - NO SAVED CONFIGS. An empty list is an empty page. It stamps anyway, so a
 *     user who creates their first config an hour later is not ambushed by a
 *     migration page on the next start of the same build.
 *
 * Both of those are decided from meta read at BOOT, before anything stamps —
 * by the time the harness has closed, `lastSeenVersion` says the current
 * version and a first install is indistinguishable from an upgrade.
 */

import { compareVersions } from '../../shared/version-order'
import { useAppMetaStore } from '../stores/appMetaStore'
import { decideUpgradeFlow } from './upgrade-flow'
import { runningVersion } from './whats-new-gate'

export type MultiSpawnIntroReason =
  | 'no-version'
  | 'already-seen'
  | 'fresh-install'
  | 'no-configs'
  | 'due'

export interface MultiSpawnIntroDecision {
  /** Render the page this launch. */
  show: boolean
  /** Stamp the marker WITHOUT showing anything — the silent skips. */
  markSeen: boolean
  /** Why, in a word, so a test can assert the reason and not just the outcome. */
  reason: MultiSpawnIntroReason
}

export interface MultiSpawnIntroInput {
  /** `lastSeenVersion` from app meta, read before this launch stamps anything. */
  lastSeenVersion?: string
  /** `lastRunVersionOf(meta)` — see upgrade-flow. */
  lastRunVersion?: string
  /** The build that last showed this page. Absent = never shown. */
  multiSpawnIntroVersion?: string
  /** The version now running (`__APP_VERSION__`). */
  currentVersion: string
  /** How many saved configs there are to offer. */
  configCount: number
  /** Passed through to `decideUpgradeFlow`; only its first-install arm is used. */
  channel?: string
}

export function decideMultiSpawnIntro(input: MultiSpawnIntroInput): MultiSpawnIntroDecision {
  const { lastSeenVersion, lastRunVersion, multiSpawnIntroVersion, currentVersion, channel } = input

  // No version to compare against (a test without the esbuild define, a broken
  // build): show nothing and stamp nothing rather than guess.
  if (!currentVersion) return { show: false, markSeen: false, reason: 'no-version' }

  // Compared, not string-equal, for the same reason the What's New gate is:
  // `2.1.0` and `v2.1.0` are one release, and a formatting difference must not
  // re-fire a once-per-upgrade page on every launch.
  if (multiSpawnIntroVersion && compareVersions(multiSpawnIntroVersion, currentVersion) === 0) {
    return { show: false, markSeen: false, reason: 'already-seen' }
  }

  const flow = decideUpgradeFlow({ lastSeenVersion, lastRunVersion, currentVersion, channel })
  if (flow.kind === 'first-install') return { show: false, markSeen: true, reason: 'fresh-install' }

  if (input.configCount <= 0) return { show: false, markSeen: true, reason: 'no-configs' }

  return { show: true, markSeen: false, reason: 'due' }
}

/** Record that the RUNNING build has offered the page — shown, skipped, or
 *  silently stamped. Mirrors `markWhatsNewSeen`, storage errors included. */
export function markMultiSpawnIntroSeen(): void {
  try {
    const currentVersion = runningVersion()
    if (currentVersion) {
      useAppMetaStore.getState().update({ multiSpawnIntroVersion: currentVersion })
    }
  } catch {
    // Ignore storage errors
  }
}
