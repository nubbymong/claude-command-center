import type { UpdateChannel } from '../stores/settingsStore'

// "current installed version + channel" label for the update UI -- the Settings
// Check-for-Updates field and the BottomBar update-pill tooltip (#250). Pure so
// it can be unit-tested without a renderer; callers pass the build-time
// __APP_VERSION__ (full tag, incl. any prerelease suffix) and the reactive
// settings.updateChannel.
export function formatInstalledVersion(version: string, channel: UpdateChannel): string {
  return `v${version} (${channel})`
}

/**
 * The release LINE a version belongs to: `2.1.0-beta.9` -> `2.1`.
 *
 * The upgrade-cohort onboarding page hard-coded "2.0", so every 2.1 beta
 * greeted testers with "What's new in 2.0". Deriving it from the build-time
 * __APP_VERSION__ means it cannot go stale again. Falls back to the input when
 * it does not parse, so a malformed define degrades to something harmless
 * rather than throwing during first-run.
 */
export function releaseLine(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(String(version || '').trim())
  return m ? `${m[1]}.${m[2]}` : String(version || '')
}

/**
 * Does this build carry a prerelease suffix -- `2.1.0-beta.10`, `2.2.0-rc.1`?
 *
 * Anything that does not parse as semver (an empty/absent __APP_VERSION__ in a
 * test or dev context) is treated as NOT a prerelease, so the caller's default
 * stays the conservative one.
 */
export function isPrereleaseVersion(version: string): boolean {
  const m = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(String(version || '').trim())
  return !!m && !!m[1]
}

/**
 * The update channel a build should arrive on.
 *
 * `updateChannel` defaults to 'stable', so someone who deliberately installed a
 * beta build received no further betas and got no signal about it (the beta
 * re-onboarding gate reads the same value, so that was dead for them too). The
 * onboarding Transparency recap pre-selects this and lets the user override it.
 */
export function defaultUpdateChannelForVersion(version: string): UpdateChannel {
  return isPrereleaseVersion(version) ? 'beta' : 'stable'
}
