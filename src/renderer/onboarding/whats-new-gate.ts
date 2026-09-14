/**
 * "Has this user seen the notes for the build they are running?" — the two
 * store-reading wrappers around the pure `decideUpgradeFlow`.
 *
 * They used to live in `WhatsNewModal.tsx`, which made `settle.ts` import a
 * React component to stamp a version. They also compared against
 * `changelog[0].version` — the newest entry AUTHORED — and that was the bug
 * behind the wall-of-text report on 2026-08-21:
 *
 *   The pending changelog entry is written BEFORE the version bump, by design
 *   (AGENTS.md: the accumulator entry is edited, not added, when a beta is
 *   cut). So on every dev build, every preview build, and every build between
 *   two releases, `changelog[0].version` is AHEAD of the version actually
 *   running. `decideUpgradeFlow` therefore saw lastSeen(beta.15) vs
 *   current(beta.16) — a within-line upgrade — on a machine running beta.15,
 *   and `markWhatsNewSeen` then stamped `lastSeenVersion = beta.16`, a version
 *   the user had never run. The real beta.16 would then have read
 *   `same-version` and shown nothing at all.
 *
 * The version a user has "seen" is the version they RAN. Both functions are
 * keyed on `__APP_VERSION__` for that reason, and the changelog is left to do
 * the one job it is good for: supplying the entries themselves.
 *
 * That prediction came true (#369). The owner's machine had run exactly such a
 * build on 2026-08-21 and held `lastSeenVersion = beta.16` when the real
 * beta.16 was installed from the offline .exe; the gate read `same-version`
 * and the page never appeared. Stamping the running version stopped NEW bad
 * stamps being written but did nothing about the one already on disk — the
 * beta.16 changelog's "corrects itself on the next launch" was true only for a
 * stamp two or more releases ahead, and the stamp that actually gets written
 * is always exactly one ahead. So the stamp is no longer trusted on its own:
 * it is read against the last build that actually RAN (`lastRunVersionOf`),
 * and a stamp newer than that is a stamp no build of that version wrote. See
 * `seenVersionFor` in upgrade-flow.ts.
 */

import { useAppMetaStore } from '../stores/appMetaStore'
import { useSettingsStore } from '../stores/settingsStore'
import { decideUpgradeFlow, lastRunVersionOf, seenVersionFor } from './upgrade-flow'

declare const __APP_VERSION__: string

/**
 * The version this build IS. Guarded rather than read directly: the esbuild
 * `define` is absent in any unit test that has not stubbed it, and an
 * undefined global here would throw inside a boot path.
 */
export function runningVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

/** Should this launch show the release notes? */
export function shouldShowWhatsNew(): boolean {
  try {
    const currentVersion = runningVersion()
    if (!currentVersion) return false
    const meta = useAppMetaStore.getState().meta
    return decideUpgradeFlow({
      lastSeenVersion: meta.lastSeenVersion,
      lastRunVersion: lastRunVersionOf(meta),
      currentVersion,
      channel: useSettingsStore.getState().settings.updateChannel,
    }).showWhatsNew
  } catch {
    return false
  }
}

/**
 * The version this user has actually seen the notes for — the stored stamp,
 * clamped to the last build that ran (#369). What the harness diffs against
 * when it works out which pages are new since, so it and `shouldShowWhatsNew`
 * agree on where the user is coming from.
 */
export function seenVersion(): string | undefined {
  try {
    const meta = useAppMetaStore.getState().meta
    return seenVersionFor({ lastSeenVersion: meta.lastSeenVersion, lastRunVersion: lastRunVersionOf(meta) })
  } catch {
    return undefined
  }
}

/** Record that the notes for the RUNNING build have been shown. */
export function markWhatsNewSeen(): void {
  try {
    const currentVersion = runningVersion()
    if (currentVersion) {
      useAppMetaStore.getState().update({ lastSeenVersion: currentVersion })
    }
  } catch {
    // Ignore storage errors
  }
}
